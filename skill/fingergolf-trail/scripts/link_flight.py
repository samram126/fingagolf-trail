#!/usr/bin/env python3
"""Link ball candidates into a flight with a simple nearest-neighbour walk.

Companion to find_flight.py for the clips where its chain search is out-voted
by the player or stalls at the apex. It uses the same candidate source —
consecutive-frame differencing, player masked, optional search region — but
links them greedily from the launch: each frame, take the candidate nearest to
where the ball should be (linear extrapolation from the last two points),
within a gate that scales with speed. Gaps of several frames are bridged.

Greedy is the right tool once the candidates are clean: at the apex the ball
moves a few pixels a frame and a constant-acceleration predictor fed noisy
positions overshoots, which is where find_flight's chains tend to end.
"""

import argparse
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from find_flight import candidates, find_strike  # noqa: E402


def main():
    p = argparse.ArgumentParser()
    p.add_argument("video")
    p.add_argument("--ball", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--radius", type=int, default=28)
    p.add_argument("--ref-frame", type=int, default=0)
    p.add_argument("--after", type=int, default=90)
    p.add_argument("--region", type=lambda v: [int(q) for q in v.split(",")],
                   default=None)
    p.add_argument("--body-area", type=int, default=20000)
    p.add_argument("--max-gap", type=int, default=12)
    p.add_argument("--launch-window", type=int, default=6)
    p.add_argument("--launch-dist", type=float, default=450)
    p.add_argument("--strike", type=int, default=None,
                   help="Override the detected strike frame.")
    p.add_argument("--max-area", type=float, default=2500,
                   help="Largest blob accepted; raise (~4000) when the ball "
                        "comes close to the camera and blurs into a streak.")
    p.add_argument("--min-area", type=float, default=8)
    p.add_argument("--merge", type=int, default=0,
                   help="Px: merge blobs this close into one (use ~31 when the "
                        "ball flies at the camera and streaks).")
    p.add_argument("--seed", default=None, metavar="F:X,Y;F:X,Y",
                   help="Start the walk from these two points instead of the "
                        "strike (e.g. the landing, when linking a reversed clip).")
    args = p.parse_args()

    bx, by = (int(float(v)) for v in args.ball.split(","))
    strike, total = find_strike(args.video, bx, by, args.radius,
                                ref=args.ref_frame)
    if args.strike is not None:
        strike = args.strike
    if strike is None or strike >= total - 5:
        print(json.dumps({"ok": False, "reason": "no strike in clip"}))
        sys.exit(2)
    hi = min(total - 3, strike + args.after)
    cands = candidates(args.video, strike + 1, hi, 10, args.min_area, args.max_area,
                       body_area=args.body_area, max_per_frame=12,
                       region=args.region, merge_px=args.merge)

    # launch: the biggest candidate near the ball soon after the strike
    seed = None
    for f in range(strike + 1, strike + 1 + args.launch_window):
        for c in cands.get(f, []):
            d = math.hypot(c[0] - bx, c[1] - by)
            if d <= args.launch_dist and (seed is None or c[2] > seed[3]):
                seed = (f, c[0], c[1], c[2])
        if seed:
            break
    if not seed and not args.seed:
        print(json.dumps({"ok": False, "strike_frame": strike,
                          "reason": "no launch candidate near the ball"}))
        sys.exit(3)

    if not args.seed:
        pts = [(strike, float(bx), float(by)), (seed[0], seed[1], seed[2])]
    else:
        pts = []
        for q in args.seed.split(";"):
            fq, xy = q.split(":")
            xq, yq = xy.split(",")
            pts.append((int(fq), float(xq), float(yq)))
        seed = (pts[-1][0],)
    f = seed[0] + 1
    while f <= hi:
        lf, lx, ly = pts[-1]
        pf, px, py = pts[-2]
        gap = f - lf
        if gap > args.max_gap:
            break
        vx = (lx - px) / max(1, lf - pf)
        vy = (ly - py) / max(1, lf - pf)
        ex, ey = lx + vx * gap, ly + vy * gap
        speed = math.hypot(vx, vy)
        gate = max(45.0, 0.8 * speed * gap) + 12.0 * gap
        best = None
        for c in cands.get(f, []):
            d = math.hypot(c[0] - ex, c[1] - ey)
            if d <= gate and (best is None or d < best[0]):
                best = (d, c[0], c[1])
        if best:
            pts.append((f, best[1], best[2]))
        f += 1

    with open(args.out, "w") as fh:
        fh.write(f"# {os.path.basename(args.video)} strike {strike} (linked)\n")
        fh.write("\n".join(f"{a}:{round(b)},{round(c)}" for a, b, c in pts))
        fh.write("\n")
    print(json.dumps({"ok": True, "strike_frame": strike, "points": len(pts),
                      "first": pts[1][0], "last": pts[-1][0],
                      "out": os.path.abspath(args.out)}, indent=1))


if __name__ == "__main__":
    main()
