---
name: fingergolf-trail
description: Adds a glowing shot-tracer trail to a video of a finger golf or mini golf shot — a ball struck into the air on a locked-off camera. Tracks the ball frame by frame and returns a new video with the full arc drawn on. Use this skill whenever the user shares a clip and asks for a trail, tracer, streak, ball path, shot line, or "that thing golf broadcasts do" — and also when they just say "add the effect to this one" about a shot video, even if they never say the word trail.
---

# Finger golf trail

Turn a clip of a shot into a clip with the ball's arc drawn on it, the way a
golf broadcast traces a drive.

## These are shots, not putts

**The ball is always struck into the air.** Assume a lofted shot every time,
unless the user says otherwise in this conversation. It leaves the club fast,
climbs, often exits through the top of the frame entirely, reaches an apex, and
falls back down. It does not roll along the ground.

This one assumption drives everything below. Getting it wrong wastes the most
time, because the failure is silent: search the lower half of the frame, find
nothing, and it looks exactly like footage with no ball in it.

What the flight actually looks like:

- **Launch is violent.** Over 100 px per frame at 30fps is normal, so the ball
  can jump most of the frame height between two exposures and be missing or
  smeared for a few frames right after contact. A gap there is expected — it is
  not evidence the ball is gone.
- **It goes up and out.** Expect it to leave through the top and be absent for
  several frames. Look for its return.
- **The apex is slow.** The ball barely moves for several frames near the top.
  That is the easiest place to find it, and a good place to start a template
  match.
- **The fall is the signature.** Vertical steps grow by a few pixels each
  frame — 12, 17, 22, 27, 32, 40, 45 — because that is gravity. A candidate
  path showing that pattern is the ball. Nothing else in a room does it.
- **Up and down can overlap.** A near-vertical shot comes down close to where
  it launched, so the finished trail may read as one thick line rather than a
  wide arc. That is correct, not a bug — don't "fix" it by bending the path.
- **The ball shrinks and dims** as it flies away from the camera, so brightness
  and size filters tuned on the ball at rest will lose it mid-flight.

Search the **whole frame**, top included, every time. Never conclude a clip has
no flight frames from a cropped view.

## Colour and thickness: the user picks

The trail's colour and thickness are the user's choice. Defaults: **red,
medium**.

Pass them to `render_trail.py` (and `draw_trail.py` in drawn mode) as
`--color '#RRGGBB'` and `--width <px>`, where px = the video's displayed width
(after rotation, see the rotation section) × the share below, rounded.
Hex and `--width` work with every version of the scripts.

| Colour | Hex | | Thickness | Share of width | at 1080 wide | at 1440 wide |
|---|---|---|---|---|---|---|
| red | #FF0000 | | thin | 0.5% | 5 px | 7 px |
| orange | #FF9100 | | medium | 0.85% | 9 px | 12 px |
| yellow | #FFDC00 | | thick | 1.3% | 14 px | 19 px |
| gold | #FFBE00 | | extra thick | 1.8% | 19 px | 26 px |
| lime | #C8FF00 | | | | | |
| green | #3CFF50 | | | | | |
| cyan | #28FFFF | | | | | |
| blue | #008CFF | | | | | |
| purple | #A03CFF | | | | | |
| pink | #FF5ABE | | | | | |
| magenta | #FF00FF | | | | | |
| white | #FFFFFF | | | | | |
| black | #000000 | | | | | |

- **They said it in the request** ("make it blue", "thick yellow trail",
  "#00FFAA"): use it on the first render. Plain words: "thicker" = one step up
  from the current thickness, "thinner" = one step down, "bold"/"fat" =
  thick, "really thick" = extra thick, "skinny"/"fine" = thin, or an exact
  pixel number if they give one. A colour not in the table (teal, violet…) →
  the nearest one, or any hex they give.
- **They didn't say**: don't ask before rendering. Render red/medium, and end
  the reply with one line offering the options, e.g.:
  *Want a different look? Colours: red, orange, yellow, gold, lime, green,
  cyan, blue, purple, pink, magenta, white, black, or any hex code. Thickness:
  thin, medium, thick, extra thick.*
- **They ask for a change afterwards**: re-run only the render on the same
  `track.json` with the new `--color` / `--width`. Never re-track for a look
  change — keep `track.json` around for this.
- **The choice sticks**: once the user picks a look, use it for every later
  clip in the conversation (a whole batch included) until they change it.
- If the chosen colour will be hard to see on that footage (green on a green
  mat, white on a white rug), say so and suggest one that stands out, but
  still render what they asked for.

## Trim every clip to the shot

Every video handed back starts just before the strike and ends just after the
ball lands, whatever the source clip contains: walking up, placing the ball,
practice swings and fetching the ball afterwards all go. In a batch, trim each
clip to its own shot.

