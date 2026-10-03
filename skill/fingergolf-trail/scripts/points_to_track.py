#!/usr/bin/env python3
"""Build a track from ball positions picked by hand, frame by frame.

Automatic tracking loses badly in a cluttered room: a shelf full of toys throws
off dozens of compact bright blobs per frame and the ball is rarely the most
ball-looking thing in shot. When that happens, read the ball's position off the
frames yourself and pass the points here. The result is a normal track file, so
`render_trail.py` draws it exactly as it draws an automatic one — and unlike a
guessed path it follows where the ball really went.

Points are `frame:x,y`, in any order. Frames in between are filled in, so only
the frames where the ball is clearly visible need to be given.
"""

import argparse
import json
import os
import subprocess
import sys


def probe(path):
    """Dimensions must come from a decoded frame, never from the container.

    A clip carrying rotation metadata is stored one way and displayed the
    other: ffprobe reports the stored 1088x1920 while the decoder hands back a
    rotated 1920x1088. Feeding the stored size to a raw-video encoder is not a
    loud failure — the byte count per frame is identical, so it is accepted and
    every row lands in the wrong place, which looks like bars and judder rather
    than an error.
    """
    import cv2
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    ok, frame = cap.read()
    cap.release()
    if not ok:
        raise SystemExit(f"Could not read a frame from {path}")
    return float(fps), int(frame.shape[1]), int(frame.shape[0])


def parse_points(items):
    pts = []
    for raw in items:
        try:
            frame, coords = raw.split(":")
            x, y = coords.split(",")
            pts.append((int(frame), float(x), float(y)))
        except ValueError:
            sys.exit(f"Could not read point '{raw}'. Use frame:x,y "
                     "(e.g. 159:455,1384)")
    pts.sort()
    return pts


def fit_curve(pts, degree):
    """Replace the measured points with a least-squares polynomial through
    them, sampled once per frame.

    Tracked positions jitter by a few pixels — a motion-blurred ball has no
    crisp centre, and the match lands wherever the blur is brightest. Joining
    those dots draws a visibly wobbly line. A ball in flight follows a
    parabola, so fitting one and drawing that is both smoother and closer to
    where the ball actually was than the raw measurements are.

    Degree 2 suits a clean flight. Raise it for a shot that lands and rolls,
    where a single parabola cannot describe the whole path.
    """
    import numpy as np
    t = np.array([p[0] for p in pts], dtype=float)
    x = np.array([p[1] for p in pts], dtype=float)
    y = np.array([p[2] for p in pts], dtype=float)
    deg = min(degree, max(1, len(pts) - 1))
    cx = np.polyfit(t, x, deg)
    cy = np.polyfit(t, y, deg)
    rms = float(np.sqrt((((np.polyval(cx, t) - x) ** 2 +
                          (np.polyval(cy, t) - y) ** 2)).mean()))
    frames = list(range(int(t.min()), int(t.max()) + 1))
    out = [{"frame": f,
            "x": float(np.polyval(cx, f)),
            "y": float(np.polyval(cy, f)),
            "detected": f in set(int(v) for v in t)}
           for f in frames]
    return out, rms


def interpolate(pts):
    out = []
    for i, (f, x, y) in enumerate(pts):
        out.append({"frame": f, "x": x, "y": y, "detected": True})
        if i + 1 < len(pts):
            nf, nx, ny = pts[i + 1]
            for g in range(f + 1, nf):
                t = (g - f) / (nf - f)
                out.append({"frame": g,
                            "x": x + (nx - x) * t,
                            "y": y + (ny - y) * t,
                            "detected": False})
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument("video")
    p.add_argument("--out", default="track.json")
    p.add_argument("--points", nargs="*", default=[],
                   help="Positions as frame:x,y — e.g. 159:455,1384 163:562,812")
    p.add_argument("--fit", type=int, default=0, metavar="DEGREE",
                   help="Fit a polynomial of this degree through the points "
                        "and draw that instead of joining them. 2 for a clean "
                        "flight, 3 if it lands and rolls. 0 disables.")
    p.add_argument("--points-file", default=None,
                   help="File with one frame:x,y per line. Blank lines and "
                        "lines starting with # are ignored.")
    args = p.parse_args()

    items = list(args.points)
    if args.points_file:
        with open(args.points_file) as f:
            items += [ln.strip() for ln in f
                      if ln.strip() and not ln.startswith("#")]
    if len(items) < 2:
        sys.exit("Need at least two points.")

    pts = parse_points(items)
    rms = None
    if args.fit:
        track, rms = fit_curve(pts, args.fit)
    else:
        track = interpolate(pts)
    fps, w, h = probe(args.video)

    data = {"ok": True,
            "source": os.path.abspath(args.video),
            "normalized": os.path.abspath(args.video),
            "fps": fps, "width": w, "height": h,
            "frame_offset": 0,
            "detections": len(pts),
            "span": len(track),
            "hand_placed": True,
            "points": track}
    with open(args.out, "w") as f:
        json.dump(data, f, indent=1)

    print(json.dumps({"ok": True, "track": os.path.abspath(args.out),
                      "fit_rms_px": None if rms is None else round(rms, 1),
                      "given_points": len(pts),
                      "filled_to": len(track),
                      "first_frame": track[0]["frame"],
                      "last_frame": track[-1]["frame"]}, indent=1))


if __name__ == "__main__":
    main()
