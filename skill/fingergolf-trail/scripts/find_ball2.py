#!/usr/bin/env python3
"""Find a struck ball automatically, from where it rested to where it landed.

Four passes over the file, each doing the one job it is suited to:

1. Sample frames, cheaply, for two background models — a small one to spot the
   ball at rest, and a full-resolution one for the flight.
2. Find the ball sitting on the mat. It is static for most of the clip, so it
   survives into the background and can be picked out there as a small round
   blob that is much brighter than the mat around it. Local contrast is used
   rather than an absolute colour, because the ball photographs as warm cream
   in one room and cold white in another.
3. Watch that spot over time. The frame where it stops matching is the strike —
   located without guessing at motion peaks, since the largest burst of motion
   in one of these clips is usually a hand reaching in, not the shot.
4. Difference each frame after the strike against the background and keep
   ball-sized, ball-bright blobs, then search for the chain of them that fits a
   parabola with downward acceleration. That fit is the only test nothing else
   in a room passes: chain length and distance both reward a track that creeps
   along a static object, so neither can be trusted alone.

Detection runs at full resolution because the ball is only a few pixels across;
frames are streamed so memory stays flat.
"""

import argparse
import json
import math
import os
import sys

import cv2
import numpy as np


def stream(path, lo=0, hi=None):
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        sys.exit(f"Could not open {path}")
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


def meta(path):
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    ok, f = cap.read()
    cap.release()
    if not ok:
        sys.exit("Could not read frames.")
    return fps, n, f.shape[1], f.shape[0]


def gray_of(f):
    return cv2.GaussianBlur(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY), (5, 5), 0)


def build_backgrounds(path, n, scale, samples):
    want = set(np.linspace(0, max(0, n - 1), min(max(n, 1), samples))
               .astype(int).tolist())
    small, full = [], []
    for idx, f in stream(path):
        if idx in want:
            small.append(cv2.resize(f, (int(f.shape[1] / scale),
                                        int(f.shape[0] / scale))))
            full.append(gray_of(f))
    if not small:
        sys.exit("No frames sampled.")
    bg_small = np.median(np.stack(small), axis=0).astype(np.uint8)
    bg_full = np.median(np.stack(full), axis=0).astype(np.uint8)
    return bg_small, bg_full


def rest_candidates(bg, args):
    hsv = cv2.cvtColor(bg, cv2.COLOR_BGR2HSV)
    v = hsv[:, :, 2]
    lift = cv2.subtract(v, cv2.GaussianBlur(v, (0, 0), args.contrast_sigma))
    _, mask = cv2.threshold(lift, args.contrast, 255, cv2.THRESH_BINARY)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, _, st, ce = cv2.connectedComponentsWithStats(mask, 8)
    area_px = bg.shape[0] * bg.shape[1]

    out = []
    for i in range(1, n):
        a = st[i, cv2.CC_STAT_AREA]
        w, h = st[i, cv2.CC_STAT_WIDTH], st[i, cv2.CC_STAT_HEIGHT]
        if not (area_px * args.min_ball_area < a < area_px * 2e-3):
            continue
        if not (0.55 < w / max(h, 1) < 1.8):
            continue
        if a / float(max(1, w * h)) < 0.55:
            continue
        cx, cy = int(ce[i][0]), int(ce[i][1])
        if cy < bg.shape[0] * args.min_y:
            continue
        x0, y0 = st[i, cv2.CC_STAT_LEFT], st[i, cv2.CC_STAT_TOP]
        lm = float(lift[y0:y0 + h, x0:x0 + w].mean())
        rnd = min(w, h) / float(max(w, h))
        # Bright, round AND plausibly sized: a few-pixel specular speck can
        # out-contrast the ball otherwise. Rank before truncating — raster
        # order would drop the ball whenever clutter sits above it.
        out.append((lm * rnd * math.sqrt(a), cx, cy, int(max(w, h)), int(a)))
    out.sort(key=lambda c: -c[0])
    return out[:args.max_rest_candidates]