- **Start:** 0.6 s before the strike. **End:** 0.9 s after the ball lands, or
  after it stops rolling or drops in. Then the finished trail holds for 1.2 s.
- Always pass `--trim --lead-in 0.6 --tail 0.9` to `render_trail.py`. It cuts
  from the track's first point, so the track must begin at the ball at address
  on the strike frame (anchor it there, as described above). A track that
  starts mid-air would cut the launch off.
- `draw_trail.py` trims the same way around `--at` (0.6 s before contact to
  0.9 s after the line finishes); `--full` turns that off.
- Pick the strike and landing by looking at the frames, not from a motion
  peak — the biggest motion in a clip is often the hand placing the ball.
- The sound is cut from the same moment, so the hit is heard when it's seen.
  The render's JSON output includes `start_sec`. **If it doesn't, the scripts
  are an older copy that trims the picture but not the sound.** Then render
  with `--no-audio` and add the sound back from the right moment:
  `ffmpeg -i trail.mp4 -ss <START> -i <video> -map 0:v -map 1:a? -c:v copy
  -c:a aac -af apad -shortest out.mp4`, where START = (first track frame −
  round(0.6 × fps)) / fps seconds, never below 0. Do the same for an older
  `draw_trail.py` that ignores `--full`/`--lead-in` (cut it with `-ss`/`-t`).
- Keep the whole clip only if the user asks for it (`--full`, or leave out
  `--trim` on an older copy).
- Before handing back, check the trimmed clip's first and last frames: ball
  still at address at the start, ball down at the end.

## Read this first: most failures are the footage, not the settings

A trail can only be drawn through frames where the ball was actually
photographed in flight. At 30fps a ball struck hard near the lens can cross the
whole frame in under one frame interval — at rest in one frame, gone in the
next. **There is then nothing to trace, and no threshold will conjure it.**

When that's the case, say so plainly and explain how to reshoot. Do not tune in
circles, and never invent an arc the ball didn't visibly travel — a made-up
tracer is worse than no tracer, because it looks like a measurement.

Run the diagnostic whenever tracking fails or returns something implausible:

```bash
python3 scripts/diagnose.py <video>
```

It writes a scrub sheet of the whole clip plus close-up sheets around each burst
of motion, and tells you what to count. Note that the biggest motion event is
usually the hand placing the ball, not the strike — check each sheet.

### What to tell the user if the footage can't work

- **Shoot in slo-mo.** The single biggest fix. 120 or 240fps turns one
  ambiguous frame into eight or sixteen clean ones.
- **Back the camera off, or raise it.** The ball reads as a small dot rather
  than filling the frame, and it stays in shot far longer.
- **Aim across the frame, not past the lens.** A ball hit left-to-right stays
  in view; one hit toward the camera is gone immediately.
- **Frame the whole line** — ball and target both in shot.
- **Don't bump the phone.** Prop it against something solid.

## Two modes

**Tracked** (`track_ball.py` + `render_trail.py`) follows the real ball and
draws where it actually went. Use it whenever the footage supports it.

**Hand-picked** (`points_to_track.py` + `render_trail.py`) follows the real
ball using positions you read off the frames yourself. Slower, but it works in
cluttered scenes where automatic tracking fails, and it still traces the actual
shot. Prefer this over drawn mode whenever the ball is visible.

**Drawn** (`draw_trail.py`) puts a trail along a path you specify, revealed in
sync with the footage from the contact frame onward. Use it when tracking is
impossible — usually because the ball crossed the frame between exposures.

Keep the distinction honest with the user: drawn mode is a stylised effect, not
a measurement of where the ball went. Say so once, plainly, and then get on
with making it look good. Never present a drawn trail as a tracked one, and
never quietly fall back to drawn mode after tracking fails — offer it.

### Pin the strike frame first

Getting this wrong cost more time than anything else. A strike guessed from
motion peaks or skimmed off a contact sheet was out by 80 frames on one clip,
and every search seeded from that guess failed. Locate the ball at rest, then:

```bash
python3 scripts/find_strike.py <video> --at 60 --from 630,1315 --radius 28
```

It scores the rest patch against itself in every frame; the score holds near
1.0 while the ball sits there and collapses when it leaves. Read the output:

- **Short run** — the position is not the ball. Usually the club head resting
  beside it, moving in and out of the patch.
- **Still present at the last frame** — no strike in this recording.
- **A strike frame, but the ball barely moves afterwards** — also no shot.
  Confirm by full-frame matching after the reported strike: if the best match
  stays in roughly the same place, the ball is still on the mat.

### Automatic mode

`find_ball.py` works when the ball sits still before the shot, which is the
common case:

```bash
python3 scripts/find_ball.py <video> --out ball.txt --preview ball_preview.png
python3 scripts/points_to_track.py <video> --out track.json --points-file ball.txt
python3 scripts/render_trail.py track.json -o trail.mp4 --color '#FF0000' --width 12 \
  --trim --lead-in 0.6 --tail 0.9
```

It finds the ball at rest in the background, takes the frame it disappears as
the strike, then follows it at full resolution. Size and brightness limits are
calibrated from that resting ball, so they adapt to the room rather than being
guessed.

`scan_ball.py` is the fallback when the ball never rests in view — filmed from
behind the hole, or nudged around until the moment it is struck. It searches
the whole clip instead. It is slower and much more prone to false positives.

**Zoom in on the marker; do not judge from the path shape.** A path drawn over
the whole frame looks plausible while sitting on a club head, a shoulder or a
shirt logo. Crop 200px around each tracked point and look at what is inside the
circle. This is the single most useful check in the whole workflow, and skipping
it is how a wrong track reaches the user.

**Always look at the preview.** Both scripts report an acceleration and a fit
error, and both numbers matter:

- `fit_rms_px` under ~3 with 15+ points is almost certainly the ball.
- Fewer than about 10 points is weak evidence whatever the fit says. **A
  swinging arm is genuinely parabolic**, and short chains on a shoulder, a
  forearm or a shirt logo will pass a fit test comfortably. Length and distance
  travelled are what separate them.
- A track that stays near the player and never crosses open space is wrong,
  however good its numbers look.

Tighten with `--min-points 13 --min-travel 400 --min-median-step 8` when it
locks onto a body part. If that yields nothing, the clip needs hand-picking —
say so rather than loosening until something appears.

### Following the ball from a known point

`track_from.py` is the most reliable stage in the pipeline, and the one to
reach for whenever a track comes back as a stub of five or ten points:

```bash
python3 scripts/track_from.py <video> --at 917 --from 1064,840 \
  --radius 28 --out ball.txt --preview track_preview.png
```

Blob detection calibrated on the ball at rest loses it a few frames into
flight — moving, the ball is dimmer, smaller and smeared, so it falls outside
limits measured on a stationary one. Matching its actual appearance in a window
around the predicted position does not care. On a clip where automatic
detection produced 9 points, this produced 34 covering the whole shot.

It stops when the ball stops, and trims any stationary tail, so a ball that
comes to rest or drops into the hole does not leave a bright dot parked in the
grass for the remainder of the clip.

Crop clips so they start a beat before the strike — a motionless ball on the
mat gives the tracker a clean template. Stall detection only begins once the
ball has actually moved, so those still opening frames do not end the track
before the shot, and the motionless lead-in is trimmed from the result.

**Start where the ball re-enters, not where it is easiest to find.** These
shots routinely leave through the top of the frame and drop back in later. A
search naturally locks on during the landing, where the ball is big, slow and
sharp — so the trail begins in mid-air, halfway down, and the user sees only
the landing. Work backwards to the frame where the ball first reappears at the
frame edge and start there. On one clip that moved the start from frame 96 to
86 and turned 12 points into 65.

A full-frame template search over the frames before the track begins is the
quickest way to find that entry: the ball shows as a run of scores clearly
above the background noise floor, stepping down the frame. Nearby static
objects produce a constant score in every frame — ignore those.

**Two searches, opposite blind spots — try both before giving up.** Template
matching fails at launch, where the ball is a smear, and at distance, where it
no longer resembles the patch cut at address. Background differencing does not
care what the ball looks like but loses it against a similar-toned background.
An empty template search is NOT evidence the ball is absent: on one clip the
template found nothing above noise after impact while differencing produced a
clean 27-point arc.

**Proving a ball genuinely is not there** takes both methods agreeing, plus the
right signature. A static object returns a near-identical score at a fixed
position in every frame; a real ball's score varies and its position moves
coherently. Rows of constant score at constant coordinates are furniture.
Things mistaken for the ball on real clips: a shadow on the green, a ceiling
light, a shirt logo, a club head, and a player's ear tracking across frame for
fifteen frames.

**The template must be refreshed as the ball flies.** A ball travelling toward
the camera grows and blurs, so a patch cut from the small, distant ball stops
matching within a handful of frames and the search then latches onto whatever
background scores highest. `track_from.py` re-cuts its template from confident
matches by default; `--no-adapt` disables it. Adaptation is not always better —
on one clip it drifted where the fixed template held — so check both if a track
dies early.

**Reach impact by tracking backward.** Seeds land near the apex, where the
ball is slowest and sharpest, so forward-only growth yields descent-only
trails — which is what a user notices first. `track_from.py --backward` walks
into the blurred launch frames and typically recovers 5 to 11 of them. Then
anchor the first point at the ball's measured rest position, so the line starts
exactly where it was struck.

