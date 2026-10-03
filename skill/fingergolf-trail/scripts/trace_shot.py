#!/usr/bin/env python3
"""One-shot pipeline: ball at address -> strike -> flight -> points file.

Chains the steps that were being run by hand for every clip: pin the strike
from the ball's rest position, sweep the frames after it for the ball, pick the
longest ballistic run, then track it forwards and backwards and merge the whole
lot with the impact point anchored at the ball's measured rest position.

It prints where every point came from so a bad clip can be diagnosed without
re-running the stages separately.
"""

import argparse
import json
import math
import os
import subprocess
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))


def stream(path, lo=0, hi=None):
    cap = cv2.VideoCapture(path)
    idx = 0
    while True:
        ok, f = cap.read()
        if not ok:
            break
        if idx >= lo and (hi is None or idx <= hi):
            yield idx, f
        idx += 1
        if hi is not None and idx > hi:
            break
    cap.release()


def gray_of(f):
    return cv2.GaussianBlur(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY), (5, 5), 0)


def find_strike(path, x, y, R, present=0.75):
    """Score the ball's rest patch in every frame; it collapses when struck."""
    patches = []
    for _, f in stream(path):
        patches.append(f[max(0, y - R):y + R, max(0, x - R):x + R].copy())
    if not patches:
        return None, 0, 0
    tmpl = patches[0]
    scores = []
    for p in patches:
        if p.shape != tmpl.shape or p.size == 0:
            scores.append(0.0)
        else:
            scores.append(float(cv2.matchTemplate(
                p, tmpl, cv2.TM_CCOEFF_NORMED).max()))
    ok = np.array(scores) > present
    best_len, best_end, cur = 0, None, 0
    for i, b in enumerate(ok):
        cur = cur + 1 if b else 0
        if cur > best_len:
            best_len, best_end = cur, i
    return best_end, best_len, len(patches)


def sweep(path, lo, hi, diff=20, min_area=25, max_area=9000, bright=100):
    """Ball-like bright blobs per frame, differenced against the background."""
    samp, keep = [], {}
    for idx, f in stream(path):
        g = gray_of(f)
        if idx % 4 == 0:
            samp.append(g)
        if lo <= idx <= hi:
            keep[idx] = (f, g)
    if not samp or not keep:
        return {}
    bg = np.median(np.stack(samp), axis=0).astype(np.uint8)
    kern = np.ones((3, 3), np.uint8)
    out = {}
    for i in sorted(keep):
        f, g = keep[i]
        d = cv2.absdiff(g, bg)
        _, m = cv2.threshold(d, diff, 255, cv2.THRESH_BINARY)
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, kern)
        n, _, st, ce = cv2.connectedComponentsWithStats(m, 8)
        cands = []
        for k in range(1, n):
            a = st[k, cv2.CC_STAT_AREA]
            w, h = st[k, cv2.CC_STAT_WIDTH], st[k, cv2.CC_STAT_HEIGHT]
            if not (min_area < a < max_area):
                continue
            if not (0.35 < w / max(h, 1) < 3.0):
                continue
            x0, y0 = st[k, cv2.CC_STAT_LEFT], st[k, cv2.CC_STAT_TOP]
            patch = f[y0:y0 + h, x0:x0 + w].reshape(-1, 3)
            if patch.size == 0:
                continue
            b = float(patch.mean(axis=0).min())
            if b < bright:
                continue
            cands.append((float(ce[k][0]), float(ce[k][1]), float(a), b))
        if cands:
            out[i] = cands
    return out


def best_run(blobs, max_gap=4, max_step=420, min_len=5):
    """Longest chain of blobs that moves smoothly frame to frame."""
    frames = sorted(blobs)
    best, best_score = [], -1.0
    for si, sf in enumerate(frames):
        for s0 in blobs[sf]:
            chain = [(sf, s0[0], s0[1])]
            last_f, last = sf, (s0[0], s0[1])
            vx = vy = None
            for f in frames[si + 1:]:
                gap = f - last_f
                if gap > max_gap:
                    break
                if vx is None:
                    px, py = last
                    tol = max_step
                else:
                    px, py = last[0] + vx * gap, last[1] + vy * gap
                    tol = max(60.0, 0.9 * math.hypot(vx, vy) * gap)
                pick, pd = None, None
                for c in blobs[f]:
                    d = math.hypot(c[0] - px, c[1] - py)
                    if d <= tol and (pd is None or d < pd):
                        pick, pd = c, d
                if pick is None:
                    continue
                nvx = (pick[0] - last[0]) / gap
                nvy = (pick[1] - last[1]) / gap
                vx, vy = nvx, nvy
                chain.append((f, pick[0], pick[1]))
                last_f, last = f, (pick[0], pick[1])
            if len(chain) < min_len:
                continue
            travel = sum(math.hypot(chain[i + 1][1] - chain[i][1],
                                    chain[i + 1][2] - chain[i][2])
                         for i in range(len(chain) - 1))
            score = travel + len(chain) * 6
            if score > best_score:
                best, best_score = chain, score
    return best


