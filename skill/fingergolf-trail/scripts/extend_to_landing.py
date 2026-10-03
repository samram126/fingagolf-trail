#!/usr/bin/env python3
"""Carry a track forward from its last point until the ball actually lands.

Tracks tend to stop early on the descent. The ball falls into a darker, busier
part of the frame, shrinks and blurs, and both template matching and
median-background differencing lose it — the median background is built from
frames the ball passes through, and a faint ball against dark shelving barely
differs from it. The trail then ends in mid-air.

Consecutive-frame differencing does see it: compare each frame with the ones
two before and two after, and keep what is brighter than BOTH. That isolates
the ball itself rather than the patch it just uncovered, and it needs no
background model at all. Search is constrained to near the predicted position
(constant acceleration from the last few points), so nothing else in the room
is picked up.

Stops at the landing: the first frame where the ball's downward motion
reverses (it has hit something) or motion falls away. Pass --through-bounce to
keep going through bounces as well.
"""

import argparse
import json
import math
import sys

import cv2
import numpy as np


def load(fn):
    pts = []
    for ln in open(fn):
        t = ln.strip()
        if not t or t.startswith("#"):
            continue
        fr, xy = t.split(":")
        a, b = xy.split(",")
        pts.append((int(fr), float(a), float(b)))
    pts.sort()
    return pts


def main():
    p = argparse.ArgumentParser()
    p.add_argument("video")
    p.add_argument("--points", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--max-frames", type=int, default=60)
    p.add_argument("--diff", type=int, default=10)
    p.add_argument("--search", type=float, default=70.0,
                   help="Px around the predicted position to accept a blob.")
    p.add_argument("--through-bounce", action="store_true")
    p.add_argument("--min-speed", type=float, default=6.0,
                   help="Px/frame the track must still be moving to extend.")
    args = p.parse_args()

    pts = load(args.points)
    if len(pts) < 3:
        sys.exit("Need at least three points to predict from.")
    f_last = pts[-1][0]
    hi = f_last + args.max_frames + 3

    G = {}
    cap = cv2.VideoCapture(args.video)
    idx = 0
    while True:
        ok, f = cap.read()
        if not ok:
            break
        if f_last - 3 <= idx <= hi:
            G[idx] = cv2.GaussianBlur(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY),
                                      (3, 3), 0).astype(np.int16)
        idx += 1
        if idx > hi:
            break
    cap.release()

    hist = [(f, x, y) for f, x, y in pts[-4:]]

    # Only continue a track that is still in flight. If the last few points
    # have already come to rest the ball has landed, and "extending" would
    # just add the settling jiggle to the end of the trail.
    (fa, xa, ya), (fb, xb, yb) = pts[-3], pts[-1]
    speed = math.hypot(xb - xa, yb - ya) / max(1, fb - fa)
    if speed < args.min_speed:
        with open(args.out, "w") as fh:
            fh.write("# already at rest — not extended\n")
            fh.write("\n".join(f"{f}:{round(x)},{round(y)}" for f, x, y in pts))
            fh.write("\n")
        print(json.dumps({"ok": True, "added": 0, "was_last": f_last,
                          "now_last": f_last, "note": "already at rest"}))
        return
    added = []
    misses = 0
    prev_vy = None
    for f in range(f_last + 1, f_last + args.max_frames + 1):
        if f not in G or (f - 2) not in G:
            break
        nxt = G.get(f + 2, G.get(f + 1))
        if nxt is None:
            break
        # predict with constant acceleration from recent history
        (f1, x1, y1), (f2, x2, y2) = hist[-2], hist[-1]
        vx = (x2 - x1) / max(1, f2 - f1)
        vy = (y2 - y1) / max(1, f2 - f1)
        ay = 0.0
        if len(hist) >= 3:
            f0, x0, y0 = hist[-3]
            ay = ((y2 - y1) / max(1, f2 - f1) - (y1 - y0) / max(1, f1 - f0))
        gap = f - f2
        px, py = x2 + vx * gap, y2 + vy * gap + 0.5 * ay * gap * gap

        a = G[f] - G[f - 2]
        b = G[f] - nxt
        m = ((a > args.diff) & (b > args.diff)).astype(np.uint8) * 255
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
        n, _, st, ce = cv2.connectedComponentsWithStats(m, 8)
        best = None
        for k in range(1, n):
            ar = st[k, cv2.CC_STAT_AREA]
            if not (6 < ar < 1500):
                continue
            d = math.hypot(ce[k][0] - px, ce[k][1] - py)
            if d <= args.search * max(1, gap) and (best is None or d < best[0]):
                best = (d, float(ce[k][0]), float(ce[k][1]))
        if best is None:
            misses += 1
            if misses > 3:
                break
            continue
        misses = 0
        _, bx, by = best
        vy_now = (by - hist[-1][2]) / max(1, f - hist[-1][0])
        # landing: the ball was descending and now is not
        if (not args.through_bounce and prev_vy is not None
                and prev_vy > 3 and vy_now < 0.25 * prev_vy):
            break
        prev_vy = vy_now
        added.append((f, bx, by))
        hist.append((f, bx, by))

    out = pts + added
    with open(args.out, "w") as fh:
        fh.write("# extended to landing\n")
        fh.write("\n".join(f"{f}:{round(x)},{round(y)}" for f, x, y in out))
        fh.write("\n")
    print(json.dumps({"ok": True, "added": len(added),
                      "was_last": f_last,
                      "now_last": out[-1][0]}, indent=1))


if __name__ == "__main__":
    main()
