#!/usr/bin/env python3
"""Follow the ball from a point you already know, using template matching.

This is the most reliable stage in the whole pipeline and the one to reach for
when a track comes back as a stub. Blob detection tuned to the ball at rest
loses it a few frames into flight — moving, it is dimmer, smaller and smeared,
so it falls outside limits calibrated on a stationary ball. Matching the ball's
actual appearance in a window around the predicted position does not care about
any of that.

It needs a starting point, which the other scripts supply: find_ball.py reports
the rest position and strike frame, or read one off `draw_trail.py --grid`.

Tracking stops when the ball stops: once the match position barely changes for
several frames the ball has come to rest, gone behind something, or the match
has latched onto the background. Carrying on past that point pads the track
with a stationary tail that renders as a bright dot sitting in the grass.
"""

import argparse
import json
import math
import os
import sys

import cv2
import numpy as np


def track(path, start, x, y, args):
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        sys.exit(f"Could not open {path}")

    frames = {}
    idx = 0
    last_needed = start + args.max_frames + 1
    first_needed = max(0, start - args.max_frames - 1)
    while True:
        ok, f = cap.read()
        if not ok:
            break
        if first_needed <= idx <= last_needed:
            frames[idx] = f
        idx += 1
        if idx > last_needed:
            break
    cap.release()
    if start not in frames:
        sys.exit(f"Frame {start} not in video.")

    R = args.radius
    base = frames[start]
    tmpl = base[max(0, y - R):y + R, max(0, x - R):x + R]
    if tmpl.size == 0:
        sys.exit("Template is empty — check the start position.")

    pts = [(start, float(x), float(y))]
    last = (float(x), float(y))
    vx = vy = 0.0
    still = 0
    moving = False

    frame_seq = (range(start + 1, last_needed + 1) if not args.backward
                 else range(start - 1, max(-1, start - args.max_frames - 1), -1))
    for f in frame_seq:
        if f not in frames:
            break
        img = frames[f]
        px, py = last[0] + vx, last[1] + vy
        W = args.window
        x0 = int(max(0, min(px - W, img.shape[1] - tmpl.shape[1])))
        y0 = int(max(0, min(py - W, img.shape[0] - tmpl.shape[0])))
        x1 = int(min(img.shape[1], max(px + W, x0 + tmpl.shape[1])))
        y1 = int(min(img.shape[0], max(py + W, y0 + tmpl.shape[0])))
        roi = img[y0:y1, x0:x1]
        if roi.shape[0] < tmpl.shape[0] or roi.shape[1] < tmpl.shape[1]:
            break
        res = cv2.matchTemplate(roi, tmpl, cv2.TM_CCOEFF_NORMED)
        _, mv, _, ml = cv2.minMaxLoc(res)
        cx = x0 + ml[0] + tmpl.shape[1] / 2.0
        cy = y0 + ml[1] + tmpl.shape[0] / 2.0

        if mv < args.min_match:
            break

        # Refresh the template from a confident match. A ball flying toward the
        # camera grows and blurs; a patch cut from the small, distant ball at
        # the start stops matching within a handful of frames, and the search
        # then latches onto whatever background scores highest instead.
        if args.adapt and mv >= args.adapt_match:
            iy, ix = int(round(cy)), int(round(cx))
            cand = img[max(0, iy - R):iy + R, max(0, ix - R):ix + R]
            if cand.shape == tmpl.shape:
                tmpl = cand
        step = math.hypot(cx - last[0], cy - last[1])
        if step >= args.stall_step:
            moving = True
            still = 0
        elif moving:
            # Only treat stillness as "the ball has stopped" once it has
            # actually started. Starting a few frames before the strike is the
            # recommended way to crop, so the opening frames are a motionless
            # ball on the mat — counting those as a stall kills the track
            # before the shot happens.
            still += 1
            if still >= args.stall_frames:
                break
        vx, vy = cx - last[0], cy - last[1]
        pts.append((f, cx, cy))
        last = (cx, cy)

    if args.backward:
        pts.reverse()

    # drop the motionless lead-in before the strike, keeping a couple of
    # frames so the trail starts at the ball rather than mid-flight
    first_move = 0
    for i in range(1, len(pts)):
        if math.hypot(pts[i][1] - pts[i - 1][1],
                      pts[i][2] - pts[i - 1][2]) >= args.stall_step:
            first_move = i - 1
            break
    if first_move > 2:
        pts = pts[first_move - 1:]

    # drop any stationary tail left at the end
    while len(pts) > 2:
        s = math.hypot(pts[-1][1] - pts[-2][1], pts[-1][2] - pts[-2][2])
        if s < args.stall_step:
            pts.pop()
        else:
            break
    return pts, frames