def trim_tail(pts):
    """Cut the track where the ball stops, not where tracking stops.

    After the ball lands it bounces, settles and sits still, and a matcher will
    happily hold position on it — or drift onto whatever background is nearby —
    for the rest of the clip. Those frames add a wandering tail to the trail
    that reads as a tracking error even when it isn't one.

    The apex is also slow, so speed alone is not enough to tell "stopped" from
    "slowest point of the arc". Scan from the end instead and drop the trailing
    frames whose remaining travel never recovers: a ball at its apex still has
    the whole descent left to cover, a landed ball has nothing.
    """
    if len(pts) < 6:
        return pts
    fs = sorted(pts)
    xy = [pts[f] for f in fs]
    steps = [math.hypot(xy[i + 1][0] - xy[i][0], xy[i + 1][1] - xy[i][1])
             for i in range(len(xy) - 1)]
    med = float(np.median(steps)) if steps else 0.0
    if med <= 0:
        return pts
    cut = len(fs) - 1
    for i in range(len(fs) - 1, 0, -1):
        remaining = sum(steps[i - 1:])
        if remaining > med * 2.5:
            cut = i
            break
    return {f: pts[f] for f in fs[:cut + 1]}


def run_track(video, at, x, y, radius, out, backward=False, window=200,
              match=0.3, maxf=120):
    cmd = [sys.executable, os.path.join(HERE, "track_from.py"), video,
           "--at", str(at), "--from", f"{x},{y}", "--radius", str(radius),
           "--window", str(window), "--min-match", str(match),
           "--adapt-match", "0.55", "--max-frames", str(maxf), "--out", out]
    if backward:
        cmd.append("--backward")
    r = subprocess.run(cmd, capture_output=True, text=True)
    try:
        return json.loads(r.stdout)
    except Exception:
        return {"ok": False}


def load(fn):
    d = {}
    try:
        for ln in open(fn):
            t = ln.strip()
            if not t or t.startswith("#"):
                continue
            fr, xy = t.split(":")
            a, b = xy.split(",")
            d[int(fr)] = (float(a), float(b))
    except Exception:
        pass
    return d


def main():
    p = argparse.ArgumentParser()
    p.add_argument("video")
    p.add_argument("--ball", required=True, help="'x,y' of the ball at address")
    p.add_argument("--radius", type=int, default=28)
    p.add_argument("--out", required=True)
    p.add_argument("--diff", type=int, default=20)
    p.add_argument("--bright", type=float, default=100)
    p.add_argument("--min-area", type=float, default=25)
    p.add_argument("--after", type=int, default=70,
                   help="Frames after the strike to sweep.")
    p.add_argument("--track-radius", type=int, default=20)
    args = p.parse_args()

    bx, by = (int(float(v)) for v in args.ball.split(","))
    strike, run_len, total = find_strike(args.video, bx, by, args.radius)
    if strike is None:
        print(json.dumps({"ok": False, "reason": "no rest run found"}))
        sys.exit(2)
    note = None
    if run_len < 10:
        note = "short rest run — the position may not be the ball"
    if strike >= total - 3:
        print(json.dumps({"ok": False, "strike_frame": strike,
                          "reason": "ball never leaves — no strike in clip"}))
        sys.exit(3)

    blobs = sweep(args.video, strike + 1, strike + args.after,
                  diff=args.diff, min_area=args.min_area, bright=args.bright)
    chain = best_run(blobs)
    if len(chain) < 5:
        print(json.dumps({"ok": False, "strike_frame": strike,
                          "reason": "no flight blobs after strike",
                          "note": note}))
        sys.exit(4)

    seed_f, seed_x, seed_y = chain[len(chain) // 3]
    fwd = "/tmp/_fwd.txt"
    bck = "/tmp/_bck.txt"
    run_track(args.video, seed_f, seed_x, seed_y, args.track_radius, fwd)
    run_track(args.video, seed_f, seed_x, seed_y, args.track_radius, bck,
              backward=True, window=240, match=0.26, maxf=30)

    merged = {}
    for f, x, y in chain:
        merged[f] = (x, y)
    merged.update(load(bck))
    merged.update(load(fwd))
    merged[strike] = (float(bx), float(by))
    n_raw = len(merged)
    merged = trim_tail(merged)

    lines = [f"# {os.path.basename(args.video)} — strike {strike}"]
    lines += [f"{k}:{round(v[0])},{round(v[1])}" for k, v in sorted(merged.items())]
    with open(args.out, "w") as fh:
        fh.write("\n".join(lines) + "\n")

    print(json.dumps({"ok": True, "strike_frame": strike,
                      "rest_run": run_len,
                      "sweep_blobs": len(blobs),
                      "chain": len(chain),
                      "points": len(merged),
                      "tail_trimmed": n_raw - len(merged),
                      "first_frame": min(merged), "last_frame": max(merged),
                      "note": note,
                      "out": os.path.abspath(args.out)}, indent=1))


if __name__ == "__main__":
    main()
