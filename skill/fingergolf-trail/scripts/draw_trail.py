#!/usr/bin/env python3
"""Draw a trail onto footage along a path you specify, synced to the strike.

Use this when tracking isn't possible — most often because the ball crosses the
frame between exposures and was never photographed in flight. Nothing here is
measured: the path is the one you give it. That makes this a stylised effect
rather than a tracer, which is fine as long as it isn't presented as the ball's
measured route.

The reveal is timed to the footage: nothing is drawn before the contact frame,
and the line grows from that frame onward at whatever pace `--duration` sets.
"""

import argparse
import json
import os
import subprocess
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from trailstyle import bezier, draw_polyline, parse_color  # noqa: E402


DIRECTIONS = {
    "left": (-1, 0), "right": (1, 0), "up": (0, -1), "down": (0, 1),
    "up-left": (-0.7, -0.7), "up-right": (0.7, -0.7),
    "down-left": (-0.7, 0.7), "down-right": (0.7, 0.7),
}


def grid_frame(video, frame_no, out):
    """Write one frame with a labelled coordinate grid, so points can be picked
    by eye instead of guessed."""
    cap = cv2.VideoCapture(video)
    idx, img = 0, None
    while True:
        ok, f = cap.read()
        if not ok:
            break
        if idx == frame_no:
            img = f
            break
        idx += 1
    cap.release()
    if img is None:
        sys.exit(f"Frame {frame_no} not found.")
    h, w = img.shape[:2]
    for x in range(0, w, w // 6):
        cv2.line(img, (x, 0), (x, h), (0, 255, 255), 2)
        cv2.putText(img, str(x), (x + 6, 40), cv2.FONT_HERSHEY_SIMPLEX,
                    1.1, (0, 255, 255), 3)
    for y in range(0, h, h // 10):
        cv2.line(img, (0, y), (w, y), (0, 255, 255), 2)
        cv2.putText(img, str(y), (8, y - 8), cv2.FONT_HERSHEY_SIMPLEX,
                    1.1, (0, 255, 255), 3)
    cv2.imwrite(out, img)
    print(json.dumps({"ok": True, "grid": os.path.abspath(out),
                      "frame": frame_no, "width": w, "height": h}, indent=1))


def parse_point(s, w, h):
    """Accept '430,1470' in pixels or '0.4,0.77' as a fraction of the frame."""
    x, y = (float(v) for v in s.split(","))
    if abs(x) <= 1.0 and abs(y) <= 1.0:
        x, y = x * w, y * h
    return (x, y)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("video")
    p.add_argument("-o", "--out", default="trail.mp4")
    p.add_argument("--grid", type=int, default=None,
                   help="Write this frame with a coordinate grid and exit.")
    p.add_argument("--grid-out", default="grid.png")

    p.add_argument("--at", type=int, default=None,
                   help="Contact frame. The trail starts growing here.")
    p.add_argument("--from", dest="start", default=None,
                   help="Ball position at contact, 'x,y' or fractions.")
    p.add_argument("--to", default=None,
                   help="Where the shot ends, 'x,y'. May be off-frame.")
    p.add_argument("--direction", default=None,
                   help="Instead of --to: left, right, up, down, up-left, "
                        "up-right, down-left, down-right. These are lofted "
                        "shots, so expect 'up' or a steep diagonal.")
    p.add_argument("--distance", type=float, default=1.1,
                   help="With --direction: travel as a fraction of frame "
                        "width. Over 1.0 exits the frame.")
    p.add_argument("--arc", type=float, default=0.0,
                   help="Bow the path sideways, e.g. 0.15 or -0.15. 0 is straight.")

    p.add_argument("--duration", type=float, default=0.35,
                   help="Seconds for the line to draw out from the contact frame.")
    p.add_argument("--hold", type=float, default=1.2,
                   help="Seconds frozen on the finished trail at the end.")
    p.add_argument("--fade-in", type=float, default=0.0,
                   help="Seconds of fade at the start of the reveal.")
    p.add_argument("--color", default="lime")
    p.add_argument("--width", type=float, default=None)
    p.add_argument("--glow", type=float, default=0.85)
    p.add_argument("--no-taper", action="store_true")
    p.add_argument("--no-head", action="store_true",
                   help="Hide the bright dot at the leading end.")
    p.add_argument("--no-audio", action="store_true")
    args = p.parse_args()

    if args.grid is not None:
        grid_frame(args.video, args.grid, args.grid_out)
        return

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        sys.exit(f"Could not open video: {args.video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    ok, first = cap.read()
    cap.release()
    if not ok:
        sys.exit("Could not read the video.")
    H, W = first.shape[:2]

    if args.at is None or args.start is None:
        sys.exit("Need --at (contact frame) and --from (ball position). "
                 "Run with --grid <frame> to pick coordinates by eye.")

    start = parse_point(args.start, W, H)
    if args.to:
        end = parse_point(args.to, W, H)
    elif args.direction:
        if args.direction not in DIRECTIONS:
            sys.exit(f"--direction must be one of {sorted(DIRECTIONS)}")
        dx, dy = DIRECTIONS[args.direction]
        end = (start[0] + dx * args.distance * W,
               start[1] + dy * args.distance * W)
    else:
        sys.exit("Need either --to or --direction.")

    path = bezier(start, end, args.arc)
    color = parse_color(args.color)
    width = args.width if args.width else max(2.0, W * 0.005)
    reveal = max(1, int(round(args.duration * fps)))

    cmd = ["ffmpeg", "-y", "-loglevel", "error",
           "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}",
           "-r", f"{fps}", "-i", "-"]
    if not args.no_audio:
        cmd += ["-i", args.video]
    cmd += ["-map", "0:v:0"]
    if not args.no_audio:
        cmd += ["-map", "1:a:0?", "-c:a", "aac", "-b:a", "160k"]
    cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", "18",
            "-pix_fmt", "yuv420p",
            "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", args.out]
    enc = subprocess.Popen(cmd, stdin=subprocess.PIPE)

    cap = cv2.VideoCapture(args.video)
    idx, written, final = 0, 0, None
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx >= args.at:
            t = min(1.0, (idx - args.at + 1) / reveal)
            cut = max(2, int(round(t * len(path))))
            drawn = draw_polyline(frame.copy(), path[:cut], color, width,
                                  args.glow, not args.no_taper,
                                  head=not args.no_head and t < 1.0)
            if args.fade_in > 0:
                a = min(1.0, (idx - args.at + 1) / max(1, args.fade_in * fps))
                frame = cv2.addWeighted(frame, 1 - a, drawn, a, 0)
            else:
                frame = drawn
        enc.stdin.write(frame.tobytes())
        written += 1
        final = frame
        idx += 1
    cap.release()

    if final is not None and args.hold > 0:
        for _ in range(int(args.hold * fps)):
            enc.stdin.write(final.tobytes())
            written += 1

    enc.stdin.close()
    rc = enc.wait()
    if rc != 0:
        sys.exit(f"ffmpeg failed with code {rc}")

    print(json.dumps({"ok": True, "out": os.path.abspath(args.out),
                      "contact_frame": args.at,
                      "reveal_frames": reveal,
                      "from": [round(v) for v in start],
                      "to": [round(v) for v in end],
                      "frames": written,
                      "duration_sec": round(written / fps, 2)}, indent=1))


if __name__ == "__main__":
    main()
