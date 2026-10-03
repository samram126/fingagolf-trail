"""Shared look-and-feel for the trail, used by both the tracked renderer and
the hand-drawn one, so the two produce an identical-looking streak."""

import cv2
import numpy as np

# Colours the user can ask for by name (OpenCV order: blue, green, red).
NAMED = {"red": (0, 0, 255), "orange": (0, 145, 255),
         "yellow": (0, 220, 255), "gold": (0, 190, 255),
         "lime": (0, 255, 200), "green": (80, 255, 60),
         "cyan": (255, 255, 40), "blue": (255, 140, 0),
         "purple": (255, 60, 160), "pink": (190, 90, 255),
         "magenta": (255, 0, 255), "white": (255, 255, 255),
         "black": (0, 0, 0)}
ALIASES = {"teal": "cyan", "aqua": "cyan", "violet": "purple",
           "hot pink": "pink", "neon green": "lime"}

# Thickness by name, as a fraction of the frame's width. "medium" is the
# default: thinner than about 0.5% loses its colour to phone video's
# half-resolution chroma and looks washed out.
THICKNESS = {"thin": 0.005, "medium": 0.0085, "thick": 0.013,
             "xthick": 0.018}
THICKNESS_ALIASES = {"extra thick": "xthick", "extra-thick": "xthick",
                     "x-thick": "xthick", "fat": "thick", "bold": "thick",
                     "normal": "medium", "default": "medium",
                     "skinny": "thin", "fine": "thin"}


def parse_color(s):
    """A colour name from NAMED, or a hex code like #FF8800 / FF8800 / #F80."""
    key = s.strip().lower()
    key = ALIASES.get(key, key)
    if key in NAMED:
        return NAMED[key]
    h = key.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) == 6 and all(c in "0123456789abcdef" for c in h):
        return (int(h[4:6], 16), int(h[2:4], 16), int(h[0:2], 16))
    raise SystemExit(f"Unknown colour '{s}'. Use one of: "
                     + ", ".join(NAMED) + ", or a hex code like #FF8800.")


def line_width(frame_w, width_px=None, thickness=None, default="medium"):
    """Line thickness in px: an explicit pixel width wins, then a named
    thickness (thin / medium / thick / xthick), then the default."""
    if width_px:
        return float(width_px)
    key = (thickness or default).strip().lower()
    key = THICKNESS_ALIASES.get(key, key)
    if key not in THICKNESS:
        raise SystemExit(f"Unknown thickness '{thickness}'. Use one of: "
                         + ", ".join(THICKNESS) + ", or --width in px.")
    return max(2.0, frame_w * THICKNESS[key])


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
