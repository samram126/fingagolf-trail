# Changelog

## 2.0.0
- Several clips at once: tap the ball in each, they're traced one after
  another, then checked and exported together (one MP4 each plus a zip).
- One tap per clip: the landing is found automatically. The tap can be on
  any frame before the shot.
- Much harder to fool: the player is masked out, skin-coloured blobs are
  penalised, the ball must leave the tee at a speed that carries on, mid-air
  stops and swerves end the path, and moving blobs count for more than ones
  drifting about. Analysis at 720 px instead of 480.
- Rolls are followed by the ball's look to where they stop or drop in.
- "End the trail here", and fixes past the end extend the trail.

## 1.1.0
- Careful mode: every frame is re-checked at full resolution, the trail is
  re-solved with what it finds, and frames where the ball was hard to see get
  a wider search. Anything still uncertain is listed with buttons that jump to
  those frames.
- Faster image filtering.

## 1.0.0
- First version: two-tap tracing, frame fixes, trail colour and thickness,
  trim to the shot, MP4 export with sound, rotation metadata handled.
