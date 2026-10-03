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
4. Check it. If the line comes off the ball anywhere, stop on that frame,
   press **Fix this frame**, tap the ball, and the path is re-solved through it.
5. **Make the video** renders every frame with the trail and keeps the sound.

## Files

- `site/core.js` — tracking: candidates, tee presence, path solver, smoothing.
  No DOM, so the tests run it in Node.
- `site/app.js` — the page: taps, preview, analysis loop, MP4 export.
- `site/vendor/mediabunny.min.mjs` — [Mediabunny](https://mediabunny.dev)
  (MPL-2.0, unmodified) for WebCodecs decoding and MP4 muxing.
- `test/run.mjs` — replays clips with known ball positions using only the two
  taps and reports the error. `test/ui_test.py` drives the real page in
  headless Chromium.

## Accuracy

On 37 hand-checked clips (flights, rolls, shots toward the camera), 34 trace
correctly from the two taps alone (90% of frames within 40 px at 1440x2560).
The rest need one or two fixes: the ball hidden under the finger at a flick,
and a ball passing in front of the player's face.

## Deploy

Static site; Netlify publishes `site/` (see `netlify.toml`).