**Stop at the landing, not after it.** A ball that lands keeps bouncing and
settling for another ten frames or so. Tracking through that leaves the trail
head wandering around the green. End the points at touchdown.

**Replace drifted points instead of smoothing over them.** A single tracked
point tens of pixels off shows up as a kink no filter removes. If the hunt
output has a better measurement for that frame, substitute it.

**Stitch segments rather than forcing one track.** When a ball leaves frame,
or bounces at landing, one continuous track may be impossible. Track each
clean run separately and concatenate the points; short gaps interpolate
acceptably. Never extend a track past the point where it stops being on the
ball — a 9-point track that is right beats a 36-point track that wanders onto
the player.

**Check the start point before trusting the result.** A wrong start tracks
perfectly and confidently — on one clip it followed the club head for 37 frames
and drew a convincing arc. The zoom preview is what catches this.

### Hand-picked mode

Automatic tracking loses in a busy room: a shelf full of toys throws off forty
to sixty compact bright blobs per frame, and the ball is routinely only the 20th
most ball-looking thing in shot. Rather than fight the thresholds, read the
positions off the frames.

**Finding the ball.** Do not assume where it went. A lofted shot leaves through
the top of the frame — cropping to the lower half and concluding "no flight
frames" is a mistake that is easy to make and hard to notice. Diff each frame
against a median background and list every small, roughly round, whitish blob
across the *whole* frame, then look at what moves ballistically. A falling ball
shows an unmistakable signature: vertical steps growing by a few pixels each
frame, which is gravity.

Once the ball is located in one frame, `cv2.matchTemplate` on a patch cut from
that frame, searched in a window around the previous position, follows it far
more reliably than blob detection — it survives the ball moving onto a bright
background or shrinking as it flies away from the camera.

**Build the track** from the positions, one `frame:x,y` per line. Only frames
where the ball is clear are needed; the gaps are filled in:

```bash
python3 scripts/points_to_track.py <video> --out track.json --points-file ball.txt
python3 scripts/render_trail.py track.json -o trail.mp4 --smooth 3 --trim --lead-in 0.6 --tail 0.9
```

`draw_trail.py --grid <frame>` stamps a coordinate grid on a frame, which makes
reading positions off it much easier.

Sanity-check the numbers before rendering: real flight has smoothly changing
steps. A jump sideways of a few hundred pixels for one frame is the club head
or a hand, not the ball — drop that point and let it interpolate.

### Drawn mode

Pick coordinates by eye rather than guessing. Write a frame with a grid on it:

```bash
python3 scripts/draw_trail.py <video> --grid 158 --grid-out grid.png
```

`view grid.png`, read off where the ball sits, then render:

```bash
python3 scripts/draw_trail.py <video> -o trail.mp4 \
  --at 158 --from 430,1470 --direction left --distance 0.9 \
  --arc -0.10 --duration 0.33 --color cyan
```

- `--at` — contact frame. Nothing is drawn before it.
- `--from` — ball position at contact. Pixels, or fractions like `0.4,0.77`.
- `--to` or `--direction` + `--distance` — where it goes. Distance is a
  fraction of frame width; over `1.0` exits the frame.
- `--arc` — bows the path sideways. `0` is straight, `±0.1` is a gentle curve.
- `--duration` — seconds for the line to draw out.

Two things worth getting right:

**Direction.** These are lofted shots, so the path goes up steeply and comes
back down — usually close to where it launched, not in a wide sideways arc.
Match the club's swing direction for the small sideways component, but the
dominant motion is vertical. A trail that skims along the ground is wrong.

**Duration.** A hard strike genuinely leaves frame in about one frame, so a
literally real-time reveal is invisible. Around `0.3s` reads as fast but
legible. Stretching past `~0.6s` starts to look slow and floaty. Offer the user
a couple of speeds rather than assuming.

## How it finds the ball

The camera doesn't move, so anything changing between frames is the ball, the
player, or noise. The tracker builds a median background, diffs every frame
against it, keeps ball-sized blobs, then searches for the longest smooth
trajectory through them. The player loses on size; noise loses because it
doesn't form a smooth path.

It does **not** depend on the ball's color, which is what makes it work when the
ball blends into the surface. Color is a tiebreaker (`--ball-color`), not a
requirement.

Candidate paths are ranked by **distance travelled**, not by how many frames
something was visible. This matters more than it sounds: in a ten-second clip
the ball is stationary except for a brief burst, while a flickering ceiling
light or a shifting shadow persists for hundreds of frames while going nowhere.
Rank by frame count and you trace the light fixture every time.

## Workflow

### 1. Get the clip on disk

Uploads land in `/mnt/user-data/uploads/`. Work in `/home/claude/`.

### 2. Track

```bash
python3 scripts/track_ball.py <video> --out track.json --preview preview.png
```

