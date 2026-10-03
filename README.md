# Fingagolf Trail

Draw a shot-tracer trail on finger golf clips, right in the browser.
Videos never leave the device: decoding, tracking and encoding all run locally.

## How it works

1. Pick one clip or a batch. Tap the ball sitting at address in each — that's
   the only tap. (Any frame before the shot will do.)
2. A cheap scan of the tee area finds when the ball leaves. Around that moment
   every frame is analysed at 720 px in colour: ball candidates come from
   consecutive-frame differencing, with the player masked out (small blobs
   inside large moving regions) and skin-coloured blobs penalised against the
   ball's colour from the tap. If the ball at address is too faint to watch
   (tiny, or white on a white rug), a longer stretch is searched, the colour
   comes from the room's white near the tee, and the hit is found from the
   motion: each place where something leaves the tap point in a steady
   straight line is traced and judged, and the first real flight wins.
3. A dynamic-programming solver picks the most physical path from the tee:
   the ball must leave in a straight line at a speed that carries on, no
   impossible stops or swerves in the air, and frames are worth more when the
   ball travels (a drifting arm or shirt barely moves). The trail ends at the
   first landing — a bounce, or the ball coming down and then lost.
4. **Careful mode**: every frame is looked at again at full resolution around
   the line, the path is re-solved, each frame is checked for a ball under the
   line, a wider window is searched where it isn't (twice), and a slow roll is
   followed by its look (template matching) to where it stops or drops in.
5. Check each clip. Frames still uncertain are listed. **Fix this frame** pins
   the ball (a fix past the end extends the trail); **End the trail here**
   shortens it.
6. **Make the videos**: every frame rendered with the trail, sound kept,
   one MP4 per clip and a zip of all of them.

## Files

- `docs/core.js` — tracking: candidates, tee presence, path solver, smoothing.
  No DOM, so the tests run it in Node.
- `docs/app.js` — the page: taps, preview, analysis loop, MP4 export.
- `docs/vendor/mediabunny.min.mjs` — [Mediabunny](https://mediabunny.dev)
  (MPL-2.0, unmodified) for WebCodecs decoding and MP4 muxing.
- `test/pipeline.mjs` — the page's whole tracing pipeline outside the
  browser (ffmpeg decoding), so tests run exactly what the page runs.
  `test/sim.mjs` traces one clip, `test/eval.mjs` every hand-checked clip.
  `test/ui_batch.py` drives the real page in headless Chromium.

## Accuracy

On 49 hand-checked clips (flights, rolls, chips, head-on shots, flights that
leave the picture, white balls on a white rug), one tap gives a correct trail
on 44: 90% of frames within 40 px at 1440x2560 (median 2-3 px) and the end at
the landing. The misses: a ball hidden under the finger at a flick, and four
rolls whose trail ends a few frames early or late (one "End the trail here"
or one fix each). Tapping on the first frame instead of just before the shot
gives the same results.

Tests: `TAPBACK=8 node test/eval.mjs` (single tap 8 frames before the hit,
careful mode, all clips — needs the original videos; `TAPBACK=100` for an
early tap), `node test/sim.mjs clip.mp4 frame x y` (one clip),
`python3 test/ui_batch.py shots clip.webm:points.txt ...` (the real page in
headless Chromium: several clips, taps, trace, end-here, export, zip).

## Deploy

Static site in `docs/`. GitHub Pages serves it from the `main` branch,
`/docs` folder, so every push to `main` updates the live site. (`netlify.toml`
points Netlify at the same folder if it's ever hosted there instead.)

## Releasing an update

Bump the version in five places so returning visitors don't mix cached old
files with new ones: `VERSION` in `docs/app.js`, the `core.js?v=` and `zip.js?v=` imports in
`docs/app.js`, and the `app.js?v=` / `style.css?v=` links in `docs/index.html`.
Add a line to `CHANGELOG.md`. Pushing to `main` publishes.
