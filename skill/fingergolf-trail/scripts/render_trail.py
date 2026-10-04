#!/usr/bin/env python3
"""Draw a persistent trail along a tracked ball path and encode a new video.

The trail accumulates: once the ball has passed through a point, that point
stays lit for the rest of the clip, so the finished shot shows the whole arc.
Frames are piped straight to ffmpeg so the output is H.264/yuv420p and plays
anywhere (phones, social, browsers) rather than OpenCV's fussier defaults.
"""

import argparse
import json
import math
import os
import subprocess
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from trailstyle import NAMED, THICKNESS, line_width, parse_color  # noqa: E402,F401


def reject_outliers(points, tol=3.5, min_px=9.0, passes=2):
    """Drop tracked points that cannot be where the ball was.

    A smoothing filter cannot rescue a bad point — it spreads the error into
    its neighbours, and a spline drawn through one swings out into a hook. The
    hooks and S-bends that show up at the apex are exactly this: the ball is
    slowest there, so the matcher is most likely to grab a neighbouring feature
    for a frame or two.

    For each point, fit a quadratic to its neighbours *excluding itself* and
    measure how far it sits from that prediction. Scale is set by the median
    absolute deviation of all residuals, so the test adapts to a jittery track
    without throwing away honest curvature; `min_px` keeps it from trimming a
    clean track where the residuals are all tiny.
    """
    pts = list(points)
    for _ in range(passes):
        n = len(pts)
        if n < 7:
            break
        f = np.array([p["frame"] for p in pts], dtype=float)
        x = np.array([p["x"] for p in pts], dtype=float)
        y = np.array([p["y"] for p in pts], dtype=float)
        resid = np.zeros(n)
        half = 4
        for i in range(n):
            lo, hi = max(0, i - half), min(n, i + half + 1)
            idx = [j for j in range(lo, hi) if j != i]
            if len(idx) < 4:
                continue
            deg = 2 if len(idx) >= 5 else 1
            try:
                px = np.polyval(np.polyfit(f[idx], x[idx], deg), f[i])
                py = np.polyval(np.polyfit(f[idx], y[idx], deg), f[i])
            except Exception:
                continue
            resid[i] = math.hypot(x[i] - px, y[i] - py)
        # Scale the test to how far the ball moves locally. A fixed cut fails
        # at both ends of the same track: during launch the ball covers a
        # couple of hundred px per frame, so an honest point sits far from any
        # local fit and the whole launch gets thrown away, while near the apex
        # a genuinely bad point moves only a few px and slips through.
        step = np.zeros(n)
        for i in range(n):
            lo, hi = max(0, i - 3), min(n, i + 4)
            d = [math.hypot(x[j + 1] - x[j], y[j + 1] - y[j])
                 for j in range(lo, min(hi, n - 1))]
            step[i] = float(np.median(d)) if d else 0.0
        keep = [p for p, r, st in zip(pts, resid, step)
                if r <= max(min_px, tol * max(st, 1.0))]
        # never strip the endpoints: impact and landing are anchors
        if keep and keep[0] is not pts[0]:
            keep.insert(0, pts[0])
        if keep and keep[-1] is not pts[-1]:
            keep.append(pts[-1])
        if len(keep) == len(pts) or len(keep) < 6:
            break
        pts = keep
    return pts


def reject_kinks(points, max_turn=38.0, min_step=12.0):
    """Drop points that make the path double back on itself.

    A ball in flight turns gradually — a few degrees per frame, even through
    the apex, where the reversal is spread over many frames. A single-frame
    turn of 90 degrees or more is never the ball; it is the tracker having
    jumped to something else and back.

    The local-fit test alone misses these: when two or three bad points sit
    together, the fit follows them and their residuals look small. Measuring
    the turn angle directly catches them however they cluster.

    Only segments longer than `min_step` are tested. Near the apex the ball
    moves three or four pixels a frame, so its direction genuinely swings by
    tens of degrees between measurements — real, and far too small to see. A
    kink is only visible when the segments meeting at it are long, and those
    are exactly the ones this catches.
    """
    pts = list(points)
    for _ in range(40):
        n = len(pts)
        if n < 5:
            break
        x = [p["x"] for p in pts]
        y = [p["y"] for p in pts]
        worst, worst_i = 0.0, None
        for i in range(1, n - 1):
            ax, ay = x[i] - x[i - 1], y[i] - y[i - 1]
            bx, by = x[i + 1] - x[i], y[i + 1] - y[i]
            na, nb = math.hypot(ax, ay), math.hypot(bx, by)
            if na < min_step or nb < min_step:
                continue
            c = max(-1.0, min(1.0, (ax * bx + ay * by) / (na * nb)))
            ang = math.degrees(math.acos(c))
            if ang > worst:
                worst, worst_i = ang, i
        if worst_i is None or worst <= max_turn:
            break
        pts.pop(worst_i)
    return pts