def strike_frame(path, bg, cands, args):
    """For each candidate, score its patch every frame, then find the split
    where it goes from present to permanently absent."""
    rois = []
    for _, cx, cy, size, a in cands:
        r = max(5, int(size * 0.9))
        y0, y1 = max(0, cy - r), min(bg.shape[0], cy + r)
        x0, x1 = max(0, cx - r), min(bg.shape[1], cx + r)
        t = bg[y0:y1, x0:x1]
        rois.append((x0, x1, y0, y1, t, cx, cy, r, a))

    series = [[] for _ in rois]
    for idx, f in stream(path):
        sm = cv2.resize(f, (bg.shape[1], bg.shape[0]))
        for k, (x0, x1, y0, y1, t, *_ ) in enumerate(rois):
            p = sm[y0:y1, x0:x1]
            if p.shape != t.shape:
                series[k].append(0.0)
            else:
                series[k].append(float(cv2.matchTemplate(
                    p, t, cv2.TM_CCOEFF_NORMED).max()))

    for k, sc in enumerate(series):
        present = np.array(sc) > args.present_score
        if len(present) < args.min_after + 10:
            continue
        best = None
        lo = max(5, int(len(present) * 0.05))
        for t in range(lo, len(present) - args.min_after):
            q = present[:t].mean() * (1.0 - present[t:].mean())
            if best is None or q > best[0]:
                best = (q, t)
        if best and best[0] >= args.vanish_quality:
            x0, x1, y0, y1, tmpl, cx, cy, r, a = rois[k]
            return best[1] - 1, cx, cy, r, a, tmpl
    return None


def flight_candidates(path, bg_full, strike, ref, args):
    ref_area, ref_bright = ref
    kernel = np.ones((3, 3), np.uint8)
    per_frame = []
    for idx, f in stream(path, strike, strike + args.max_flight):
        d = cv2.absdiff(gray_of(f), bg_full)
        _, m = cv2.threshold(d, args.diff, 255, cv2.THRESH_BINARY)
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, kernel)
        n, _, st, ce = cv2.connectedComponentsWithStats(m, 8)
        cands = []
        for k in range(1, n):
            a = st[k, cv2.CC_STAT_AREA]
            w, h = st[k, cv2.CC_STAT_WIDTH], st[k, cv2.CC_STAT_HEIGHT]
            if not (ref_area * args.area_lo < a < ref_area * args.area_hi):
                continue
            if not (0.4 < w / max(h, 1) < 2.5):
                continue
            x0, y0 = st[k, cv2.CC_STAT_LEFT], st[k, cv2.CC_STAT_TOP]
            patch = f[y0:y0 + h, x0:x0 + w].reshape(-1, 3)
            if patch.size == 0:
                continue
            bright = float(patch.mean(axis=0).min())
            if bright < ref_bright * args.bright_ratio:
                continue
            fill = a / float(max(1, w * h))
            cands.append((float(ce[k][0]), float(ce[k][1]), fill * bright))
        cands.sort(key=lambda c: -c[2])
        per_frame.append(cands[:args.peaks])
    return per_frame


def ballistic_fit(pts):
    t = np.array([p[0] for p in pts], dtype=float)
    y = np.array([p[1][1] for p in pts], dtype=float)
    if len(t) < 4:
        return 0.0, 1e9
    t = t - t[0]
    try:
        coef = np.polyfit(t, y, 2)
    except Exception:
        return 0.0, 1e9
    resid = y - np.polyval(coef, t)
    return float(coef[0] * 2.0), float(np.sqrt((resid ** 2).mean()))


def grow(per_frame, i0, p0, i1, p1, args):
    pts = [(i0, p0), (i1, p1)]
    vx = (p1[0] - p0[0]) / (i1 - i0)
    vy = (p1[1] - p0[1]) / (i1 - i0)
    ax = ay = 0.0
    last_i, last = i1, p1
    i = i1 + 1
    while i < len(per_frame):
        gap = i - last_i
        if gap > args.max_gap:
            break
        px = last[0] + vx * gap + 0.5 * ax * gap * gap
        py = last[1] + vy * gap + 0.5 * ay * gap * gap
        tol = max(args.min_tol, min(args.max_tol,
                                    args.tol_ratio * math.hypot(vx, vy) * gap))
        best, bd = None, None
        for c in per_frame[i]:
            d = math.hypot(c[0] - px, c[1] - py)
            if d <= tol and (bd is None or d < bd):
                best, bd = c, d
        if best is not None:
            nvx = (best[0] - last[0]) / gap
            nvy = (best[1] - last[1]) / gap
            ax = 0.6 * ax + 0.4 * (nvx - vx) / gap
            ay = 0.6 * ay + 0.4 * (nvy - vy) / gap
            vx, vy = nvx, nvy
            pts.append((i, best))
            last_i, last = i, best
        i += 1
    return pts