Reports how many frames the ball was found in and the frames the shot spans.
Phone rotation metadata is handled automatically. Frames are streamed, not held
in memory, so clip length doesn't matter.

### 3. Look at the preview — never skip this

```
view preview.png
```

A contact sheet: six frames with the detection circled, plus the whole path on
the last frame. Confirm the circles are on the ball and the path matches the
shot that actually happened. Wrong tracks are confidently wrong — a ceiling
light produces a perfectly valid-looking JSON file. Checking costs seconds;
rendering a bad track costs a minute.

Sanity-check the numbers too. A span of 200+ frames means it locked onto
something persistent and stationary, not a ball.

### 4. Render

```bash
python3 scripts/render_trail.py track.json -o trail.mp4 --color '#FF0000' --width 12 \
  --trim --lead-in 0.6 --tail 0.9
```

The trail accumulates — once the ball passes a point it stays lit, so the
finished clip shows the whole arc. Audio carries over. Output is H.264/yuv420p,
so it plays on phones and social apps.

Use the colour and thickness the user chose (see "Colour and thickness: the
user picks" above), red and medium if they haven't said.

### 5. Hand it back

Copy to `/mnt/user-data/outputs/` and present it, trimmed to the shot. Say how
much of the flight was traced, and end with the one-line colour and thickness offer from that section so it's
easy to ask for a change.

## Tuning

| What the preview shows | Fix |
|---|---|
| "No trajectory found" | `--threshold 15`, or trim to the shot with `--start-frame` / `--end-frame` |
| Tracked a ceiling light, reflection or shadow | Raise `--min-travel`; check the ball is actually in flight |
| Circles on the hand, arm or body | Lower `--max-area` (e.g. `--max-area 800`) |
| Circles on background specks | Raise `--min-area` or `--threshold` |
| Path breaks in the middle | `--max-gap 8` |
| Path jumps between two objects | `--ball-color white` (or `yellow`, `#RRGGBB`) |
| Path starts a few frames late | `--no-trim-lead` |
| Ball missing right after contact | Expected — it outran the frame rate. Widen `--seed-span` so a seed pair can bridge the gap |
| Track stops at the apex | Raise `--tolerance-ratio` to ~0.9; the ball decelerates hard there |

`--max-area` and `--min-travel` are the two that matter most. `--max-area`
separates ball from hand; `--min-travel` (default 8% of the frame diagonal)
separates a real shot from things that flicker in place.

## Look

`render_trail.py`:

- `--color` — `'#RRGGBB'` (see the colour table above); default red.
- `--width` — thickness in px (see the thickness table above); default
  medium, ~0.85% of frame width.
- `--glow` — glow strength, `0` for a flat line.
- `--no-taper` — constant thickness instead of thin-at-launch.
- `--smooth` — averaging window; raise if the arc wobbles.
- `--hold` — seconds frozen on the finished arc (default 1.2) so the shot reads
  before the clip loops.
- `--trim --lead-in 0.6 --tail 0.9` — cut to the shot (see "Trim every clip
  to the shot"); `--full` keeps the whole clip.

## Recommended pipeline (this is what worked on a full batch)

```bash
python3 scripts/find_flight.py <video> --ball X,Y --out flight.txt
python3 scripts/extend_to_landing.py <video> --points flight.txt --out full.txt
python3 scripts/points_to_track.py <video> --points-file full.txt --out track.json
python3 scripts/render_trail.py track.json -o trail.mp4 --trim --lead-in 0.6 --tail 0.9
```

`--ball` is the ball at address in the first frame (detect a bright round blob
low in frame, then crop in to confirm — the club head resting beside it is the
usual wrong answer).

`find_flight.py` is built on consecutive-frame differencing and a physics
chain. On six clips where every earlier method tracked a shirt, an arm or a
towel edge, it found the real ball on five first try, in seconds each. It
reports `local_rms` — how far the chain strays from a local parabola:

    under ~3px   the ball
    ~9px or more almost certainly the player, even if it looks like an arc

When it lands on the player, rerun with `--body-area 20000`, which ignores
small blobs inside any large moving region. Keep it opt-in: at the moment of
contact the ball sits right next to the moving club and hand, so masking the
body always hides the launch frames too.

Always zoom-check the result, then extend to the landing, then render.

## Batch triage: rolls, flights, and the hard ones

On an 18-clip batch this order handled everything, most clips in seconds:

1. **Ball at address.** Auto-detect a bright round blob low in frame, then
   crop in on every one. Misses to expect: a second ball already sitting in
   the cup, a hand still covering the ball in frame 0 (pass `--ref-frame N`
   for a frame where it sits alone).
2. **Template-track every clip from address** (`track_from.py`, starting two
   frames before the strike). Putts and chips that stay on the green — the
   ball rolls into the cup in plain view — come out perfect this way, and the
   flight finder rejects them because they are not airborne.
3. **Airborne shots: `find_flight.py --body-area 20000`.** Its `local_rms`
   sorts the results: ~1-2px is the ball; 5px and up was the player's shirt,
   hand or face every time on this batch.
4. **When the player out-competes the ball: `link_flight.py --region ...`.**
   Exclude the side of the frame the player stands in and link candidates
   greedily from the launch. Fast launches need `--launch-dist 700+`. This
   recovered every clip the chain search got wrong.
5. **Zoom-check, extend to landing, render.**
6. **Shot toward the camera?** Use `headon_reverse.py` (next section) instead of steps 2-4.

Gaps of 5-12 frames near the apex are normal — the ball crosses a bright
ceiling or light and drops out of the difference image. Both finders bridge
them (`--max-gap`); breaking the chain there discards both halves of a clean
flight.

Be slow to declare "no shot". A finger flick hides the ball under the hand at
the moment of the strike, and a short flick into the cup moves the ball only a
few hundred pixels — at contact-sheet scale that looks like a hand fiddling
with a ball, and it was wrongly written off once this way. Crop in on the
area between the ball and the cup, frame by frame, before saying a clip has
nothing to trace. Track from the first clear frame after the finger lifts and
anchor the start at the ball's resting spot.

## Head-on shots: track them backwards

When the camera sits behind the hole and the player hits toward it, the ball
starts as a few pixels next to a distant player and finishes big, sharp and
still on the green in front of the lens. Forward tracking has to find a speck
at address and gets out-voted by the player. **Run the clip in reverse**: the
ball is then the biggest moving thing from the first frame, so the track
starts from the easy end and only has to follow it as it shrinks back to the
tee. `scripts/headon_reverse.py` does the whole thing, and on a 9-clip batch
it matched the hand-checked strike and landing to within a frame or two:

```bash
python3 scripts/headon_reverse.py clip.mp4 --out e_ID.txt --workdir work \
    [--tee X,Y]      # once you've found the ball at address
```

What it does, and what made it work:

1. **Reverse with ffmpeg** (`-vf reverse`, CRF 8). Map frames back with
   `real = N - 1 - reversed`, where N is the **decoded** frame count of the
   original. Container headers were wrong on most clips (they said 166 when
   151 decoded), and the reversed file can carry one extra duplicate frame at
   the end. Use the header count and every point lands 10+ frames off.
2. **Raise the size cap and merge blobs.** Near the lens the ball covers up to
   10,000 px and smears into a streak. Consecutive-frame differencing cuts out
   the part the streak shares with its neighbours, so one ball shows up as two
   blobs. `candidates(..., merge_px=31)` (`link_flight.py --merge 31`) labels
   on a closed mask so the halves count as one ball. Use `--max-area 20000`.
   The player mask must go up too (`--body-area 80000`), or the ball's own
   motion region gets masked as "the player".
3. **Seed at the landing, not the rest.** After landing the ball bounces and
   rolls, and a greedy linker started at the resting spot loses it at the
   first bounce. The touchdown is the start of the longest chain RISING up the
   frame in reversed time (the real descent). Seed on the 2nd and 3rd points of
   that chain: the first step off the green is often a short hop, and a slow
   seed velocity makes the gate too tight for the fast climb that follows.
4. **Cut at the tee.** In reverse, the walk crosses the apex, comes down to
   the tee and then wanders onto the player. Stop at the first stall or jump
   after the apex, then zoom-check the ball at address and anchor the impact
   there.

Still check every clip by eye. Shapes to expect: head-on flights look nearly
vertical (up and down in about the same column), and a short pop-up can pass
right in front of the player's face. In that case (293) the difference image
loses the ball for ~10 frames and you add the points from zoom crops. A second
ball resting on the far table can pass for the tee ball, so confirm the ball
at address on the frames just before impact, not on frame 0.

Clips filmed from behind the player (hitting away from the camera) need none
of this. The ball starts big at address, so the normal forward pipeline works.
If find_flight latches onto the player, seed link_flight by hand from two
clear ball candidates just after launch (`--seed "F:X,Y;F:X,Y"`) and cut at
the landing.

## Default look: solid saturated red

The user wants a solid line, not a glow: `render_trail.py` now defaults to pure
red (#FF0000), no glow, no taper, no white core in the head. The old glow was a
Gaussian blur of the line — that is exactly what reads as "fuzzy". `--glow`,
`--taper`, `--head-core` and `--color` bring the old styles back on request.

The line is ~0.85% of frame width (about 12px on 1440-wide footage) — the
`medium` thickness. Phone video
stores colour at half resolution (yuv420), so a hairline of saturated red gets
its edges averaged into the background and looks washed out and soft.

## Carry the descent all the way to the landing

`extend_to_landing.py` continues a track from its last point until the ball
lands. Run it on every clip before rendering:

```bash
python3 scripts/extend_to_landing.py <video> --points ball.txt --out ball_full.txt
```

Descents are where tracks die early: the ball drops into a darker, busier part
of the frame and gets small. Template matching loses it, and median-background
differencing cannot see it either — a faint ball against dark shelving barely
differs from a background built from frames it flew through. On one clip the
trail stopped in mid-air nine frames before touchdown.

Consecutive-frame differencing does see it: keep what is brighter than the
frames two before AND two after, which isolates the ball rather than the patch
it uncovered. Constrained to near the predicted position, it recovered that
whole descent cleanly. It only extends a track that is still moving; one whose
last points are already at rest has landed, and extending it would just add
settling jiggle.

## Check the tail before trimming it

Truncating a track to the part that has been spot-checked is how flights end
up cut short. On one batch every clip lost 9 to 31 frames that way, and the
missing part was real ball flight in five of six cases — the trail stopped in
mid-air instead of at the landing.

Trim by looking, not by caution. Crop 260px around the last few tracked points
and check whether the ball is still inside the circle. Extend while it is;
cut where it is not. A trail that stops before the ball lands is as wrong as
one that wanders past it, and it is the more likely error, because the
conservative choice feels safer.

## The head must sit on the ball, every frame

Two things can be wrong with a trail and they pull in opposite directions. It
can wiggle, or it can be smooth but not where the ball is — the trail lags the
shot and then catches up. Fixing one by brute force causes the other.

Fitting one rigid curve (a cubic) to the whole flight gives a mathematically
perfect line: measured turn under 0.7 degrees. It also put the drawn head up to
500px from the tracked ball, because a cubic cannot follow a real flight seen
through a wide lens. That reads as a delayed, off-track trail.

So clean the points, then FOLLOW them:

1. Reject points a ball could not have been at, judged LOCALLY — fit a parabola
   to each point's neighbours and drop it if it sits far off. Local matters: a
   wide lens makes the image path parabolic only in stretches, so a global fit
   throws away honest points near the ends.
2. Then run the smoothing spline over what survives. It passes near every
   remaining point, so the head stays on the ball.

Measure both, always, because each is invisible in the other's metric:

    head-vs-ball: distance from the drawn curve to the tracked position at the
                  same frame. Median should be a few px; 50+ is a visible lag.
    turn angle:   per-sample direction change on the DRAWN curve. Under ~2 deg.

On this batch the pair went from 56px/163deg to 5px/1.5deg together.

## Draw the flight, do not smooth the track

Smoothing a wandering track only produces a smooth wandering track. Past a
point, filtering is the wrong tool: if the trail still reads as wrong after
the curve itself is clean, the path is wrong, not the curve.

Test the path against physics. A ball in free flight has one force on it, so
its image-space path is very close to a parabola in time over a short flight.
Fit one and look at the residual:

    under ~15px rms  -> a real flight
    over ~100px rms  -> impossible; the tracker was on a club, a shirt, or blur

On two clips here a parabola missed the tracked path by more than 400px. Those
were the trails that still looked wrong after three rounds of smoothing work,
and no smoothing setting could have fixed them.

So `render_trail.py` fits rather than smooths by default: find the longest run
of points consistent with constant acceleration, fit a cubic through that run
plus the measured impact and landing points, and draw the polynomial. A cubic
has no freedom to wiggle, so the result is smooth by construction — measured
turn per sample dropped to under 0.7 degrees on every clip, from 138-179
degrees originally. `--no-physics` falls back to the smoothing spline for a
clip where no valid run exists (the fit is skipped automatically then too).

Weight the two anchors in the fit so the trail still starts exactly where the
ball was struck and ends where it landed; both came out pixel-exact this way.

## Smoothness: measure the DRAWN curve, and never interpolate through noise

"Squiggly" is measurable — the turn angle between consecutive points along the
path. A ball in flight turns a fraction of a degree per sample. Print the
distribution before and after any change:

    median ~0.3 deg and max under ~20 deg is a clean curve
    single-frame turns of 90-180 deg are artifacts, always

**Measure the dense curve that is actually drawn, not the input points.** This
is the trap that cost the most time here: the input points measured clean
(max 34 deg) while the drawn curve was still full of notches (max 177 deg). A
metric on the inputs tells you nothing about what the viewer sees.

**The cause was interpolation.** An interpolating spline is *required* to pass
through every point it is given, so every mis-measured pixel becomes a real
wiggle, and between sparse knots a cubic overshoots and rings — those are the
notches near the apex. No amount of pre-filtering fixes this, because the
filter can only choose which noisy points the curve is forced through.

**Use a smoothing spline** (`scipy.interpolate.UnivariateSpline` with `s > 0`,
exposed as `--smooth`, in pixels of per-measurement error). It passes *near*
the points instead of through them. On these clips that took the worst drawn
turn from 138-179 deg down to under 21 deg on every trail, with no loss of arc
shape. About 4px of slack suits 1440-wide footage; raise it for a wobblier
track, lower it to hug the measurements.

Three details that each caused their own artifact:

- **Drop repeated positions.** A matcher that loses the ball reports the
  previous pixel again. Those stalled duplicates are not evidence the ball
  stood still, and a spline asked to be in one place at two times wiggles to
  comply. Deduplicating frames is not enough — deduplicate positions.
- **Ease onto the anchors, do not weight them.** Impact and landing are
  measured and the curve must end on them, but forcing that by weighting those
  two points heavily makes the spline bend hard to reach them and overshoot
  just inside — a small hook right at the launch. Fit with uniform weights,
  then shift the curve onto each anchor over its first and last ~10% of
  samples. Capture the offsets *before* applying them, or correcting the first
  sample zeroes out the offset every later sample reads.
- **Ignore tiny segments when judging kinks.** Near the apex the ball moves
  three or four pixels a frame, so its measured direction genuinely swings by
  tens of degrees. That is real and far too small to see; testing it deletes
  the true apex and flattens the arc.

## Rotation metadata will silently wreck the output

Action-cam and phone clips often store the picture one way and carry a
`rotation` flag telling players to display it the other. `ffprobe` reports the
**stored** size; the decoder hands back the **displayed** one. On a clip stored
1088x1920 with rotation -90, ffprobe says 1088x1920 and OpenCV gives 1920x1088.

Never take frame dimensions from the container. Read a frame and use its shape.

Passing the stored size to a raw-video encoder is not a loud failure — the
bytes per frame are identical, so ffmpeg accepts the stream and lays every row
down in the wrong place. The result plays as bars, shearing and judder rather
than raising an error, and it looks like a bad clip rather than a bad render.
Check the output's dimensions against the source's displayed dimensions before
handing anything over:

```bash
ffprobe -v error -select_streams v:0 -show_entries stream=width,height \
  -show_entries stream_side_data=rotation -of default=nw=1 <video>
```

## Distance decides whether any of this works, and what to tell the user

The best predictor of success is how far the ball sits from the camera at
address, and distance works against you twice: far away the ball is a small dim
smudge that size and brightness filters reject, and a struck ball also covers
far more of the frame per exposure *relative to its own size*, so it smears
across a huge distance in one frame with nothing coherent left to match.
Measured on a real clip: the ball matched its own template at 0.94 at rest, and
after contact nothing anywhere in frame beat background noise.

So check where the ball starts before tuning anything. Then advise, in order of
how much it changes the result:

1. **Get the camera close to where the ball starts.** This outweighs frame
   rate. A ball a metre from the lens tracks easily at 30fps; the same shot
   across the room fails at any frame rate.
2. **More light.** Dim rooms force long exposures, the ball smears, and it
   vanishes for several frames after impact. Also the main cause of wobbly arcs.
3. **Then frame rate.** 50fps roughly doubles the usable flight frames over
   30fps; 120 or 240 makes tracking near-automatic.
4. **Tilt up slightly** so the climb stays in frame — a ball that exits the top
   cannot have its rise traced, and no setting recovers it.
5. **Keep recording a few seconds after the swing.** One clip ended before the
   ball landed.
6. **Never pan or move the camera.**

## Limits worth saying out loud

- **The camera has to be still.** Panning or handheld makes the whole
  background read as motion. Ask for a propped-up retake rather than shipping a
  bad render.
- **30fps is often not enough** for a hard strike near the lens, but check
  properly before concluding it: search the whole frame, not the half you
  expect the ball to be in.
- **A player filling the frame defeats automatic tracking.** Body parts move
  ballistically enough to pass the physics test over short spans. Filming from
  further away, with the player smaller in frame, matters more than any setting.
- **Filming from behind the hole** removes the resting phase that automatic
  detection depends on, leaving only the slower whole-clip scan.
- **Automatic tracking is unreliable in cluttered rooms.** Shelving, toys and a
  moving player generate far more ball-like blobs than the ball. Fall back to
  hand-picked mode rather than tuning indefinitely.
- **While the ball touches the club or finger it can't be separated from it**,
  so the arc may begin a frame or two after contact.
- **Vertical shots produce overlapping trails.** Rise and fall land almost on
  top of each other. Accurate, if less dramatic than a broadcast drive.
- **One ball per clip.** Several in flight yields one arc through whichever
  path is longest and smoothest.
- Roughly 25s tracking plus 30s rendering for a 10s 1080p clip. Trimming to the
  shot is faster and more accurate.