def reject_unphysical(points, tol=45.0, half=5, passes=3):
    """Drop points a ball could not have been at, judged locally.

    Free flight means constant acceleration, so over a short window the path is
    a parabola in time. Fit one to each point's NEIGHBOURS and measure how far
    the point sits from it. Judging locally rather than over the whole flight
    matters: with a wide lens the ball's image path is only parabolic in
    stretches, so a single global fit rejects honest points at the ends.

    This replaces fitting one rigid curve to the whole shot. That produced a
    perfectly smooth trail whose head was up to 500px from the actual ball —
    smooth, but visibly lagging the shot and then catching up. Cleaning the
    points and then following them keeps the head on the ball.
    """
    pts = list(points)
    for _ in range(passes):
        n = len(pts)
        if n < 2 * half + 3:
            break
        t = np.array([p["frame"] for p in pts], dtype=float)
        x = np.array([p["x"] for p in pts], dtype=float)
        y = np.array([p["y"] for p in pts], dtype=float)
        bad = []
        for i in range(n):
            lo, hi = max(0, i - half), min(n, i + half + 1)
            idx = [j for j in range(lo, hi) if j != i]
            if len(idx) < 5:
                continue
            try:
                px = np.polyval(np.polyfit(t[idx], x[idx], 2), t[i])
                py = np.polyval(np.polyfit(t[idx], y[idx], 2), t[i])
            except Exception:
                continue
            if math.hypot(x[i] - px, y[i] - py) > tol:
                bad.append(i)
        # never drop the anchors
        bad = [i for i in bad if i not in (0, n - 1)]
        if not bad or len(pts) - len(bad) < 8:
            break
        pts = [p for i, p in enumerate(pts) if i not in set(bad)]
    return pts


def physical_run(t, x, y, max_rms=14.0, min_n=8):
    """Longest stretch of points consistent with constant acceleration.

    A ball in free flight has one force on it, so its image-space path is very
    close to a parabola in time over a short flight. Anything that is not — a
    stretch where the tracker was on the club, a shirt, or the blur at contact
    — cannot be fitted by one, and shows up as a huge residual.

    This is a far stronger test than smoothness. A wandering track can be
    perfectly smooth after filtering and still be an impossible flight: on two
    clips here a parabola missed the tracked path by over 400px, which is why
    those trails still read as wrong however carefully they were smoothed.
    """
    n = len(t)
    best = (0, None, None)
    for i in range(n - min_n + 1):
        for j in range(n, i + min_n - 1, -1):
            if j - i <= best[0]:
                break
            tt, xx, yy = t[i:j], x[i:j], y[i:j]
            if len(tt) < 4:
                continue
            try:
                cx = np.polyfit(tt, xx, 2)
                cy = np.polyfit(tt, yy, 2)
            except Exception:
                continue
            r = np.sqrt((xx - np.polyval(cx, tt)) ** 2 +
                        (yy - np.polyval(cy, tt)) ** 2)
            if float(np.sqrt((r ** 2).mean())) <= max_rms:
                best = (j - i, i, j)
                break
    return best


