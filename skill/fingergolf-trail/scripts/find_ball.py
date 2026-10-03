#!/usr/bin/env python3
"""Find a struck ball automatically by starting from where it sat still.

Blob-based tracking struggles in a cluttered room because dozens of things look
ball-shaped. This takes a different route, using a fact that is true of every
finger golf clip: the ball sits motionless on the mat for a long time before it
is hit.

1. Build a median background. Because the ball is static for most of the clip,
   it survives into that background — so the ball can be found there, on the
   mat, as a bright round blob.
2. Watch that exact spot over time. The frame where it stops matching is the
   strike, located without guessing at motion peaks (the biggest burst of
   motion in a clip is usually a hand reaching in, not the shot).
3. Cut a template from the ball at rest and search for it after the strike.
   Matching the ball's real appearance beats generic blob rules, and it copes
   with the ball shrinking and dimming as it flies away.
4. Keep the chain of matches that behaves like a ball in flight: smooth, and
   accelerating downward.

Writes points in `frame:x,y` form for points_to_track.py, plus a preview sheet.
"""

import argparse
import json
import math
import os
import subprocess
import sys

import cv2
import numpy as np


def read_all(path, scale):
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        sys.exit(f"Could not open {path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    small, idx = [], 0
    while True:
        ok, f = cap.read()
        if not ok:
            break
        small.append(cv2.resize(f, (int(f.shape[1] / scale),
                                    int(f.shape[0] / scale))))
        idx += 1
    cap.release()
    return small, fps


def find_resting_ball(bg, frames, args):
    """Locate the ball sitting on the mat, then the frame it leaves.

    Absolute colour thresholds do not survive a change of room or camera angle:
    the ball photographs as warm cream in one clip and cold white in another.
    What holds everywhere is local contrast — the ball is far brighter than the
    mat immediately around it. So look for small round blobs that stand out
    from their surroundings, then let the disappearance test decide which is
    really the ball.
    """
    hsv = cv2.cvtColor(bg, cv2.COLOR_BGR2HSV)
    v = hsv[:, :, 2]
    local = cv2.GaussianBlur(v, (0, 0), args.contrast_sigma)
    lift = cv2.subtract(v, local)
    _, mask = cv2.threshold(lift, args.contrast, 255, cv2.THRESH_BINARY)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, _, stats, cent = cv2.connectedComponentsWithStats(mask, 8)

    area_px = bg.shape[0] * bg.shape[1]
    cands = []
    for i in range(1, n):
        a = stats[i, cv2.CC_STAT_AREA]
        w, h = stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT]
        if not (area_px * args.min_ball_area < a < area_px * 2e-3):
            continue
        if not (0.55 < w / max(h, 1) < 1.8):
            continue
        if a / float(max(1, w * h)) < 0.55:
            continue
        cx, cy = int(cent[i][0]), int(cent[i][1])
        if cy < bg.shape[0] * args.min_y:
            continue
        x0b, y0b = stats[i, cv2.CC_STAT_LEFT], stats[i, cv2.CC_STAT_TOP]
        lift_mean = float(lift[y0b:y0b + h, x0b:x0b + w].mean())
        round_ = min(w, h) / float(max(w, h))
        # Favour blobs that are bright, round AND of a plausible size: a
        # nine-pixel specular speck can out-contrast the ball otherwise.
        cands.append((lift_mean * round_ * math.sqrt(a), cx, cy,
                      int(max(w, h))))
    if not cands:
        return None

    # Rank before truncating. Raster order would drop the ball whenever enough
    # clutter happens to sit above it in the frame.
    cands.sort(key=lambda c: -c[0])
    cands = [(cx, cy, sz) for _, cx, cy, sz in cands]

    best = None
    for cx, cy, size in cands[:args.max_rest_candidates]:
        r = max(6, int(size * 0.9))
        y0, y1 = max(0, cy - r), min(bg.shape[0], cy + r)
        x0, x1 = max(0, cx - r), min(bg.shape[1], cx + r)
        tmpl = bg[y0:y1, x0:x1]
        if tmpl.size == 0 or tmpl.shape[0] < 5 or tmpl.shape[1] < 5:
            continue
        scores = []
        for f in frames:
            patch = f[y0:y1, x0:x1]
            if patch.shape != tmpl.shape:
                scores.append(0.0)
                continue
            scores.append(float(cv2.matchTemplate(
                patch, tmpl, cv2.TM_CCOEFF_NORMED).max()))
        present = np.array(scores) > args.present_score

        # Change-point: the ball is there, then it is not, and it stays gone.
        # Scanning for the best split beats taking the last frame it appears,
        # which a single occlusion by a passing player would corrupt.
        bestsplit = None
        lo = max(5, int(len(present) * 0.05))
        for t in range(lo, len(present) - args.min_after):
            before = present[:t].mean()
            after = present[t:].mean()
            q = before * (1.0 - after)
            if bestsplit is None or q > bestsplit[0]:
                bestsplit = (q, t)
        if bestsplit is None:
            continue
        q, t = bestsplit
        if q < args.vanish_quality:
            continue
        # Candidates are already ordered by how ball-like they look, so take
        # the best-looking one that also disappears cleanly. Picking purely by
        # the sharpest disappearance instead lets any object the player walks
        # in front of outscore the ball.
        best = (q, cx, cy, r, t - 1, np.array(scores))
        break
    return best


