#!/usr/bin/env python3
"""Find a shot's full flight: impact -> apex -> landing.

Built on consecutive-frame differencing (a pixel counts only if it is brighter
than the frames two before AND two after). That isolates the ball itself, not
the patch it uncovered, and needs no background model — which is what let it
see faint balls against dark shelving that median-background differencing
misses entirely.

The player produces candidates too (a swinging forearm, a shirt edge), and a
forearm can even move ballistically for a few frames. So candidates are chained
with a constant-acceleration predictor and the winning chain has to:

  * start near the ball's rest position soon after the strike (the ball leaves
    from where it sat; a shoulder does not),
  * stay small (ball-sized blobs only),
  * fit a parabola locally all the way along,
  * and be long.

Writes frame:x,y points with the impact anchored at the rest position.
"""

import argparse
import json
import math
import os
import sys

import cv2
import numpy as np


def find_strike(path, x, y, R, present=0.75, ref=0):
    cap = cv2.VideoCapture(path)
    patches = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        patches.append(f[max(0, y - R):y + R, max(0, x - R):x + R].copy())
    cap.release()
    # The reference must show the ball alone. Frame 0 usually does, but a hand
    # still placing the ball there makes the "ball" template a hand.
    t = patches[min(ref, len(patches) - 1)]
    ok_ = []
    for p in patches:
        if p.shape != t.shape:
            ok_.append(False)
            continue
        ok_.append(float(cv2.matchTemplate(p, t, cv2.TM_CCOEFF_NORMED).max())
                   > present)
    best_len, best_end, cur = 0, None, 0
    for i, b in enumerate(ok_):
        cur = cur + 1 if b else 0
        if cur > best_len:
            best_len, best_end = cur, i
    return best_end, len(patches)


