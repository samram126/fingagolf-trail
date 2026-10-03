#!/usr/bin/env python3
"""Find the exact frame the ball is struck, by watching where it sits.

Guessing the strike from motion peaks or from a contact sheet is unreliable and
costs more time than anything else in this workflow. On one clip the strike was
80 frames from where a motion-based guess put it, and every search seeded from
that guess failed.

The ball is stationary for a long stretch before the shot, so score its rest
patch against itself in every frame. The score sits near 1.0 while the ball is
there and collapses the moment it leaves. The end of the longest continuous
run of high scores is the strike.

Watch for two things in the output:

- A short run means the supplied position is not the ball — most often the club
  head resting beside it, which moves in and out of the patch.
- A score that stays high to the last frame means the ball was never struck
  inside the recording, or it is a different ball left sitting on the mat.
"""

import argparse
import json
import sys

import cv2
import numpy as np


def main():
    p = argparse.ArgumentParser()
    p.add_argument("video")
    p.add_argument("--at", type=int, required=True,
                   help="A frame where the ball is clearly at rest.")
    p.add_argument("--from", dest="pos", required=True,
                   help="'x,y' of the ball in that frame.")
    p.add_argument("--radius", type=int, default=24)
    p.add_argument("--present", type=float, default=0.75,
                   help="Score above which the ball counts as still there.")
    p.add_argument("--verbose", action="store_true")
    args = p.parse_args()

    x, y = (int(float(v)) for v in args.pos.split(","))
    R = args.radius

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        sys.exit(f"Could not open {args.video}")
    frames = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        frames.append(f[max(0, y - R):y + R, max(0, x - R):x + R].copy())
    cap.release()
    if args.at >= len(frames):
        sys.exit(f"Frame {args.at} beyond end ({len(frames)} frames).")

    tmpl = frames[args.at]
    scores = []
    for patch in frames:
        if patch.shape != tmpl.shape or patch.size == 0:
            scores.append(0.0)
        else:
            scores.append(float(cv2.matchTemplate(
                patch, tmpl, cv2.TM_CCOEFF_NORMED).max()))
    s = np.array(scores)
    present = s > args.present

    best_len, best_end, cur = 0, None, 0
    for i, b in enumerate(present):
        cur = cur + 1 if b else 0
        if cur > best_len:
            best_len, best_end = cur, i

    if args.verbose:
        for i, v in enumerate(scores):
            print(f"{i} {v:.2f}{' *' if present[i] else ''}")

    idxs = np.where(present)[0]
    never_left = best_end is not None and best_end >= len(frames) - 3
    print(json.dumps({
        "ok": best_end is not None,
        "frames": len(frames),
        "strike_frame": best_end,
        "run_length": best_len,
        "present_from": int(idxs.min()) if len(idxs) else None,
        "present_to": int(idxs.max()) if len(idxs) else None,
        "warning": ("run is short — the position is probably not the ball"
                    if best_len < 10 else
                    "ball still present at the end — no strike in this clip"
                    if never_left else None),
    }, indent=1))


if __name__ == "__main__":
    main()
