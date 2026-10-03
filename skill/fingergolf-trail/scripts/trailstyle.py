"""Shared look-and-feel for the trail, used by both the tracked renderer and
the hand-drawn one, so the two produce an identical-looking streak."""

import cv2
import numpy as np

NAMED = {"white": (255, 255, 255), "yellow": (0, 220, 255),
         "orange": (0, 145, 255), "green": (80, 255, 60),
         "red": (60, 60, 255), "blue": (255, 140, 0),
         "cyan": (255, 255, 40), "pink": (190, 90, 255),
         "lime": (0, 255, 200)}


def parse_color(s):
    if s.lower() in NAMED:
        return NAMED[s.lower()]
    s = s.lstrip("#")
    return (int(s[4:6], 16), int(s[2:4], 16), int(s[0:2], 16))


def draw_polyline(frame, coords, color, width, glow, taper, head=True):
    """coords: the portion of the arc revealed so far, oldest first."""
    if len(coords) < 2:
        return frame
    pts = [(int(round(x)), int(round(y))) for x, y in coords]
    n = len(pts) - 1

    if glow > 0:
        layer = np.zeros_like(frame)
        cv2.polylines(layer, [np.array(pts, np.int32)], False, color,
                      max(2, int(width * 2.6)), cv2.LINE_AA)
        blur = max(3, int(width * 4) | 1)
        layer = cv2.GaussianBlur(layer, (blur, blur), 0)
        frame = cv2.addWeighted(frame, 1.0, layer, glow, 0)

    for i in range(n):
        if taper:
            t = (i + 1) / n
            thick = max(1, int(round(width * (0.45 + 0.55 * t))))
        else:
            thick = max(1, int(width))
        cv2.line(frame, pts[i], pts[i + 1], color, thick, cv2.LINE_AA)

    if head:
        cv2.circle(frame, pts[-1], max(2, int(width * 1.5)), color, -1,
                   cv2.LINE_AA)
        cv2.circle(frame, pts[-1], max(1, int(width * 0.6)), (255, 255, 255),
                   -1, cv2.LINE_AA)
    return frame


def bezier(p0, p1, arc, n=160):
    """Quadratic curve from p0 to p1. `arc` bows the path perpendicular to the
    straight line, as a fraction of its length — positive bows one way,
    negative the other, 0 is dead straight."""
    p0 = np.array(p0, float)
    p1 = np.array(p1, float)
    d = p1 - p0
    perp = np.array([-d[1], d[0]])
    norm = np.linalg.norm(perp)
    if norm > 0:
        perp = perp / norm
    ctrl = (p0 + p1) / 2 + perp * arc * np.linalg.norm(d)
    ts = np.linspace(0, 1, n)[:, None]
    pts = (1 - ts) ** 2 * p0 + 2 * (1 - ts) * ts * ctrl + ts ** 2 * p1
    return [tuple(p) for p in pts]