def physics_curve(points, degree=3):
    """Draw the flight as a polynomial through its physically valid part.

    Smoothing a bad path only produces a smooth bad path. Fitting instead means
    the drawn curve cannot wiggle at all — a cubic has no room to — while still
    passing through the measured impact point, which is weighted so the trail
    starts exactly where the ball was struck.

    Returns None when no usable run exists, so the caller can fall back.
    """
    if len(points) < 10:
        return None
    t = np.array([p["frame"] for p in points], dtype=float)
    x = np.array([p["x"] for p in points], dtype=float)
    y = np.array([p["y"] for p in points], dtype=float)
    ln, i, j = physical_run(t, x, y)
    if i is None or ln < 8:
        return None

    tt = np.concatenate(([t[0]], t[i:j], [t[-1]]))
    xx = np.concatenate(([x[0]], x[i:j], [x[-1]]))
    yy = np.concatenate(([y[0]], y[i:j], [y[-1]]))
    w = np.ones(len(tt))
    w[0] = w[-1] = 8.0
    deg = min(degree, len(tt) - 1)
    try:
        cx = np.polyfit(tt, xx, deg, w=w)
        cy = np.polyfit(tt, yy, deg, w=w)
    except Exception:
        return None

    dense = np.linspace(t[0], t[-1], max(2, int((t[-1] - t[0]) * 6)))
    px, py = np.polyval(cx, dense), np.polyval(cy, dense)
    n = len(px)
    blend = max(2, int(n * 0.10))
    dx0, dy0 = x[0] - px[0], y[0] - py[0]
    dx1, dy1 = x[-1] - px[n - 1], y[-1] - py[n - 1]
    for q in range(blend):
        f = 1.0 - q / blend
        px[q] += dx0 * f
        py[q] += dy0 * f
        px[n - 1 - q] += dx1 * f
        py[n - 1 - q] += dy1 * f
    return [{"frame": float(f), "x": float(a), "y": float(b)}
            for f, a, b in zip(dense, px, py)]


def smooth(points, window, noise_px=4.0):
    """Fit a smoothing spline through the track and sample it densely.

    The earlier approach — filter the points, then run an INTERPOLATING spline
    through them — cannot work, because an interpolating spline is required to
    pass through every point it is given, noise included. Each mis-measured
    pixel becomes a real wiggle in the drawn curve, and between sparse knots a
    cubic overshoots and rings, which is where the notches near the apex came
    from. Measuring turn angles on the input points misses all of this: the
    input can look clean while the drawn curve does not.

    A smoothing spline is the right tool. It passes NEAR the measurements
    rather than through them, with the slack set by how much error a
    measurement is expected to carry — a few pixels, since a motion-blurred
    ball has no exact centre. The result is one continuous arc with no
    knot-to-knot ringing.

    Impact and landing are anchors, but forcing the fit through them by
    weighting those two points heavily makes the spline bend hard to reach
    them and overshoot just inside — a small hook right at the launch. Fit
    with uniform weights instead and ease the finished curve onto each anchor
    over its first and last few samples.
    """
    if len(points) < 4:
        return points
    fr = np.array([p["frame"] for p in points], dtype=float)
    xs = np.array([p["x"] for p in points], dtype=float)
    ys = np.array([p["y"] for p in points], dtype=float)

    order = np.argsort(fr)
    fr, xs, ys = fr[order], xs[order], ys[order]
    uniq = np.concatenate(([True], np.diff(fr) > 0))
    fr, xs, ys = fr[uniq], xs[uniq], ys[uniq]

    # Also drop repeats of the same POSITION. A matcher that loses the ball
    # often reports the previous pixel again; those stalled duplicates are not
    # evidence the ball stood still, and a spline asked to pass through the
    # same point at two different times wiggles to do it.
    if len(fr) > 3:
        keep = [0]
        for i in range(1, len(fr)):
            if math.hypot(xs[i] - xs[keep[-1]], ys[i] - ys[keep[-1]]) > 0.75:
                keep.append(i)
        if len(keep) >= 4:
            keep = np.array(keep)
            fr, xs, ys = fr[keep], xs[keep], ys[keep]
    if len(fr) < 4:
        return points

    dense = np.linspace(fr[0], fr[-1], max(2, int((fr[-1] - fr[0]) * 6)))
    try:
        from scipy.interpolate import UnivariateSpline
        w = np.full(len(fr), 1.0 / max(noise_px, 0.5))
        # s is the total weighted square error the fit may spend; with these
        # weights that is roughly "noise_px of slack per point".
        s_val = float(len(fr))
        k = 3 if len(fr) > 3 else 2
        sx = UnivariateSpline(fr, xs, w=w, k=k, s=s_val)
        sy = UnivariateSpline(fr, ys, w=w, k=k, s=s_val)
        px, py = sx(dense), sy(dense)
    except Exception:
        px = np.interp(dense, fr, xs)
        py = np.interp(dense, fr, ys)

    # Ease onto the anchors: shift the curve by the endpoint error, fading
    # that shift out over a short run so no corner is introduced.
    n = len(px)
    blend = max(2, int(n * 0.10))
    # Capture the offsets first: correcting px[0] in the loop would zero out
    # the offset every later iteration reads, leaving a step at the blend edge.
    dx0, dy0 = xs[0] - px[0], ys[0] - py[0]
    dx1, dy1 = xs[-1] - px[n - 1], ys[-1] - py[n - 1]
    for i in range(blend):
        t = 1.0 - i / blend
        px[i] += dx0 * t
        py[i] += dy0 * t
        px[n - 1 - i] += dx1 * t
        py[n - 1 - i] += dy1 * t

    return [{"frame": float(f), "x": float(a), "y": float(b)}
            for f, a, b in zip(dense, px, py)]