def extend_back(per_frame, pts, args):
    """Grow a chain backwards in time.

    Chains are seeded wherever the ball is easiest to see, which is usually the
    descent — the ball is sharpest and slowest there. Growing only forwards
    therefore throws away the climb. Running the same prediction in reverse
    recovers it.
    """
    if len(pts) < 2:
        return pts
    (i1, p1), (i2, p2) = pts[0], pts[1]
    vx = (p1[0] - p2[0]) / (i2 - i1)
    vy = (p1[1] - p2[1]) / (i2 - i1)
    ax = ay = 0.0
    last_i, last = i1, p1
    found = []
    i = i1 - 1
    while i >= 0:
        gap = last_i - i
        if gap > args.max_gap:
            break
        px = last[0] + vx * gap + 0.5 * ax * gap * gap
        py = last[1] + vy * gap + 0.5 * ay * gap * gap
        tol = max(args.min_tol, min(args.max_tol,
                                    args.tol_ratio * math.hypot(vx, vy) * gap))
        best, bd = None, None
        for c in per_frame[i]:
            d = math.hypot(c[0] - px, c[1] - py)
            if d <= tol and (bd is None or d < bd):
                best, bd = c, d
        if best is not None:
            nvx = (best[0] - last[0]) / gap
            nvy = (best[1] - last[1]) / gap
            ax = 0.6 * ax + 0.4 * (nvx - vx) / gap
            ay = 0.6 * ay + 0.4 * (nvy - vy) / gap
            vx, vy = nvx, nvy
            found.append((i, best))
            last_i, last = i, best
        i -= 1
    return list(reversed(found)) + pts


def best_chain(per_frame, args):
    best, best_score = None, -1e18
    horizon = min(len(per_frame), args.seed_window)
    for i0 in range(horizon):
        for p0 in per_frame[i0]:
            for i1 in range(i0 + 1, min(i0 + 1 + args.seed_span,
                                        len(per_frame))):
                for p1 in per_frame[i1]:
                    step = math.hypot(p1[0] - p0[0],
                                      p1[1] - p0[1]) / (i1 - i0)
                    if step < args.min_step or step > args.max_step:
                        continue
                    pts = grow(per_frame, i0, p0, i1, p1, args)
                    if len(pts) < args.min_points:
                        continue
                    steps = [math.hypot(pts[j + 1][1][0] - pts[j][1][0],
                                        pts[j + 1][1][1] - pts[j][1][1])
                             for j in range(len(pts) - 1)]
                    if float(np.median(steps)) < args.min_median_step:
                        continue
                    travel = sum(steps)
                    if travel < args.min_travel:
                        continue
                    accel, rms = ballistic_fit(pts)
                    if not (args.min_accel <= accel <= args.max_accel):
                        continue
                    if rms > args.max_rms:
                        continue
                    score = travel + len(pts) * 4 - rms * 6
                    if score > best_score:
                        best, best_score = pts, score
    return best