def collect_candidates(frames, gray, bg_gray, strike, ref, args):
    """Find ball-like blobs after the strike by differencing against the
    background, across the WHOLE frame.

    Template matching on the ball at rest fails here: the ball is smeared into
    a streak by its own speed for the first frames of flight, which is exactly
    when it is needed. Motion differencing does not care about the smear.

    The size and brightness limits come from the ball as measured at rest in
    this very clip, so they adapt to the room and the camera instead of being
    guessed.
    """
    ref_area, ref_bright = ref
    kernel = np.ones((3, 3), np.uint8)
    per_frame = []
    end = min(len(frames), strike + args.max_flight + 1)
    for f in range(strike, end):
        d = cv2.absdiff(gray[f], bg_gray)
        _, m = cv2.threshold(d, args.diff, 255, cv2.THRESH_BINARY)
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, kernel)
        n, _, st, ce = cv2.connectedComponentsWithStats(m, 8)
        cands = []
        for k in range(1, n):
            a = st[k, cv2.CC_STAT_AREA]
            w, h = st[k, cv2.CC_STAT_WIDTH], st[k, cv2.CC_STAT_HEIGHT]
            if not (ref_area * 0.2 < a < ref_area * 5.0):
                continue
            if not (0.4 < w / max(h, 1) < 2.5):
                continue
            x0, y0 = st[k, cv2.CC_STAT_LEFT], st[k, cv2.CC_STAT_TOP]
            patch = frames[f][y0:y0 + h, x0:x0 + w].reshape(-1, 3)
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
        # Cap the tolerance. Without a ceiling a bad seed produces a huge
        # implied speed, which widens the gate until anything in the frame
        # matches and the "track" hops between unrelated objects.
        tol = max(args.min_tol,
                  min(args.max_tol,
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


def ballistic_fit(pts):
    """Fit y against time as a parabola. Returns (accel, rms residual).

    This is the one test nothing else in a room passes. A ball in flight has a
    constant downward acceleration; a shoulder, a shadow or a bright patch of
    carpet does not. Chain length and distance travelled both reward a track
    that creeps along a static object for a hundred frames, so neither can be
    trusted on its own.
    """
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


def best_chain(per_frame, args):
    best, best_score = None, -1.0
    horizon = min(len(per_frame), args.seed_window)
    for i0 in range(horizon):
        for p0 in per_frame[i0]:
            for i1 in range(i0 + 1, min(i0 + 1 + args.seed_span,
                                        len(per_frame))):
                for p1 in per_frame[i1]:
                    step = math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / (i1 - i0)
                    if step < args.min_step or step > args.max_step:
                        continue
                    pts = grow(per_frame, i0, p0, i1, p1, args)
                    if len(pts) < args.min_points:
                        continue
                    travel = sum(math.hypot(pts[j + 1][1][0] - pts[j][1][0],
                                            pts[j + 1][1][1] - pts[j][1][1])
                                 for j in range(len(pts) - 1))
                    if travel < args.min_travel:
                        continue
                    steps = [math.hypot(pts[j + 1][1][0] - pts[j][1][0],
                                        pts[j + 1][1][1] - pts[j][1][1])
                             for j in range(len(pts) - 1)]
                    if float(np.median(steps)) < args.min_median_step:
                        continue
                    accel, rms = ballistic_fit(pts)
                    if not (args.min_accel <= accel <= args.max_accel):
                        continue
                    if rms > args.max_rms:
                        continue
                    score = travel + len(pts) * 4 - rms * 3
                    if score > best_score:
                        best, best_score = pts, score
    return best


def main():
    p = argparse.ArgumentParser()
    p.add_argument("video")
    p.add_argument("--out", default="ball.txt")
    p.add_argument("--preview", default="ball_preview.png")
    p.add_argument("--scale", type=float, default=2.0,
                   help="Work at 1/scale resolution for speed.")
    p.add_argument("--contrast", type=int, default=32,
                   help="How much brighter than its surroundings the ball must "
                        "be. Lower it for a dull ball or a bright mat.")
    p.add_argument("--contrast-sigma", type=float, default=21.0)
    p.add_argument("--min-ball-area", type=float, default=1.2e-4,
                   help="Min blob area as a fraction of frame area.")
    p.add_argument("--max-rest-candidates", type=int, default=40)
    p.add_argument("--vanish-quality", type=float, default=0.45,
                   help="How cleanly the ball must disappear at the strike.")
    p.add_argument("--min-after", type=int, default=25,
                   help="Frames that must follow the strike.")
    p.add_argument("--min-travel", type=float, default=60.0,
                   help="Min path length (working scale) for a real flight.")
    p.add_argument("--min-y", type=float, default=0.35,
                   help="Ignore rest candidates above this fraction of height.")
    p.add_argument("--present-score", type=float, default=0.6)
    p.add_argument("--match", type=float, default=0.5)
    p.add_argument("--diff", type=int, default=26,
                   help="Motion threshold against the background.")
    p.add_argument("--bright-ratio", type=float, default=0.7,
                   help="Min brightness relative to the ball measured at rest.")
    p.add_argument("--peaks", type=int, default=6,
                   help="Match peaks kept per frame.")
    p.add_argument("--seed-window", type=int, default=22,
                   help="Frames after the strike a chain may start in.")
    p.add_argument("--seed-span", type=int, default=6)
    p.add_argument("--min-step", type=float, default=3.0)
    p.add_argument("--max-step", type=float, default=80.0)
    p.add_argument("--min-median-step", type=float, default=2.0,
                   help="Reject chains that mostly sit still.")
    p.add_argument("--min-accel", type=float, default=0.08,
                   help="Min downward acceleration, working px per frame^2.")
    p.add_argument("--max-accel", type=float, default=6.0)
    p.add_argument("--max-rms", type=float, default=7.0,
                   help="Max deviation from a parabola.")
    p.add_argument("--min-tol", type=float, default=10.0)
    p.add_argument("--max-tol", type=float, default=55.0,
                   help="Ceiling on the match gate, in working-scale px.")
    p.add_argument("--tol-ratio", type=float, default=0.6)
    p.add_argument("--max-gap", type=int, default=6)
    p.add_argument("--max-flight", type=int, default=140)
    p.add_argument("--min-points", type=int, default=6)
    args = p.parse_args()

    frames, fps = read_all(args.video, args.scale)
    if len(frames) < 10:
        sys.exit("Too few frames.")
    idx = np.linspace(0, len(frames) - 1, min(len(frames), 80)).astype(int)
    bg = np.median(np.stack([frames[i] for i in idx]), axis=0).astype(np.uint8)

    found = find_resting_ball(bg, frames, args)
    if not found:
        print(json.dumps({"ok": False,
                          "reason": "No resting ball found. Adjust "
                                    "--ball-value / --ball-sat / --min-y."}))
        sys.exit(2)
    quality, cx, cy, r, strike, scores = found
    tmpl = bg[cy - r:cy + r, cx - r:cx + r]

    gray = [cv2.GaussianBlur(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY), (5, 5), 0)
            for f in frames]
    bg_gray = cv2.GaussianBlur(cv2.cvtColor(bg, cv2.COLOR_BGR2GRAY), (5, 5), 0)
    rest_patch = bg[cy - r:cy + r, cx - r:cx + r].reshape(-1, 3)
    ref = (math.pi * (r * 0.75) ** 2, float(rest_patch.mean(axis=0).min()))
    per_frame = collect_candidates(frames, gray, bg_gray, strike, ref, args)
    chain = best_chain(per_frame, args)
    pts = [(strike + i, x, y) for i, (x, y, _) in chain] if chain else []
    if len(pts) < args.min_points:
        print(json.dumps({"ok": False, "strike_frame": strike,
                          "points": len(pts),
                          "reason": "Ball not followed after the strike. Try "
                                    "--match 0.4 or a larger --first-search."}))
        sys.exit(3)

    s = args.scale
    lines = [f"# {os.path.basename(args.video)} — strike at frame {strike}"]
    lines += [f"{f}:{round(x * s)},{round(y * s)}" for f, x, y in pts]
    with open(args.out, "w") as fh:
        fh.write("\n".join(lines) + "\n")

    picks = [pts[i] for i in np.linspace(0, len(pts) - 1,
                                         min(6, len(pts))).astype(int)]
    tiles = []
    for f, x, y in picks:
        img = frames[f].copy()
        cv2.circle(img, (int(x), int(y)), 16, (0, 255, 255), 2)
        cv2.putText(img, f"f{f}", (8, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.8,
                    (0, 255, 255), 2)
        tiles.append(img)
    path_img = frames[pts[-1][0]].copy()
    cv2.polylines(path_img, [np.array([[int(x), int(y)] for _, x, y in pts],
                                      np.int32)], False, (0, 255, 255), 2)
    cv2.putText(path_img, "path", (8, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.8,
                (0, 255, 255), 2)
    tiles.append(path_img)
    tw = 240
    tiles = [cv2.resize(t, (tw, int(t.shape[0] * tw / t.shape[1])))
             for t in tiles]
    rows = [np.hstack(tiles[i:i + 4]) for i in range(0, len(tiles), 4)]
    wmax = max(rr.shape[1] for rr in rows)
    rows = [np.pad(rr, ((0, 0), (0, wmax - rr.shape[1]), (0, 0)))
            if rr.shape[1] < wmax else rr for rr in rows]
    cv2.imwrite(args.preview, np.vstack(rows))

    print(json.dumps({"ok": True, "strike_frame": strike,
                      "points": len(pts),
                      "first_frame": pts[0][0], "last_frame": pts[-1][0],
                      "rest_xy": [int(cx * s), int(cy * s)],
                      "out": os.path.abspath(args.out),
                      "preview": os.path.abspath(args.preview)}, indent=1))


if __name__ == "__main__":
    main()
