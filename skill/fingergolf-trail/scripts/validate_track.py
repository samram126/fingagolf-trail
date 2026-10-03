#!/usr/bin/env python3
"""Check every tracked point against the picture and cut where it goes wrong.

Tracks fail in a characteristic way: correct while the ball is in flight, then
wandering once it lands, leaves frame or passes something that matches better.
The wandering part looks plausible on a whole-frame path drawing, which is why
it keeps reaching the render — the only reliable check is to crop in on each
point and ask whether a ball is there.

That check is mechanical, so do it mechanically. At each tracked point, score
the patch for the two things that make a ball a ball here: it is brighter than
its immediate surroundings, and it is a compact blob rather than an edge. Both
are measured relative to the point's own neighbourhood, so it works against
carpet, a green mat, a ceiling or a shirt without per-clip thresholds.

Cut at the first sustained run of failures rather than the first single one —
one dim frame mid-flight (passing a shadow, or motion blur) is normal, a run of
them means the track has left the ball.
"""

import argparse
import json
import os
import sys

import cv2
import numpy as np


def ball_score(frame, x, y, r):
    """How ball-like the patch at (x, y) is: 0 = nothing there, 1 = strong."""
    h, w = frame.shape[:2]
    x, y = int(round(x)), int(round(y))
    pad = r * 3
    x0, x1 = max(0, x - pad), min(w, x + pad)
    y0, y1 = max(0, y - pad), min(h, y + pad)
    if x1 - x0 < 2 * r or y1 - y0 < 2 * r:
        return 0.0
    region = cv2.cvtColor(frame[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY).astype(float)
    cy, cx = y - y0, x - x0

    yy, xx = np.ogrid[:region.shape[0], :region.shape[1]]
    d2 = (yy - cy) ** 2 + (xx - cx) ** 2
    core = region[d2 <= r * r]
    ring = region[(d2 > (r * 1.6) ** 2) & (d2 <= (r * 2.6) ** 2)]
    if core.size < 4 or ring.size < 8:
        return 0.0

    # Contrast against its surroundings, in units of local variation — and
    # ABSOLUTE, because a white ball crossing a white ceiling reads slightly
    # darker than its background, not brighter. Testing only for "brighter"
    # scored those frames at zero and cut good tracks at the apex.
    contrast = abs(core.mean() - ring.mean()) / max(8.0, ring.std())
    # and compact: the core should be uniform, not half-bright like an edge
    uniform = 1.0 - min(1.0, core.std() / max(12.0, abs(core.mean() - ring.mean())))
    return float(max(0.0, min(1.0, contrast / 3.0)) * max(0.0, uniform))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("video")
    p.add_argument("--points", required=True)
    p.add_argument("--out", default=None, help="Write the trimmed points here.")
    p.add_argument("--radius", type=int, default=13)
    p.add_argument("--min-score", type=float, default=0.12)
    p.add_argument("--blur-step", type=float, default=55.0,
                   help="Px/frame above which the ball is a streak and is "
                        "exempt from the roundness test.")
    p.add_argument("--run", type=int, default=3,
                   help="Consecutive failures that end the track.")
    p.add_argument("--verbose", action="store_true")
    args = p.parse_args()

    pts = []
    for ln in open(args.points):
        t = ln.strip()
        if not t or t.startswith("#"):
            continue
        fr, xy = t.split(":")
        a, b = xy.split(",")
        pts.append((int(fr), float(a), float(b)))
    if not pts:
        sys.exit("No points.")
    want = {f for f, _, _ in pts}
    last = max(want)

    frames = {}
    cap = cv2.VideoCapture(args.video)
    idx = 0
    while True:
        ok, f = cap.read()
        if not ok:
            break
        if idx in want:
            frames[idx] = f
        idx += 1
        if idx > last:
            break
    cap.release()

    # A fast ball is a streak, not a blob, so it scores near zero on a test
    # built for compact bright objects. That is exactly what launch looks
    # like — the honest first frames of every shot. Exempt points whose local
    # step is large; judge only where the ball is slow enough to be round.
    import math as _m
    steps = []
    for i in range(len(pts)):
        lo, hi = max(0, i - 1), min(len(pts) - 1, i + 1)
        d = []
        for j in range(lo, hi):
            gap = max(1, pts[j + 1][0] - pts[j][0])
            d.append(_m.hypot(pts[j + 1][1] - pts[j][1],
                              pts[j + 1][2] - pts[j][2]) / gap)
        steps.append(max(d) if d else 0.0)

    scored = []
    for (f, x, y), st in zip(pts, steps):
        img = frames.get(f)
        sc = 0.0 if img is None else ball_score(img, x, y, args.radius)
        scored.append((f, x, y, sc, st))

    cut = len(scored)
    bad = 0
    for i, (_, _, _, sc, st) in enumerate(scored):
        if st > args.blur_step:
            bad = 0
            continue
        if sc < args.min_score:
            bad += 1
            if bad >= args.run:
                cut = i - bad + 1
                break
        else:
            bad = 0
    cut = max(cut, 2)
    kept = scored[:cut]

    if args.verbose:
        for f, x, y, sc, st in scored:
            print(f"{f} {int(x)},{int(y)} score={sc:.2f} step={st:.0f}"
                  f"{'  <-- cut' if f == kept[-1][0] else ''}")

    if args.out:
        lines = [f"# {os.path.basename(args.video)} — validated"]
        lines += [f"{f}:{round(x)},{round(y)}" for f, x, y, _, _ in kept]
        with open(args.out, "w") as fh:
            fh.write("\n".join(lines) + "\n")

    good = [s for _, _, _, s, _ in scored]
    print(json.dumps({
        "ok": len(kept) >= 5,
        "points_in": len(scored),
        "points_kept": len(kept),
        "first_frame": kept[0][0], "last_frame": kept[-1][0],
        "mean_score_kept": round(float(np.mean([s for _, _, _, s, _ in kept])), 3),
        "mean_score_all": round(float(np.mean(good)), 3),
        "out": os.path.abspath(args.out) if args.out else None,
    }, indent=1))


if __name__ == "__main__":
    main()