def candidates(path, lo, hi, diff, amin, amax, body_area=0, max_per_frame=12,
               region=None, merge_px=0):
    G = {}
    cap = cv2.VideoCapture(path)
    idx = 0
    while True:
        ok, f = cap.read()
        if not ok:
            break
        if lo - 2 <= idx <= hi + 2:
            G[idx] = cv2.GaussianBlur(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY),
                                      (3, 3), 0).astype(np.int16)
        idx += 1
        if idx > hi + 2:
            break
    cap.release()
    out = {}
    k2 = np.ones((2, 2), np.uint8)
    for f in range(lo, hi + 1):
        if f - 2 not in G or f + 2 not in G:
            continue
        a = G[f] - G[f - 2]
        b = G[f] - G[f + 2]
        m = ((a > diff) & (b > diff)).astype(np.uint8) * 255
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, k2)
        if merge_px:
            # A ball close to the camera blurs into a streak longer than its
            # per-frame motion, so the part it shares with the neighbouring
            # frames drops out and it splits into two blobs. Label the blobs
            # on a closed mask so the halves count as one ball, but keep the
            # centroid and area of the pixels that were really there.
            mc = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(
                cv2.MORPH_ELLIPSE, (merge_px, merge_px)))
            n, lab = cv2.connectedComponents(mc, connectivity=8)
            st = np.zeros((n, 5), np.int32)
            ce = np.zeros((n, 2), np.float64)
            ys, xs = np.nonzero(m)
            ls = lab[ys, xs]
            for k in range(1, n):
                sel = ls == k
                if not sel.any():
                    continue
                kx, ky = xs[sel], ys[sel]
                st[k] = [kx.min(), ky.min(), kx.max() - kx.min() + 1,
                         ky.max() - ky.min() + 1, sel.sum()]
                ce[k] = [kx.mean(), ky.mean()]
        else:
            n, _, st, ce = cv2.connectedComponentsWithStats(m, 8)

        # The player: any region of large motion, grown a little. Folds of a
        # moving shirt throw off dozens of small bright blobs that pass every
        # ball test and can even chain ballistically for a stretch; a ball is
        # never inside a large moving body.
        big = (np.abs(a) > diff).astype(np.uint8) * 255
        big = cv2.morphologyEx(big, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
        nb, lb, sb, _ = cv2.connectedComponentsWithStats(big, 8)
        body = np.zeros_like(big)
        for k in range(1, nb):
            if sb[k, cv2.CC_STAT_AREA] >= body_area:
                body[lb == k] = 255
        if body.any():
            body = cv2.dilate(body, np.ones((31, 31), np.uint8))
        c = []
        for k in range(1, n):
            ar = st[k, cv2.CC_STAT_AREA]
            w, h = st[k, cv2.CC_STAT_WIDTH], st[k, cv2.CC_STAT_HEIGHT]
            if not (amin <= ar <= amax):
                continue
            # a fast ball is a streak, so allow elongation, but not a sliver
            if ar == 0 or max(w, h) > 12 * max(1, min(w, h)):
                continue
            cx_, cy_ = int(ce[k][0]), int(ce[k][1])
            if body[cy_, cx_]:
                continue
            if region and not (region[0] <= cx_ <= region[2]
                               and region[1] <= cy_ <= region[3]):
                continue
            c.append((float(ce[k][0]), float(ce[k][1]), float(ar)))
        # keep the chain search tractable when a moving player sheds dozens
        # of small blobs: the ball is rarely the smallest thing in a frame
        c.sort(key=lambda q: -q[2])
        out[f] = c[:max_per_frame]
    return out


def chain_from(cands, frames, i0, p0, i1, p1, max_gap, tol_min, tol_ratio):
    pts = [(frames[i0], p0[0], p0[1]), (frames[i1], p1[0], p1[1])]
    for fi in range(i1 + 1, len(frames)):
        f = frames[fi]
        lf, lx, ly = pts[-1]
        gap = f - lf
        if gap > max_gap:
            break
        pf, px_, py_ = pts[-2]
        vx = (lx - px_) / max(1, lf - pf)
        vy = (ly - py_) / max(1, lf - pf)
        ay = 0.0
        if len(pts) >= 3:
            qf, qx, qy = pts[-3]
            ay = vy - (py_ - qy) / max(1, pf - qf)
        ex = lx + vx * gap
        ey = ly + vy * gap + 0.5 * ay * gap * gap
        tol = max(tol_min, tol_ratio * math.hypot(vx, vy) * gap) + 6.0 * gap
        best, bd = None, None
        for c in cands.get(f, []):
            d = math.hypot(c[0] - ex, c[1] - ey)
            if d <= tol and (bd is None or d < bd):
                best, bd = c, d
        if best is not None:
            pts.append((f, best[0], best[1]))
    return pts


def local_rms(pts, half=4):
    if len(pts) < 7:
        return 1e9
    t = np.array([p[0] for p in pts], float)
    x = np.array([p[1] for p in pts], float)
    y = np.array([p[2] for p in pts], float)
    res = []
    for i in range(len(pts)):
        lo, hi = max(0, i - half), min(len(pts), i + half + 1)
        idx = [j for j in range(lo, hi) if j != i]
        if len(idx) < 5:
            continue
        px = np.polyval(np.polyfit(t[idx], x[idx], 2), t[i])
        py = np.polyval(np.polyfit(t[idx], y[idx], 2), t[i])
        res.append(math.hypot(x[i] - px, y[i] - py))
    return float(np.median(res)) if res else 1e9


def main():
    p = argparse.ArgumentParser()
    p.add_argument("video")
    p.add_argument("--ball", required=True, help="'x,y' of the ball at address")
    p.add_argument("--out", required=True)
    p.add_argument("--radius", type=int, default=28)
    p.add_argument("--after", type=int, default=80)
    p.add_argument("--ref-frame", type=int, default=0,
                   help="Frame where the ball sits alone at address.")
    p.add_argument("--diff", type=int, default=10)
    p.add_argument("--min-area", type=float, default=8)
    p.add_argument("--max-area", type=float, default=2500)
    p.add_argument("--region", type=lambda v: [int(q) for q in v.split(",")],
                   default=None, metavar="X0,Y0,X1,Y1",
                   help="Only consider the ball inside this box — e.g. exclude "
                        "the side of the frame the player stands in.")
    p.add_argument("--max-gap", type=int, default=12,
                   help="Frames the ball may go unseen mid-flight.")
    p.add_argument("--body-area", type=int, default=0,
                   help="Ignore candidates inside moving regions at least this "
                        "big (px). 0 = off. ~20000 at 1440x2560 masks a player.")
    p.add_argument("--launch-window", type=int, default=14,
                   help="Frames after the strike a chain may start in.")
    p.add_argument("--launch-dist", type=float, default=900,
                   help="Max px from the rest position for the first point.")
    args = p.parse_args()

    bx, by = (int(float(v)) for v in args.ball.split(","))
    strike, total = find_strike(args.video, bx, by, args.radius,
                                ref=args.ref_frame)
    if strike is None or strike >= total - 5:
        print(json.dumps({"ok": False, "reason": "no strike in clip"}))
        sys.exit(2)

    lo, hi = strike + 1, min(total - 3, strike + args.after)
    cands = candidates(args.video, lo, hi, args.diff, args.min_area,
                       args.max_area, body_area=args.body_area,
                       region=args.region)
    frames = sorted(cands)

    best, best_score = None, -1e18
    for i0, f0 in enumerate(frames):
        if f0 > strike + args.launch_window:
            break
        for p0 in cands[f0]:
            if math.hypot(p0[0] - bx, p0[1] - by) > args.launch_dist:
                continue
            for i1 in range(i0 + 1, min(i0 + 4, len(frames))):
                for p1 in cands[frames[i1]]:
                    step = math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / max(
                        1, frames[i1] - f0)
                    if step < 3 or step > 400:
                        continue
                    # Gaps of up to ~12 frames are normal: near the apex the
                    # ball crosses a bright ceiling or light and vanishes from
                    # the difference image. Breaking the chain there throws away
                    # both halves of an otherwise clean flight.
                    ch = chain_from(cands, frames, i0, p0, i1, p1,
                                    max_gap=args.max_gap, tol_min=22,
                                    tol_ratio=0.6)
                    if len(ch) < 10:
                        continue
                    rms = local_rms(ch)
                    if rms > 12:
                        continue
                    travel = sum(math.hypot(ch[k + 1][1] - ch[k][1],
                                            ch[k + 1][2] - ch[k][2])
                                 for k in range(len(ch) - 1))
                    # prefer long, physical chains that start near the ball
                    start_d = math.hypot(ch[0][1] - bx, ch[0][2] - by)
                    score = len(ch) * 10 + travel * 0.2 - rms * 15 - start_d * 0.1
                    if score > best_score:
                        best, best_score = ch, score

    if not best:
        print(json.dumps({"ok": False, "strike_frame": strike,
                          "reason": "no physical flight chain"}))
        sys.exit(3)

    pts = [(strike, float(bx), float(by))] + best
    with open(args.out, "w") as fh:
        fh.write(f"# {os.path.basename(args.video)} strike {strike}\n")
        fh.write("\n".join(f"{f}:{round(x)},{round(y)}" for f, x, y in pts))
        fh.write("\n")
    print(json.dumps({"ok": True, "strike_frame": strike,
                      "points": len(pts), "first": best[0][0],
                      "last": best[-1][0], "local_rms": round(local_rms(best), 1),
                      "out": os.path.abspath(args.out)}, indent=1))


if __name__ == "__main__":
    main()
