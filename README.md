# Fingagolf Trail

Draw a shot-tracer trail on finger golf clips, right in the browser.
Videos never leave the device: decoding, tracking and encoding all run locally.

## How it works

1. Pick a clip and tap the ball sitting at address.
2. Step to the frame where it first lands (or drops in the cup) and tap it.
3. The ball is found in every frame between those two points with
   consecutive-frame differencing, and the most physical path through the
   candidates is chosen with dynamic programming. The tee is part of the
   search, so the moment the ball leaves is decided by the solver too.
4. **Careful mode** (always on): every frame of that first trail is looked at
   again at full resolution, the path is solved again with those detections,
   and each frame is checked for a ball under the line. Where it isn't found,
   a wider window is searched and the path re-solved (twice). Frames that are
   still uncertain are listed so the person can look at them.
5. Check it. If the line comes off the ball anywhere, stop on that frame,
   press **Fix this frame**, tap the ball, and the path is re-solved through it.
6. **Make the video** renders every frame with the trail and keeps the sound.

## Files

- `docs/core.js` — tracking: candidates, tee presence, path solver, smoothing.
  No DOM, so the tests run it in Node.
- `docs/app.js` — the page: taps, preview, analysis loop, MP4 export.
- `docs/vendor/mediabunny.min.mjs` — [Mediabunny](https://mediabunny.dev)
  (MPL-2.0, unmodified) for WebCodecs decoding and MP4 muxing.
- `test/run.mjs` — replays clips with known ball positions using only the two
  taps and reports the error. `test/ui_test.py` drives the real page in
  headless Chromium.

## Accuracy

On 37 hand-checked clips (flights, rolls, shots toward the camera), 35 trace
correctly from the two taps alone (90% of frames within 40 px at 1440x2560,
median error 2 px). The two that don't — the ball hidden under the finger at a
flick, and a ball passing in front of the player's face — are both flagged by
the self-check at the frames that are wrong, and two hand fixes put them right.
30 of the 35 good clips come back with nothing to check.

Tests: `node test/run3.mjs` (careful mode on all clips, with what it flags),
`node test/run.mjs` (first pass only).

## Deploy

Static site in `docs/`. GitHub Pages serves it from the `main` branch,
`/docs` folder, so every push to `main` updates the live site. (`netlify.toml`
points Netlify at the same folder if it's ever hosted there instead.)

## Releasing an update

Bump the version in four places so returning visitors don't mix cached old
files with new ones: `VERSION` in `docs/app.js`, the `core.js?v=` import in
`docs/app.js`, and the `app.js?v=` / `style.css?v=` links in `docs/index.html`.
Add a line to `CHANGELOG.md`. Pushing to `main` publishes.