def draw_trail(frame, pts, color, width, glow, taper, head_core=False):
    """pts: the portion of the arc revealed so far, oldest first.

    Default look is a solid, fully saturated line: no glow, no taper, no white
    core in the head. The glow layer is a Gaussian blur of the line, which is
    exactly what reads as "fuzzy"; the taper makes the line's thickness shift
    as it grows. Both are opt-in now.
    """
    if len(pts) < 2:
        return frame
    coords = np.array([(int(round(p["x"])), int(round(p["y"]))) for p in pts],
                      np.int32)
    n = len(coords) - 1

    if glow > 0:
        layer = np.zeros_like(frame)
        cv2.polylines(layer, [coords], False, color,
                      max(2, int(width * 2.6)), cv2.LINE_AA)
        blur = max(3, int(width * 4) | 1)
        layer = cv2.GaussianBlur(layer, (blur, blur), 0)
        frame = cv2.addWeighted(frame, 1.0, layer, glow, 0)

    if taper:
        for i in range(n):
            t = (i + 1) / n
            thick = max(1, int(round(width * (0.45 + 0.55 * t))))
            cv2.line(frame, tuple(coords[i]), tuple(coords[i + 1]), color,
                     thick, cv2.LINE_AA)
    else:
        # one polyline: uniform thickness and clean joins along the arc
        cv2.polylines(frame, [coords], False, color, max(1, int(width)),
                      cv2.LINE_AA)

    head = tuple(coords[-1])
    cv2.circle(frame, head, max(2, int(width * 0.9)), color, -1, cv2.LINE_AA)
    if head_core:
        cv2.circle(frame, head, max(1, int(width * 0.4)), (255, 255, 255), -1,
                   cv2.LINE_AA)
    return frame