def main():
    p = argparse.ArgumentParser()
    p.add_argument("video")
    p.add_argument("--out", default="ball.txt")
    p.add_argument("--preview", default="ball_preview.png")
    p.add_argument("--rest-scale", type=float, default=2.0)
    p.add_argument("--samples", type=int, default=60)
    p.add_argument("--contrast", type=int, default=32)
    p.add_argument("--contrast-sigma", type=float, default=21.0)
    p.add_argument("--min-ball-area", type=float, default=1.2e-4)
    p.add_argument("--min-y", type=float, default=0.35)
    p.add_argument("--max-rest-candidates", type=int, default=6)
    p.add_argument("--present-score", type=float, default=0.6)
    p.add_argument("--vanish-quality", type=float, default=0.45)
    p.add_argument("--min-after", type=int, default=25)
    p.add_argument("--diff", type=int, default=24)
    p.add_argument("--bright-ratio", type=float, default=0.62)
    p.add_argument("--area-lo", type=float, default=0.08,
                   help="Min blob area vs the ball at rest. Low because a "
                        "ball in flight is farther away and blurred.")
    p.add_argument("--area-hi", type=float, default=5.0)
    p.add_argument("--peaks", type=int, default=8)
    p.add_argument("--max-flight", type=int, default=160)
    p.add_argument("--seed-window", type=int, default=40)
    p.add_argument("--seed-span", type=int, default=6)
    p.add_argument("--min-step", type=float, default=3.0)
    p.add_argument("--max-step", type=float, default=160.0)
    p.add_argument("--min-tol", type=float, default=18.0)
    p.add_argument("--max-tol", type=float, default=110.0)
    p.add_argument("--tol-ratio", type=float, default=0.6)
    p.add_argument("--max-gap", type=int, default=5)
    p.add_argument("--min-points", type=int, default=7)
    p.add_argument("--min-travel", type=float, default=120.0)
    p.add_argument("--min-median-step", type=float, default=4.0)
    p.add_argument("--min-accel", type=float, default=0.15)
    p.add_argument("--max-accel", type=float, default=14.0)
    p.add_argument("--max-rms", type=float, default=12.0)
    args = p.parse_args()

    fps, n, W, H = meta(args.video)
    bg_small, bg_full = build_backgrounds(args.video, n, args.rest_scale,
                                          args.samples)
    cands = rest_candidates(bg_small, args)
    if not cands:
        print(json.dumps({"ok": False, "reason": "No resting ball candidates."}))
        sys.exit(2)

    got = strike_frame(args.video, bg_small, cands, args)
    if not got:
        print(json.dumps({"ok": False,
                          "reason": "Found no candidate that disappears "
                                    "cleanly. Try --vanish-quality 0.3."}))
        sys.exit(3)
    strike, cxs, cys, rs, area_s, tmpl = got

    s = args.rest_scale
    cx, cy, r = int(cxs * s), int(cys * s), max(4, int(rs * s))

    # Calibrate from the ball as it sits at rest, measured in this clip.
    # Both numbers matter more than they look: a radius taken from the blob's
    # bounding box overstates the ball and the area floor then rejects it in
    # flight, and a brightness sampled from a live frame can land on a frame
    # where the ball has already gone.
    rest_patch = bg_small[max(0, cys - rs):cys + rs,
                          max(0, cxs - rs):cxs + rs]
    rest_bright = (float(rest_patch.reshape(-1, 3).mean(axis=0).min())
                   if rest_patch.size else 150.0)
    ref_area = float(area_s) * (s ** 2)
    ref = (ref_area, rest_bright)

    per_frame = flight_candidates(args.video, bg_full, strike, ref, args)
    chain = best_chain(per_frame, args)
    if chain:
        chain = extend_back(per_frame, chain, args)
    if not chain:
        print(json.dumps({"ok": False, "strike_frame": strike,
                          "rest_xy": [cx, cy],
                          "reason": "No ballistic chain after the strike. Try "
                                    "--diff 18 --bright-ratio 0.5."}))
        sys.exit(4)

    pts = [(strike + i, x, y) for i, (x, y, _) in chain]
    accel, rms = ballistic_fit(chain)

    lines = [f"# {os.path.basename(args.video)} — strike {strike}, "
             f"accel {accel:.2f}px/f^2, rms {rms:.1f}px"]
    lines += [f"{f}:{round(x)},{round(y)}" for f, x, y in pts]
    with open(args.out, "w") as fh:
        fh.write("\n".join(lines) + "\n")

    want = {f for f, _, _ in pts}
    grabbed = {}
    for idx, f in stream(args.video, pts[0][0], pts[-1][0]):
        if idx in want:
            grabbed[idx] = f
    picks = [pts[i] for i in
             np.linspace(0, len(pts) - 1, min(5, len(pts))).astype(int)]
    tiles = []
    for f, x, y in picks:
        img = grabbed.get(f)
        if img is None:
            continue
        img = img.copy()
        cv2.circle(img, (int(x), int(y)), 26, (0, 255, 255), 3)
        cv2.putText(img, f"f{f}", (10, 40), cv2.FONT_HERSHEY_SIMPLEX, 1.2,
                    (0, 255, 255), 3)
        tiles.append(img)
    last = grabbed.get(pts[-1][0])
    if last is not None:
        pi = last.copy()
        cv2.polylines(pi, [np.array([[int(x), int(y)] for _, x, y in pts],
                                    np.int32)], False, (0, 255, 255), 4)
        cv2.putText(pi, "path", (10, 40), cv2.FONT_HERSHEY_SIMPLEX, 1.2,
                    (0, 255, 255), 3)
        tiles.append(pi)
    if tiles:
        tw = 300
        tiles = [cv2.resize(t, (tw, int(t.shape[0] * tw / t.shape[1])))
                 for t in tiles]
        rows = [np.hstack(tiles[i:i + 3]) for i in range(0, len(tiles), 3)]
        wm = max(rr.shape[1] for rr in rows)
        rows = [np.pad(rr, ((0, 0), (0, wm - rr.shape[1]), (0, 0)))
                if rr.shape[1] < wm else rr for rr in rows]
        cv2.imwrite(args.preview, np.vstack(rows))

    print(json.dumps({"ok": True, "strike_frame": strike,
                      "rest_xy": [cx, cy], "points": len(pts),
                      "first_frame": pts[0][0], "last_frame": pts[-1][0],
                      "accel_px_per_frame2": round(accel, 2),
                      "fit_rms_px": round(rms, 1),
                      "out": os.path.abspath(args.out),
                      "preview": os.path.abspath(args.preview)}, indent=1))


if __name__ == "__main__":
    main()
