#!/usr/bin/env python3
"""Find the shot in a clip and check whether the ball was actually photographed
in flight.

Run this when tracking fails or returns something implausible. The most common
reason a trail can't be made is not a tuning problem: if the ball is struck hard
and is close to the lens, it can cross the entire frame in less than one frame
interval, leaving zero images of it in flight. Nothing can trace a ball that was
never photographed. This tells you that quickly instead of leaving you tuning
thresholds against footage that has no signal in it.

Writes a scrub contact sheet across the whole clip and a frame-by-frame sheet
around the moment of peak motion. Look at both.
"""

import argparse
import os
import sys

import cv2
import numpy as np


def label(img, text, color=(0, 255, 255)):
    cv2.putText(img, text, (6, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2)
    return img


def sheet(tiles, per_row, path):
    if not tiles:
        return
    rows = [np.hstack(tiles[i:i + per_row])
            for i in range(0, len(tiles), per_row)]
    w = max(r.shape[1] for r in rows)
    rows = [np.pad(r, ((0, 0), (0, w - r.shape[1]), (0, 0)))
            if r.shape[1] < w else r for r in rows]
    cv2.imwrite(path, np.vstack(rows))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("video")
    p.add_argument("--scrub", default="scrub.png")
    p.add_argument("--strike", default="strike.png")
    p.add_argument("--threshold", type=int, default=25)
    p.add_argument("--window", type=int, default=12,
                   help="Frames either side of peak motion to show.")
    args = p.parse_args()

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        sys.exit(f"Could not open video: {args.video}")

    smalls = []
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        smalls.append(cv2.resize(frame, (270, 480)))
    cap.release()
    n = len(smalls)
    if n == 0:
        sys.exit("No frames.")

    gray = [cv2.GaussianBlur(cv2.cvtColor(s, cv2.COLOR_BGR2GRAY), (5, 5), 0)
            for s in smalls]
    idx = np.linspace(0, n - 1, min(n, 60)).astype(int)
    bg = np.median(np.stack([gray[i] for i in idx]), axis=0).astype(np.uint8)

    energy = []
    for g in gray:
        d = cv2.absdiff(g, bg)
        energy.append(int((d > args.threshold).sum()))
    energy = np.array(energy, dtype=float)

    # A hand reaching in to place the ball moves far more pixels than the ball
    # ever does, so the single largest peak is usually not the shot. Report
    # several separate motion events instead and let the eye decide.
    busy = energy > max(energy.max() * 0.10, energy.mean() * 1.5)
    events, run = [], None
    for i, b in enumerate(busy):
        if b and run is None:
            run = i
        elif not b and run is not None:
            events.append((run, i - 1))
            run = None
    if run is not None:
        events.append((run, len(busy) - 1))
    events = [e for e in events if e[1] - e[0] >= 1]
    events.sort(key=lambda e: -energy[e[0]:e[1] + 1].sum())
    events = events[:5]

    step = max(1, n // 14)
    sheet([label(smalls[i].copy(), str(i)) for i in range(0, n, step)],
          7, args.scrub)

    base, ext = os.path.splitext(args.strike)
    written = []
    for k, (a, b) in enumerate(sorted(events), 1):
        lo = max(0, a - args.window // 2)
        hi = min(n - 1, b + args.window)
        tiles = [label(smalls[i].copy(), str(i), (0, 0, 255))
                 for i in range(lo, hi + 1)]
        out = f"{base}_{k}{ext}"
        sheet(tiles[:30], 5, out)
        written.append((out, lo, hi))

    print(f"frames: {n}")
    print(f"motion events (candidates for the shot): "
          f"{[f'{a}-{b}' for a, b in sorted(events)]}")
    print(f"\nwrote {os.path.abspath(args.scrub)} (whole clip)")
    for out, lo, hi in written:
        print(f"wrote {os.path.abspath(out)} (frames {lo}-{hi})")
    print("\nOne of these events is the ball being placed by hand; another is "
          "the strike.\nThese are lofted shots: the ball climbs and often "
          "leaves through the TOP of\nthe frame, so check the upper half and "
          "the frames well after contact, where\nit falls back into view. "
          "Count frames where the ball is visible and clear\nof the club:\n"
          "  3 or more  -> tracking should work\n"
          "  1-2        -> too fast for this frame rate; reshoot in slo-mo\n"
          "  0          -> the ball left the frame between exposures; no trail "
          "is possible\n               from this clip, and no amount of tuning "
          "will change that")


if __name__ == "__main__":
    main()
