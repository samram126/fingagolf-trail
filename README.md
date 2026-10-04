# Fingagolf Skills

Two Claude skills for finger golf videos:

- **Fingagolf Trail** draws a red shot-tracer trail on a clip. Send Claude a
  clip, it tracks the ball frame by frame, checks the trail sits on the ball,
  and sends back the video with the flight drawn on, trimmed to the shot.
- **Fingagolf Shorts** turns a round filmed one clip per shot into vertical
  YouTube Shorts with a scoreboard, result pop-ups, drop tags and a title.

**Download and install:** https://samram126.github.io/fingagolf-trail/

## Install

1. claude.ai → Settings → Capabilities → turn on **Code execution and file
   creation**.
2. Customize → Skills → **+** → Create skill → **Upload a skill** → pick
   `fingergolf-trail.zip` or `fingagolf-shorts.zip` (don't unzip it).
3. New chat, attach a clip and ask for a trail, or attach a round's clips and
   ask for shorts.

## Files

- `skill/fingergolf-trail/` — the skill: `SKILL.md` (how Claude does it) and
  `scripts/` (ball finding, tracking, rendering; Python with OpenCV, NumPy and
  ffmpeg, all available in Claude's code execution).
- `skill/fingagolf-shorts/` — the Shorts skill: `SKILL.md` with its build
  script (`make_shorts.py`) inside, written out by Claude at run time.
- `docs/*.zip` — each skill folder zipped, served by the download page in
  `docs/index.html` (GitHub Pages, `main` branch, `/docs`).

The earlier in-browser website (tracking without Claude) is kept on the
`website` branch.

## Releasing an update

1. Update the skill's folder under `skill/`.
2. Rebuild its zip from inside `skill/`, e.g.
   `rm -f ../docs/fingergolf-trail.zip && zip -qr -X ../docs/fingergolf-trail.zip fingergolf-trail -x '*/__pycache__/*'`
   (same for `fingagolf-shorts`).
3. Bump that skill's version line and "What's new" in `docs/index.html`, and
   add an entry to `CHANGELOG.md`.
4. Push to `main`; the page updates within a few minutes.
