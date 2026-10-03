#!/usr/bin/env python3
"""Track a small fast-moving ball in a locked-off (tripod / propped up) video.

Strategy: the camera does not move, so anything that changes between frames is
either the ball, the player's hand, or noise. We build a median background,
diff each frame against it, keep blobs that are ball-sized, then search for the
longest smooth trajectory through those blobs. The hand is rejected by area;
noise is rejected because it does not form a smooth path.

Outputs a track JSON and a preview contact sheet so the track can be eyeballed
before spending time on rendering.
"""

import argparse
import json
import math
import os
import subprocess
import sys

import cv2
import numpy as np


# ---------------------------------------------------------------- input prep

def probe_rotation(path):
    """Phone videos carry rotation metadata that OpenCV ignores."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json",
             "-show_streams", "-select_streams", "v:0", path],
            capture_output=True, text=True, check=True).stdout
        info = json.loads(out)["streams"][0]
    except Exception:
        return 0
    rot = 0
    for sd in info.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = int(sd["rotation"])
    tags = info.get("tags", {}) or {}
    if "rotate" in tags:
        rot = int(tags["rotate"])
    return rot % 360


def normalize(path, workdir):
    """Bake in rotation so every downstream step sees upright pixels."""
    rot = probe_rotation(path)
    if rot == 0:
        return path
    out = os.path.join(workdir, "normalized.mp4")
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", path,
         "-c:v", "libx264", "-crf", "16", "-preset", "veryfast",
         "-pix_fmt", "yuv420p", "-c:a", "copy", out],
        check=True)
    return out


def video_meta(path):
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        sys.exit(f"Could not open video: {path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    ok, frame = cap.read()
    cap.release()
    if not ok:
        sys.exit("Could not read any frames.")
    h, w = frame.shape[:2]
    return fps, total, w, h


def iter_frames(path, start, end):
    """Stream frames in [start, end]. Full-resolution frames are never all held
    at once — a 10s 1080p clip is several GB if you keep them."""
    cap = cv2.VideoCapture(path)
    idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx >= start and (end is None or idx <= end):
            yield idx - start, frame
        idx += 1
        if end is not None and idx > end:
            break
    cap.release()


def to_gray(frame, scale):
    if scale != 1.0:
        h, w = frame.shape[:2]
        frame = cv2.resize(frame, (int(w / scale), int(h / scale)))
    return cv2.GaussianBlur(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (5, 5), 0)


# ---------------------------------------------------------------- detection

def build_background(samples):
    """Median over a sample of frames. A ball only occupies any given pixel
    briefly, so it vanishes from the median while the carpet survives."""
    return np.median(np.stack(samples), axis=0).astype(np.uint8)


def color_score(bgr_patch, hint_bgr):
    if hint_bgr is None or bgr_patch.size == 0:
        return 1.0
    mean = bgr_patch.reshape(-1, 3).mean(axis=0)
    dist = np.linalg.norm(mean - np.array(hint_bgr, dtype=float))
    return float(max(0.0, 1.0 - dist / 180.0))


def area_limits(bg, args):
    area = bg.shape[0] * bg.shape[1]
    min_a = args.min_area if args.min_area else max(3.0, area * 0.00002)
    max_a = args.max_area if args.max_area else area * 0.003
    return min_a, max_a


def detect_frame(gray, color, bg, args, hint_bgr, min_a, max_a, kernel):
    """Return the plausible ball blobs in one frame."""
    if True:
        diff = cv2.absdiff(gray, bg)
        _, mask = cv2.threshold(diff, args.threshold, 255, cv2.THRESH_BINARY)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
        mask = cv2.dilate(mask, kernel, iterations=1)

        n, _, stats, centroids = cv2.connectedComponentsWithStats(mask, 8)
        cands = []
        for i in range(1, n):
            a = stats[i, cv2.CC_STAT_AREA]
            if a < min_a or a > max_a:
                continue
            x, y = centroids[i]
            bx, by = stats[i, cv2.CC_STAT_LEFT], stats[i, cv2.CC_STAT_TOP]
            bw, bh = stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT]
            # A ball, even motion-blurred into a streak, stays compact-ish.
            if max(bw, bh) > 12 * max(1, min(bw, bh)):
                continue
            patch = color[by:by + bh, bx:bx + bw]
            # Rank by how ball-like the blob is, not just colour. A ball fills
            # its bounding box like a disc (~0.79); edges, streaks and noise
            # fragments fill far less. Without this the ranking is flat when no
            # colour hint is given, the list keeps whatever comes first in
            # raster order, and the ball gets dropped whenever enough clutter
            # sits above it in the frame.
            fill = a / float(max(1, bw * bh))
            roundness = min(bw, bh) / float(max(bw, bh))
            shape = fill * (0.5 + 0.5 * roundness)
            cands.append({"x": float(x), "y": float(y), "area": float(a),
                          "score": shape * color_score(patch, hint_bgr)})
        cands.sort(key=lambda c: -c["score"])
        return cands[:args.max_candidates]


# ---------------------------------------------------------------- trajectory

def dist(a, b):
    return math.hypot(a["x"] - b["x"], a["y"] - b["y"])


def grow_track(per_frame, f0, c0, f1, c1, args):
    """Extend a two-point seed forward.

    Prediction carries an acceleration term because the thing being followed is
    a ball in flight: it can leave the club at over a hundred pixels a frame,
    decelerate to nearly nothing at the apex, then accelerate downward again.
    Constant-velocity prediction loses it at the top of every arc.
    """
    pts = [(f0, c0), (f1, c1)]
    vx = (c1["x"] - c0["x"]) / (f1 - f0)
    vy = (c1["y"] - c0["y"]) / (f1 - f0)
    ax = ay = 0.0
    last_f, last = f1, c1

    f = f1 + 1
    while f < len(per_frame):
        gap = f - last_f
        if gap > args.max_gap:
            break
        px = last["x"] + vx * gap + 0.5 * ax * gap * gap
        py = last["y"] + vy * gap + 0.5 * ay * gap * gap
        speed = math.hypot(vx, vy) * gap
        tol = max(args.min_tolerance, args.tolerance_ratio * speed)

        best, best_d = None, None
        for c in per_frame[f]:
            d = math.hypot(c["x"] - px, c["y"] - py)
            if d <= tol and (best_d is None or d < best_d):
                best, best_d = c, d
        if best is not None:
            nvx = (best["x"] - last["x"]) / gap
            nvy = (best["y"] - last["y"]) / gap
            nax = (nvx - vx) / gap
            nay = (nvy - vy) / gap
            ax = 0.6 * ax + 0.4 * nax
            ay = 0.6 * ay + 0.4 * nay
            vx = 0.75 * nvx + 0.25 * (vx + ax)
            vy = 0.75 * nvy + 0.25 * (vy + ay)
            pts.append((f, best))
            last_f, last = f, best
        f += 1
    return pts


def find_best_track(per_frame, args):
    best, best_score = None, -1.0
    n = len(per_frame)
    # Seed from the most ball-like blobs only, but let a growing chain match
    # against the full candidate list. In a cluttered room the ball routinely
    # ranks 20th or worse on shape alone, so a pool narrow enough to seed from
    # cheaply is far too narrow to follow a ball through.
    for f0 in range(n - args.min_length):
        for c0 in per_frame[f0][:args.max_seeds]:
            for f1 in range(f0 + 1, min(f0 + 1 + args.seed_span, n)):
                for c1 in per_frame[f1][:args.max_seeds]:
                    step = dist(c0, c1) / (f1 - f0)
                    if step < args.min_speed or step > args.max_speed:
                        continue
                    pts = grow_track(per_frame, f0, c0, f1, c1, args)
                    if len(pts) < args.min_length:
                        continue
                    travel = sum(dist(pts[i][1], pts[i + 1][1])
                                 for i in range(len(pts) - 1))
                    if travel < args.min_travel:
                        continue
                    # Distance dominates on purpose. A struck ball is visible
                    # for a short burst but crosses the frame; flickering
                    # highlights, shadows and screen reflections persist for
                    # hundreds of frames while going nowhere. Ranking by frame
                    # count picks the light fixture every time.
                    score = travel + len(pts) * 3
                    if score > best_score:
                        best, best_score = pts, score
    return best


def trim_lead(pts):
    """The hand is still moving in the instant before the flick, so a track can
    pick up a few slow hand-fragment points before the ball itself.

    Compare each leading segment against the direction of the motion just after
    it, not against the overall chord of the arc: a struck ball climbs and then
    falls, so its start and end directions legitimately oppose each other and a
    global reference would flag the entire climb as backwards.
    """
    if len(pts) < 6:
        return pts
    steps = [dist(pts[i][1], pts[i + 1][1]) for i in range(len(pts) - 1)]
    med = float(np.median(steps[len(steps) // 3:]))
    if med <= 0:
        return pts

    max_drop = max(0, len(pts) // 5)
    last_bad = -1
    for i in range(min(max_drop, len(steps) - 4)):
        seg = np.array([pts[i + 1][1]["x"] - pts[i][1]["x"],
                        pts[i + 1][1]["y"] - pts[i][1]["y"]])
        ahead = np.array([pts[i + 4][1]["x"] - pts[i + 1][1]["x"],
                          pts[i + 4][1]["y"] - pts[i + 1][1]["y"]])
        sn, an = np.linalg.norm(seg), np.linalg.norm(ahead)
        slow = steps[i] < 0.4 * med
        wrong_way = sn > 0 and an > 0 and float(seg @ ahead) / (sn * an) < 0.0
        if slow or wrong_way:
            last_bad = i
    return pts[last_bad + 1:] if last_bad >= 0 else pts


def densify(pts, scale):
    """Fill missed frames by linear interpolation, and scale back to full res."""
    out = []
    for i, (f, c) in enumerate(pts):
        out.append({"frame": f, "x": c["x"] * scale, "y": c["y"] * scale,
                    "detected": True})
        if i + 1 < len(pts):
            nf, nc = pts[i + 1]
            for g in range(f + 1, nf):
                t = (g - f) / (nf - f)
                out.append({
                    "frame": g,
                    "x": (c["x"] + (nc["x"] - c["x"]) * t) * scale,
                    "y": (c["y"] + (nc["y"] - c["y"]) * t) * scale,
                    "detected": False})
    return out


# ---------------------------------------------------------------- preview

def make_preview(path, start, track, scale, out_path):
    """Contact sheet: a few frames with the detection marked, plus the full
    path drawn on the last frame. This is the sanity check before rendering."""
    if not track:
        return
    n = min(6, len(track))
    picks = [track[i] for i in np.linspace(0, len(track) - 1, n).astype(int)]
    wanted = {p["frame"]: p for p in picks}
    last = track[-1]["frame"]
    wanted.setdefault(last, track[-1])

    grabbed = {}
    for rel, frame in iter_frames(path, start, None):
        if rel in wanted:
            h, w = frame.shape[:2]
            grabbed[rel] = cv2.resize(frame, (int(w / scale), int(h / scale))) \
                if scale != 1.0 else frame.copy()
        if rel >= last:
            break

    tiles = []
    for p in picks:
        img = grabbed.get(p["frame"])
        if img is None:
            continue
        img = img.copy()
        cx, cy = int(p["x"] / scale), int(p["y"] / scale)
        cv2.circle(img, (cx, cy), 18, (0, 255, 255), 2)
        cv2.putText(img, f"f{p['frame'] + start}", (10, 34),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.1, (0, 255, 255), 2)
        tiles.append(img)

    base = grabbed.get(last)
    if base is not None:
        path_img = base.copy()
        poly = np.array([[int(q["x"] / scale), int(q["y"] / scale)]
                         for q in track], np.int32)
        cv2.polylines(path_img, [poly], False, (0, 255, 255), 3)
        cv2.putText(path_img, "full path", (10, 34),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.1, (0, 255, 255), 2)
        tiles.append(path_img)

    if not tiles:
        return
    tw = 300
    resized = [cv2.resize(t, (tw, int(t.shape[0] * tw / t.shape[1])))
               for t in tiles]
    per_row = 4
    rows = [np.hstack(resized[i:i + per_row])
            for i in range(0, len(resized), per_row)]
    width = max(r.shape[1] for r in rows)
    rows = [np.pad(r, ((0, 0), (0, width - r.shape[1]), (0, 0)))
            if r.shape[1] < width else r for r in rows]
    cv2.imwrite(out_path, np.vstack(rows))


# ---------------------------------------------------------------- main

def parse_color(s):
    if not s:
        return None
    named = {"white": (255, 255, 255), "yellow": (0, 255, 255),
             "orange": (0, 165, 255), "green": (0, 200, 0),
             "red": (0, 0, 255), "blue": (255, 0, 0), "pink": (180, 105, 255),
             "black": (20, 20, 20)}
    if s.lower() in named:
        return named[s.lower()]
    s = s.lstrip("#")
    return (int(s[4:6], 16), int(s[2:4], 16), int(s[0:2], 16))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("video")
    p.add_argument("--out", default="track.json")
    p.add_argument("--preview", default="track_preview.png")
    p.add_argument("--start-frame", type=int, default=0)
    p.add_argument("--end-frame", type=int, default=None)
    p.add_argument("--threshold", type=int, default=25,
                   help="Pixel difference to count as motion. Lower = more sensitive.")
    p.add_argument("--min-area", type=float, default=None)
    p.add_argument("--max-area", type=float, default=None,
                   help="Raise if the ball is large; lower to reject the hand.")
    p.add_argument("--ball-color", default=None,
                   help="Optional hint (white, yellow, #RRGGBB) used to rank blobs.")
    p.add_argument("--min-speed", type=float, default=2.0,
                   help="Px/frame at detection scale; rejects stationary noise.")
    p.add_argument("--max-speed", type=float, default=220.0)
    p.add_argument("--max-gap", type=int, default=4)
    p.add_argument("--min-length", type=int, default=5)
    p.add_argument("--min-travel", type=float, default=None,
                   help="Min total path length in px at detection scale. "
                        "Defaults to 8%% of the frame diagonal; rejects "
                        "flickering lights and shadows that never go anywhere.")
    p.add_argument("--max-candidates", type=int, default=40,
                   help="Blobs per frame a growing track may match against.")
    p.add_argument("--seed-span", type=int, default=5,
                   help="Frames apart a seed pair may be. Raise if the ball is "
                        "missed in the first frames after contact.")
    p.add_argument("--max-seeds", type=int, default=14,
                   help="Blobs per frame used to start a track. Small for speed.")
    p.add_argument("--min-tolerance", type=float, default=18.0)
    p.add_argument("--tolerance-ratio", type=float, default=0.75,
                   help="Match radius as a fraction of predicted speed. Set "
                        "high by default because a lofted ball decelerates "
                        "hard into its apex. Try 0.9 if the track stops there.")
    p.add_argument("--work-width", type=int, default=960)
    p.add_argument("--no-trim-lead", action="store_true",
                   help="Keep points detected before the ball leaves the finger.")
    args = p.parse_args()

    workdir = os.path.dirname(os.path.abspath(args.out)) or "."
    src = normalize(args.video, workdir)

    fps, total, w, h = video_meta(src)
    start_f = args.start_frame
    end_f = args.end_frame
    scale = w / args.work_width if w > args.work_width else 1.0

    # Pass 1: sample frames for the background model. Only the samples are
    # kept, so memory stays flat regardless of clip length.
    span_end = end_f if end_f is not None else (total - 1 if total else None)
    if span_end is not None and span_end >= start_f:
        n_span = span_end - start_f + 1
        want = set(np.linspace(0, n_span - 1, min(n_span, 60)).astype(int).tolist())
    else:
        want = None
    samples = []
    for rel, frame in iter_frames(src, start_f, end_f):
        if want is None or rel in want:
            samples.append(to_gray(frame, scale))
    if not samples:
        sys.exit("No frames read — check --start-frame / --end-frame.")
    bg = build_background(samples)
    n_frames = (span_end - start_f + 1) if span_end is not None else len(samples)
    del samples

    # Pass 2: detect candidate blobs frame by frame.
    if args.min_travel is None:
        args.min_travel = 0.08 * math.hypot(*bg.shape[:2])

    hint = parse_color(args.ball_color)
    min_a, max_a = area_limits(bg, args)
    kernel = np.ones((3, 3), np.uint8)
    per_frame = []
    for rel, frame in iter_frames(src, start_f, end_f):
        small = cv2.resize(frame, (int(w / scale), int(h / scale))) \
            if scale != 1.0 else frame
        gray = to_gray(frame, scale)
        per_frame.append(detect_frame(gray, small, bg, args, hint,
                                      min_a, max_a, kernel))

    pts = find_best_track(per_frame, args)

    if pts and not args.no_trim_lead:
        pts = trim_lead(pts)

    if not pts:
        print(json.dumps({"ok": False,
                          "reason": "No trajectory found. Try lowering "
                                    "--threshold, raising --max-area, or "
                                    "trimming to just the shot."}))
        sys.exit(2)

    track = densify(pts, scale)
    make_preview(src, start_f, track, scale, args.preview)

    data = {"ok": True, "source": os.path.abspath(args.video),
            "normalized": os.path.abspath(src), "fps": fps,
            "width": w, "height": h,
            "frame_offset": start_f,
            "detections": len(pts), "span": len(track),
            "points": track}
    with open(args.out, "w") as f:
        json.dump(data, f, indent=1)

    print(json.dumps({"ok": True, "detections": len(pts), "span": len(track),
                      "first_frame": track[0]["frame"] + start_f,
                      "last_frame": track[-1]["frame"] + start_f,
                      "preview": os.path.abspath(args.preview),
                      "track": os.path.abspath(args.out)}, indent=1))


if __name__ == "__main__":
    main()
