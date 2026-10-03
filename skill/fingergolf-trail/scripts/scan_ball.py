#!/usr/bin/env python3
"""Scan a whole clip for a ball in flight, without needing it to sit still.

find_ball.py starts from the ball at rest and watches for it to vanish. That is
the most reliable route when it applies, but it does not always apply: filmed
from behind the hole the ball never rests in view at all, and in a long clip the
player may nudge it around so it never settles.

This takes the slower, more general route. Every frame is differenced against
the background, ball-sized bright blobs are kept, and overlapping windows are
searched for a chain that fits a parabola with downward acceleration. That fit
is the whole test — a chain that creeps along a shoulder or a shadow scores well
on length and distance but cannot fake gravity.

Because nothing calibrates it to the ball at rest, the size and brightness
limits here are generic. Expect to adjust --min-area / --max-area / --bright
for an unusual room.
"""

import argparse
import glob
import json
import math
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import find_ball2 as fb  # noqa: E402


def main():
    p = argparse.ArgumentParser()
    p.add_argument("video")
    p.add_argument("--out", default="ball.txt")
    p.add_argument("--preview", default="scan_preview.png")
    p.add_argument("--samples", type=int, default=60)
    p.add_argument("--diff", type=int, default=22)
    p.add_argument("--min-area", type=float, default=55)
    p.add_argument("--max-area", type=float, default=2200)
    p.add_argument("--bright", type=float, default=120)
    p.add_argument("--peaks", type=int, default=8)
    p.add_argument("--window", type=int, default=140)
    p.add_argument("--step", type=int, default=70)
    # chain parameters, same meaning as in find_ball2
    p.add_argument("--seed-window", type=int, default=40)
    p.add_argument("--seed-span", type=int, default=6)
    p.add_argument("--min-step", type=float, default=3.0)
    p.add_argument("--max-step", type=float, default=160.0)
    p.add_argument("--min-tol", type=float, default=18.0)
    p.add_argument("--max-tol", type=float, default=110.0)
    p.add_argument("--tol-ratio", type=float, default=0.6)
    p.add_argument("--max-gap", type=int, default=5)
    p.add_argument("--min-points", type=int, default=8)
    p.add_argument("--min-travel", type=float, default=150.0)
    p.add_argument("--min-median-step", type=float, default=4.0)
    p.add_argument("--min-accel", type=float, default=0.15)
    p.add_argument("--max-accel", type=float, default=14.0)
    p.add_argument("--max-rms", type=float, default=6.0)
    args = p.parse_args()

    fps, n, W, H = fb.meta(args.video)
    want = set(np.linspace(0, max(0, n - 1),
                           min(max(n, 1), args.samples)).astype(int).tolist())
    samples = []
    for idx, f in fb.stream(args.video):
        if idx in want:
            samples.append(fb.gray_of(f))
    bg = np.median(np.stack(samples), axis=0).astype(np.uint8)
    del samples

    kernel = np.ones((3, 3), np.uint8)
    per_frame = []
    for idx, f in fb.stream(args.video):
        d = cv2.absdiff(fb.gray_of(f), bg)
        _, m = cv2.threshold(d, args.diff, 255, cv2.THRESH_BINARY)
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, kernel)
        nc, _, st, ce = cv2.connectedComponentsWithStats(m, 8)
        cands = []
        for k in range(1, nc):
            a = st[k, cv2.CC_STAT_AREA]
            w, h = st[k, cv2.CC_STAT_WIDTH], st[k, cv2.CC_STAT_HEIGHT]
            if not (args.min_area < a < args.max_area):
                continue
            if not (0.4 < w / max(h, 1) < 2.5):
                continue
            x0, y0 = st[k, cv2.CC_STAT_LEFT], st[k, cv2.CC_STAT_TOP]
            patch = f[y0:y0 + h, x0:x0 + w].reshape(-1, 3)
            if patch.size == 0:
                continue
            bright = float(patch.mean(axis=0).min())
            if bright < args.bright:
                continue
            cands.append((float(ce[k][0]), float(ce[k][1]),
                          (a / float(max(1, w * h))) * bright))
        cands.sort(key=lambda c: -c[2])
        per_frame.append(cands[:args.peaks])

    best, best_score, best_off = None, -1e18, 0
    for start in range(0, max(1, len(per_frame) - 10), args.step):
        win = per_frame[start:start + args.window]
        if len(win) < args.min_points + 2:
            continue
        chain = fb.best_chain(win, args)
        if not chain:
            continue
        chain = fb.extend_back(win, chain, args)
        accel, rms = fb.ballistic_fit(chain)
        travel = sum(math.hypot(chain[j + 1][1][0] - chain[j][1][0],
                                chain[j + 1][1][1] - chain[j][1][1])
                     for j in range(len(chain) - 1))
        score = travel + len(chain) * 4 - rms * 8
        if score > best_score:
            best, best_score, best_off = chain, score, start

    if not best:
        print(json.dumps({"ok": False,
                          "reason": "No ballistic chain anywhere in the clip. "
                                    "Try --diff 18 --bright 100 or widen "
                                    "--min-area / --max-area."}))
        sys.exit(2)

    pts = [(best_off + i, x, y) for i, (x, y, _) in best]
    accel, rms = fb.ballistic_fit(best)
    lines = [f"# {os.path.basename(args.video)} — scanned, "
             f"accel {accel:.2f}px/f^2, rms {rms:.1f}px"]
    lines += [f"{f}:{round(x)},{round(y)}" for f, x, y in pts]
    with open(args.out, "w") as fh:
        fh.write("\n".join(lines) + "\n")

    cap = cv2.VideoCapture(args.video)
    cap.set(cv2.CAP_PROP_POS_FRAMES, pts[-1][0])
    ok, last = cap.read()
    cap.release()
    if ok:
        cv2.polylines(last, [np.array([[int(x), int(y)] for _, x, y in pts],
                                      np.int32)], False, (0, 255, 255), 5)
        cv2.circle(last, (int(pts[0][1]), int(pts[0][2])), 18, (0, 0, 255), 4)
        cv2.imwrite(args.preview, cv2.resize(last, (760, int(760 * H / W))))

    print(json.dumps({"ok": True, "points": len(pts),
                      "first_frame": pts[0][0], "last_frame": pts[-1][0],
                      "accel_px_per_frame2": round(accel, 2),
                      "fit_rms_px": round(rms, 1),
                      "out": os.path.abspath(args.out),
                      "preview": os.path.abspath(args.preview)}, indent=1))


if __name__ == "__main__":
    main()
