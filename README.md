# Fingagolf Trail

A Claude skill that draws a red shot-tracer trail on finger golf clips.
Send Claude a clip, it tracks the ball frame by frame, checks the trail sits
on the ball, and sends back the video with the flight drawn on.

**Download and install:** https://samram126.github.io/fingagolf-trail/

## Install

1. claude.ai → Settings → Capabilities → turn on **Code execution and file
   creation**.
2. Customize → Skills → **+** → Create skill → **Upload a skill** → pick
   `fingergolf-trail.zip` (don't unzip it).
3. New chat, attach a clip, ask for a trail.

## Files

- `skill/fingergolf-trail/` — the skill: `SKILL.md` (how Claude does it) and
  `scripts/` (ball finding, tracking, rendering; Python with OpenCV, NumPy and
  ffmpeg, all available in Claude's code execution).
- `docs/fingergolf-trail.zip` — the same folder zipped, served by the download
  page in `docs/index.html` (GitHub Pages, `main` branch, `/docs`).

The earlier in-browser website (tracking without Claude) is kept on the
`website` branch.

## Releasing an update

1. Update `skill/fingergolf-trail/` with the change.
2. Rebuild the zip from inside `skill/`:
   `rm -f ../docs/fingergolf-trail.zip && zip -qr -X ../docs/fingergolf-trail.zip fingergolf-trail -x '*/__pycache__/*'`
3. Bump the version line and "What's new" in `docs/index.html`, and add an
   entry to `CHANGELOG.md`.
4. Push to `main`; the page updates within a few minutes.