def main():
    p = argparse.ArgumentParser()
    p.add_argument("video")
    p.add_argument("--at", type=int, required=True, help="Frame to start from.")
    p.add_argument("--from", dest="start", required=True, help="'x,y' of the ball.")
    p.add_argument("--out", default="ball.txt")
    p.add_argument("--preview", default="track_preview.png")
    p.add_argument("--radius", type=int, default=24,
                   help="Half-size of the template patch, in px.")
    p.add_argument("--window", type=float, default=90,
                   help="Search radius around the predicted position.")
    p.add_argument("--min-match", type=float, default=0.45)
    p.add_argument("--stall-step", type=float, default=2.0)
    p.add_argument("--stall-frames", type=int, default=4)
    p.add_argument("--max-frames", type=int, default=140)
    p.add_argument("--backward", action="store_true",
                   help="Walk back in time instead of forward. Use it to reach "
                        "the launch: the ball is sharpest near the apex, so a "
                        "track seeded there covers only the descent unless it "
                        "is also grown backwards into the blurred frames "
                        "right after impact.")
    p.add_argument("--adapt", action="store_true", default=True,
                   help="Refresh the template from confident matches.")
    p.add_argument("--no-adapt", dest="adapt", action="store_false")
    p.add_argument("--adapt-match", type=float, default=0.6,
                   help="Only refresh when the match is at least this good.")
    args = p.parse_args()

    x, y = (int(float(v)) for v in args.start.split(","))
    pts, frames = track(args.video, args.at, x, y, args)
    if len(pts) < 4:
        print(json.dumps({"ok": False, "points": len(pts),
                          "reason": "Lost immediately. Check the start point, "
                                    "or raise --window / lower --min-match."}))
        sys.exit(2)

    lines = [f"# {os.path.basename(args.video)} — tracked from frame {args.at}"]
    lines += [f"{f}:{round(px)},{round(py)}" for f, px, py in pts]
    with open(args.out, "w") as fh:
        fh.write("\n".join(lines) + "\n")

    picks = [pts[i] for i in
             np.linspace(0, len(pts) - 1, min(6, len(pts))).astype(int)]
    tiles = []
    for f, px, py in picks:
        img = frames.get(f)
        if img is None:
            continue
        x0, y0 = int(max(0, px - 110)), int(max(0, py - 110))
        c = img[y0:y0 + 220, x0:x0 + 220].copy()
        if c.shape[0] < 220 or c.shape[1] < 220:
            c = cv2.copyMakeBorder(c, 0, max(0, 220 - c.shape[0]),
                                   0, max(0, 220 - c.shape[1]),
                                   cv2.BORDER_CONSTANT)
        cv2.circle(c, (int(px - x0), int(py - y0)), 16, (0, 0, 255), 2)
        cv2.putText(c, f"f{f}", (6, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6,
                    (0, 255, 255), 2)
        tiles.append(c)
    if tiles:
        rows = [np.hstack(tiles[i:i + 3]) for i in range(0, len(tiles), 3)]
        w = max(r.shape[1] for r in rows)
        rows = [np.pad(r, ((0, 0), (0, w - r.shape[1]), (0, 0)))
                if r.shape[1] < w else r for r in rows]
        cv2.imwrite(args.preview, np.vstack(rows))

    travel = sum(math.hypot(pts[i + 1][1] - pts[i][1],
                            pts[i + 1][2] - pts[i][2])
                 for i in range(len(pts) - 1))
    print(json.dumps({"ok": True, "points": len(pts),
                      "first_frame": pts[0][0], "last_frame": pts[-1][0],
                      "travel_px": round(travel),
                      "out": os.path.abspath(args.out),
                      "preview": os.path.abspath(args.preview)}, indent=1))


if __name__ == "__main__":
    main()