def main():
    p = argparse.ArgumentParser()
    p.add_argument("track", help="track.json from track_ball.py")
    p.add_argument("-o", "--out", default="trail.mp4")
    p.add_argument("--color", default="red",
                   help="Colour name (" + ", ".join(NAMED) + ") or hex like #FF8800.")
    p.add_argument("--thickness", default="medium",
                   help="thin, medium (default), thick or xthick: a share of the frame width.")
    p.add_argument("--width", type=float, default=None,
                   help="Exact line thickness in px (overrides --thickness).")
    p.add_argument("--glow", type=float, default=0.0,
                   help="Soft glow strength. 0 (default) draws a solid line.")
    p.add_argument("--taper", action="store_true",
                   help="Thin at launch, full width at the head.")
    p.add_argument("--no-taper", action="store_true", help=argparse.SUPPRESS)
    p.add_argument("--head-core", action="store_true",
                   help="White dot in the centre of the leading head.")
    p.add_argument("--no-physics", action="store_true",
                   help="Skip the local free-flight check on the points.")
    p.add_argument("--physics-tol", type=float, default=45.0,
                   help="Px a point may sit from the local free-flight curve.")
    p.add_argument("--no-reject", action="store_true",
                   help="Keep every tracked point, outliers included.")
    p.add_argument("--reject-tol", type=float, default=3.5,
                   help="Lower rejects more aggressively.")
    p.add_argument("--max-turn", type=float, default=38.0,
                   help="Degrees of single-frame direction change allowed.")
    p.add_argument("--smooth", type=float, default=4.0, metavar="NOISE_PX",
                   help="How many pixels of error each measurement may carry. "
                        "Higher = smoother curve that follows the points more "
                        "loosely. 4 suits these clips; try 8 for a wobbly "
                        "track, 1.5 to hug the measurements.")
    p.add_argument("--hold", type=float, default=1.2,
                   help="Seconds to freeze on the finished arc at the end.")
    p.add_argument("--trim", action="store_true", default=True,
                   help="Cut the output to the shot: from --lead-in before the "
                        "strike to --tail after the landing (the default).")
    p.add_argument("--full", dest="trim", action="store_false",
                   help="Keep the whole source clip instead of trimming to the shot.")
    p.add_argument("--lead-in", type=float, default=0.6,
                   help="Seconds of footage kept before the strike when trimming.")
    p.add_argument("--tail", type=float, default=None,
                   help="Seconds of footage to keep after the trail's last "
                        "point (default 0.9 when trimming; with --full the "
                        "clip runs to the end of the source).")
    p.add_argument("--no-audio", action="store_true")
    args = p.parse_args()

    with open(args.track) as f:
        data = json.load(f)
    if not data.get("ok") or not data.get("points"):
        sys.exit("Track file has no usable points.")

    src = data.get("normalized") or data["source"]
    fps = float(data["fps"])
    probe_cap = cv2.VideoCapture(src)
    ok_probe, probe_frame = probe_cap.read()
    probe_cap.release()
    if not ok_probe:
        sys.exit(f"Could not read {src}")
    # Trust the decoder, not the track file: with rotation metadata the stored
    # and displayed dimensions are swapped, and a mismatched raw-video size is
    # accepted silently and shears every frame.
    H, W = probe_frame.shape[:2]
    color = parse_color(args.color)
    # A bit thicker than a hairline: phone video stores colour at half
    # resolution (yuv420), so a thin saturated red line gets its edges
    # averaged with the background and reads as washed-out and soft.
    width = line_width(W, args.width, args.thickness)

    pts = data["points"]

    # Keep only measured positions. points_to_track fills gaps with linear
    # interpolation, which makes the path a polygon whose corners sit exactly
    # at the real measurements — so a turn-angle test aimed at bad data
    # deletes the good data instead. The spline below re-fills the gaps with a
    # curve, which is what the interpolated points were standing in for.
    measured = [p for p in pts if p.get("detected", True)]
    if len(measured) >= 5:
        pts = measured
    n_before = len(pts)
    if not args.no_reject:
        pts = reject_outliers(pts, tol=args.reject_tol)
        pts = reject_kinks(pts, max_turn=args.max_turn)
    n_rejected = n_before - len(pts)
    n_unphys = 0
    if not args.no_physics:
        before = len(pts)
        pts = reject_unphysical(pts, tol=args.physics_tol)
        n_unphys = before - len(pts)
    used_physics = n_unphys >= 0
    pts = smooth(pts, 0, noise_px=args.smooth)
    frames_arr = [p["frame"] for p in pts]
    first_f, last_f = frames_arr[0], frames_arr[-1]

    def upto_index(rel):
        """How much of the dense path is revealed by this frame."""
        n = 0
        for i, fv in enumerate(frames_arr):
            if fv <= rel:
                n = i
            else:
                break
        return n

    offset = int(data.get("frame_offset", 0))
    start_out = 0
    if args.trim:
        start_out = max(0, first_f - int(round(args.lead_in * fps)))
        if args.tail is None:
            args.tail = 0.9
    # the source frame the output starts on, and its time: the sound has to
    # be cut from the same moment or the hit is heard before it's seen
    start_src = int(start_out + offset)
    start_sec = start_src / fps

    cmd = ["ffmpeg", "-y", "-loglevel", "error",
           "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}",
           "-r", f"{fps}", "-i", "-"]
    if not args.no_audio:
        if start_sec > 0:
            cmd += ["-ss", f"{start_sec:.3f}"]
        cmd += ["-i", src]
    cmd += ["-map", "0:v:0"]
    if not args.no_audio:
        cmd += ["-map", "1:a:0?", "-c:a", "aac", "-b:a", "160k",
                "-af", "apad", "-shortest"]
    cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", "15",
            "-pix_fmt", "yuv420p",
            "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", args.out]
    enc = subprocess.Popen(cmd, stdin=subprocess.PIPE)

    cap = cv2.VideoCapture(src)
    idx = 0
    written = 0
    final = None
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        rel = idx - offset
        if args.tail is not None and rel > last_f + args.tail * fps:
            break
        if idx >= start_out + offset:
            if rel >= first_f:
                upto = upto_index(min(rel, last_f))
                frame = draw_trail(frame, pts[:upto + 1], color, width,
                                   args.glow, args.taper and not args.no_taper,
                                   head_core=args.head_core)
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
                      "points_rejected": n_rejected,
                      "unphysical_dropped": n_unphys,
                      "frames": written,
                      "duration_sec": round(written / fps, 2),
                      "trimmed": bool(args.trim),
                      "start_frame": start_src,
                      "start_sec": round(start_sec, 3),
                      "color": args.color}, indent=1))


if __name__ == "__main__":
    main()
