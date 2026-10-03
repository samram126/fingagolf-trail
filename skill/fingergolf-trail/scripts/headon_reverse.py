#!/usr/bin/env python3
"""Track a head-on shot (hit toward the camera) by running the clip backwards.

Shot toward the camera, the ball starts as a few pixels next to a distant
player and ends big, sharp and still on the green in front of the lens. Forward
tracking has to find a speck at address and gets out-voted by the player. In
reverse the ball is the biggest moving thing in the frame from the start, so
the landing is easy to lock onto and the track only has to follow it as it
shrinks back to the tee.

Steps:
  1. reverse the clip with ffmpeg (lossless-ish, CRF 8),
  2. collect ball candidates with blob merging (a ball close to the camera
     smears into a streak that consecutive-frame differencing splits in two)
     and a high size cap (the ball can cover 10,000 px near the lens),
  3. find the landing: the longest chain of candidates RISING up the frame in
     reversed time (= the real descent), and seed the walk at its start,
  4. link greedily (link_flight.py) from the landing over the apex toward the
     tee,
  5. cut the walk where it reaches the tee (the first big jump or stall after
     the apex), and map frames back: real = N - 1 - reversed, where N is the
     DECODED frame count of the original (container headers lie, and ffmpeg's
     reverse can add a duplicate frame at the end).

Always zoom-verify the result (the tee end especially): pass --tee X,Y once
you've found the ball at address to anchor the impact there.
"""

import argparse
import ast
import json
import math
import os
import subprocess
import sys

import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from find_flight import candidates  # noqa: E402


def decoded_count(path):
    cap = cv2.VideoCapture(path)
    n = 0
    while cap.grab():
        n += 1
    cap.release()
    return n


def rising_chain(C, minrise=10):
    best = None
    for f0 in sorted(C):
        for c0 in C[f0]:
            ch = [(f0, c0[0], c0[1])]
            while True:
                lf, lx, ly = ch[-1]
                nxt = None
                for g in (1, 2):
                    for c in C.get(lf + g, []):
                        dy = (ly - c[1]) / g
                        dx = abs(c[0] - lx) / g
                        if minrise <= dy <= 150 and dx <= 0.8 * dy + 15:
                            if nxt is None or c[2] > nxt[3]:
                                nxt = (lf + g, c[0], c[1], c[2])
                    if nxt:
                        break
                if not nxt:
                    break
                ch.append(nxt[:3])
            rise = ch[0][2] - ch[-1][2]
            if best is None or rise > best[0]:
                best = (rise, ch)
    return best[1] if best else None


def cut_at_tee(pts):
    """Keep landing -> apex -> descent; stop at the first jump/stall after it."""
    ap = min(range(len(pts)), key=lambda i: pts[i][2])
    keep = pts[:ap + 1]
    steps = []
    for k in range(ap + 1, len(pts)):
        f0, x0, y0 = keep[-1]
        f1, x1, y1 = pts[k]
        g = f1 - f0
        step = math.hypot(x1 - x0, y1 - y0) / max(1, g)
        med = sorted(steps)[len(steps) // 2] if steps else step
        # the ball still descending (reversed time) at a steady pace
        if y1 < y0 - 2 or g > 4 or (steps and step > 3 * med + 15):
            break
        steps.append(step)
        keep.append(pts[k])
    return keep


def main():
    p = argparse.ArgumentParser()
    p.add_argument("video")
    p.add_argument("--out", required=True, help="frame:x,y file (real time)")
    p.add_argument("--tee", default=None, help="'x,y' of the ball at address")
    p.add_argument("--workdir", default=".")
    args = p.parse_args()

    base = os.path.splitext(os.path.basename(args.video))[0]
    rev = os.path.join(args.workdir, f"rev_{base}.mp4")
    if not os.path.exists(rev):
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", args.video,
                        "-vf", "reverse", "-an", "-c:v", "libx264", "-crf", "8",
                        "-preset", "veryfast", rev], check=True)
    n_rev = decoded_count(rev)
    n = decoded_count(args.video)
    C = candidates(rev, 3, n_rev - 4, 10, 8, 20000, body_area=80000,
                   max_per_frame=12, merge_px=31)
    ch = rising_chain(C)
    if not ch or len(ch) < 4:
        print(json.dumps({"ok": False, "reason": "no landing found"}))
        sys.exit(3)
    # Seed on the 2nd/3rd chain points: the first step off the landing is
    # often a short hop, and a slow seed velocity makes the gate too tight
    # for the fast climb that follows. The touchdown point is added back.
    seed = ";".join(f"{f}:{round(x)},{round(y)}" for f, x, y in ch[1:3])
    lout = os.path.join(args.workdir, f"revlink_{base}.txt")
    subprocess.run([sys.executable, os.path.join(HERE, "link_flight.py"), rev,
                    "--ball", f"{round(ch[0][1])},{round(ch[0][2])}",
                    "--strike", str(ch[1][0] - 1), "--seed", seed,
                    "--max-area", "20000", "--body-area", "80000",
                    "--merge", "31", "--after", "140", "--out", lout],
                   check=True, stdout=subprocess.DEVNULL)
    pts = []
    for ln in open(lout):
        if ln.startswith("#") or not ln.strip():
            continue
        a, b = ln.strip().split(":")
        x, y = b.split(",")
        pts.append((int(a), float(x), float(y)))
    if pts[0][0] > ch[0][0]:
        pts.insert(0, ch[0])
    pts = cut_at_tee(pts)
    if args.tee:
        tx, ty = (float(v) for v in args.tee.split(","))
        pts.append((pts[-1][0] + 1, tx, ty))
    fwd = sorted((n - 1 - f, x, y) for f, x, y in pts)
    with open(args.out, "w") as fh:
        fh.write(f"# {base} head-on, tracked reversed; strike {fwd[0][0]}\n")
        fh.write("\n".join(f"{f}:{round(x)},{round(y)}" for f, x, y in fwd))
        fh.write("\n")
    print(json.dumps({"ok": True, "frames": n, "strike": fwd[0][0],
                      "landing": fwd[-1][0], "points": len(fwd),
                      "out": os.path.abspath(args.out)}, indent=1))


if __name__ == "__main__":
    main()
