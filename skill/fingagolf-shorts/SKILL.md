---
name: "fingagolf-shorts"
description: "Turn numbered finger golf shot clips into scored YouTube Shorts, asking the user for title, caption, colors, number of holes and par for each hole before building."
---

# Fingagolf Shorts

Turns a finger golf round, filmed one clip per shot, into vertical YouTube Shorts with a live scoreboard, result pop-ups (BIRDIE!, PAR...), drop tags and a big hook title. Clip file names contain a shot number (e.g. `shot_251_trail.mp4`, `VID_20260920_191011_00_242.mp4`); trail versions come from the fingergolf-trail skill. Everything the viewer reads (title, caption, colors, holes, pars) is chosen by the user, so ask before building.

## 1. Gather and check the clips
- Copy every upload into a work folder `src/`. Unzip any zip. Prefer the `_trail` version of a shot when both exist.
- List the shot numbers and look for gaps (e.g. 259 missing). If a number is missing, ask for it before building.
- Make a labelled contact sheet (one frame per clip) and Read it to propose a hole grouping: a hole starts at a tee shot and ends with a putt. (Label with `grep -oE '[0-9]{3}'`, not `[0-9]+`, or the 4 in mp4 sneaks in.)
- Flag any clip much longer than ~5 s: it likely has dead time (walking between putts). Make a 0.5 s-interval contact sheet, find idle stretches (no hand, no ball moving) and put them in `cuts`. Keep anything where the player is actually doing something.

## 2. Ask the user how to set it up
Ask before building, in two short rounds. Use AskUserQuestion where the answer is a choice (the user can always type their own), and a plain message where they need to type numbers. Skip anything they already told you.

**Round 1: the round itself (plain message).** Show your proposed grouping and ask them to confirm or correct:
- How many videos to make and how many holes in each (default: 3 holes per video, e.g. clips 251-259 and 260-268).
- Which clips belong to each hole (your proposal from the contact sheet).
- The **par for each hole**, listed hole by hole.
- Their **score on each hole**, and any **drops** (a drop = +1 penalty stroke; ask which clip was played from the drop).
- For a second or later video: should hole numbers and the total carry on from the previous video (holes 4-6, starting at the last total), or start fresh at hole 1 and E?

**Round 2: the look (AskUserQuestion, up to 4 questions).**
- **Title** for each video: the big text on screen from the very first frame. Offer 2-3 suggestions that describe what happens in that video (e.g. "−3 THRU 3 CHALLENGE", "3 HOLES OF FINGAGOLF") and let them type their own. Their wording always wins; never swap in a generic title. Ask which line of the title gets the highlight color (default: the first line).
- **Caption** for each video: the small line under the title (e.g. "on day 2?!?!?", "how did that go in?!"), or none. Offer 2-3 suggestions that fit the round (if the video opens on its ending, don't use "the ending is crazy"), plus none.
- **Colors**: offer presets and custom:
  - Classic red (default): highlight red, under par red, even green, over par blue, black scoreboard, yellow drop tag
  - Ocean blue: highlight `#00a6ff`
  - Golf green: highlight `#2ecc71`, scoreboard `#0b3d20`
  - Custom: they name colors or hex codes for any of: title highlight, title text, caption, under par, even, over par, scoreboard, drop tag
- **Highlight moment** (optional): is there a crazy shot to zoom in on or to open the video with (see Highlight options)?

If the user isn't around to answer, use the defaults (3 holes per video, fresh numbering, Classic red, no caption) and say which ones you used. Never guess pars or scores: wait for those.

## 3. Build with the script
Write the script below to `make_shorts.py`, write a `config.json` next to `src/`, and run `python3 make_shorts.py config.json`. Needs ffmpeg and Pillow.

Config example (two 3-hole videos; any number of holes per video works):
```json
{
  "clips_dir": "src", "out_dir": "out", "work_dir": "work",
  "colors": {"accent": "red", "title": "white", "caption": "white",
             "under": "#d62828", "even": "green", "over": "blue", "scoreboard": "black", "drop": "yellow"},
  "parts": [
    {"name": "part1_251-259",
     "hook": {"title": ["−3 THRU 3", "CHALLENGE"], "accent_lines": [0], "caption": "on day 2?!?!?"},
     "holes": [
       {"clips": [251, 252], "par": 3, "score": 2},
       {"clips": [253, 254, 255], "par": 4, "score": 3},
       {"clips": [256, 257, 258, 259], "par": 5, "score": 4}]},
    {"name": "part2_260-268",
     "first_hole": 4, "start_total": -3, "start_thru": 3,
     "hook": {"title": ["3 HOLES OF", "FINGAGOLF"], "accent_lines": [1], "caption": "how did that go in?!"},
     "teaser": {"clip": 268, "from": 0.55, "to": 1.7, "speed": 0.5},
     "holes": [
       {"clips": [260, 261, 262], "par": 4, "score": 5, "drop_clip": 261},
       {"clips": [263, 264, 265], "par": 4, "score": 3},
       {"clips": [266, 267, 268], "par": 4, "score": 4, "drop_clip": 267, "result_at": 1.5, "card_y": 560}]}
  ],
  "cuts": {"242": [[2.5, 4.9], [6.5, 8.7]]},
  "audio_shift": {"231": 2.46},
  "zoom": {"268": {"cx": 553, "cy": 931, "z": 2.4, "t0": 0.75, "t1": 1.0}},
  "extend_tail": {"268": 0.5}
}
```

Config fields:
- `colors`: any of `accent` (title highlight), `title`, `caption`, `under`, `even`, `over` (score box and result card colors), `scoreboard` (panel background), `drop` (drop tag). Values: a name (red, blue, green, yellow, gold, orange, purple, pink, teal, white, black, gray), a hex code, or `[r, g, b]`. Leave out any to keep the default. Text on light colors switches to dark automatically.
- `hook.title`: one string or a list of lines; `hook.accent_lines`: which line numbers (0 = first) get the highlight color; `hook.caption`: the small line under it, or leave out. (The older `lines`/`sub` format still works.)
- `holes`: one entry per hole, any number of holes. Each has `clips`, `par`, `score`, and optional `drop_clip` (one clip or a list).
- `first_hole`, `start_total`, `start_thru` (per part): carry hole numbers and the running total over from an earlier video. Defaults: hole 1, E, thru 0.

What the script does:
- Orders clips by the hole lists; scales everything to 1080x1920, 50 fps.
- Cuts the frozen hold the trail tool adds at the end of each clip (and any frozen frames at the start), so cuts between shots are instant.
- Locks each clip's audio length to its video length (trail clips have mismatched audio lengths, which make the sound drift when joined).
- Scoreboard at top: HOLE n / PAR p / TOTAL THRU n with a colored score box.
- Result card (BIRDIE!, PAR, BOGEY... + "N SHOTS") pops 0.4 s before the end of each hole and stays ~1 s into the next hole. It never pauses or freeze-frames the video.
- "DROP • +1 STROKE" tag on the clip played from a drop, ending before the result card.
- Title and caption, big and centered, visible from frame 0 (no fade-in) for 2.6 s.
- Keeps the original clip audio (the user can narrate over it).

## Highlight options (for a crazy shot, e.g. a lip-out-and-in "toilet bowl")
Use these when the user wants to zoom in on a moment or open the video with it:
- `zoom` (per clip): smooth push-in on a point. `cx`,`cy` = the point in 1080x1920 frame pixels (find the cup with a full-res crop sheet around it), `z` = zoom (~2.4), `t0`→`t1` = when the push-in happens (clip seconds, just before the ball reaches the cup).
- `result_at` + `card_y` (per hole): pop the result card at a set time in the hole's last clip (when the ball actually drops) and move it (e.g. `card_y: 560`, just under the scoreboard) so it doesn't cover the cup.
- `extend_tail` (per clip): keep a bit of the frozen tail on the very last clip so the result card stays up; only for the final clip of a video, never between shots.
- `teaser` (per part): cold open replaying `from`→`to` of a clip (zoom included) at `speed` (0.5 = half-speed slow-mo), with the title moved to the top so it doesn't block the action, then a white flash into the full video (the title is then not repeated).

## 4. Check before sending
- Run freezedetect on the outputs: there should be no frozen stretches.
- Grab frames at 0 s (title), at each hole end (result card), and on drop clips, tile them and Read the sheet. Check hole numbers, pars, the running total and the colors the user chose. With a teaser/zoom, also check the teaser frames, the flash and that the card doesn't cover the cup.
- Check that the putt drops before a clip's cut point on short putts (trail freeze can start right after the ball drops).
- Audio sync: if the user says one clip's hit sound is off, find the loudest transient in that clip's audio (10 ms windows) and the impact frame (frame-by-frame crop), and set `audio_shift` for that clip to (sound time − impact time).
- Files over 30 MB can't be sent; re-encode at higher CRF if needed.
- Send the videos with SendUserFile. Report final scores and lengths in a line or two. Any later change (new title, caption, color, par) is just a config edit and a rerun.

## make_shorts.py
```python
#!/usr/bin/env python3
import json, os, re, subprocess, sys, glob
from PIL import Image, ImageDraw, ImageFont

W, H = 1080, 1920
FPS = 50
FONT_DIRS = ["/usr/share/fonts/truetype/google-fonts/", "/usr/share/fonts/truetype/dejavu/"]
def font_path(names):
    for d in FONT_DIRS:
        for n in names:
            p = os.path.join(d, n)
            if os.path.exists(p): return p
    raise SystemExit("No bold font found; install Poppins or DejaVu")
FB = font_path(["Poppins-Bold.ttf", "DejaVuSans-Bold.ttf"])
FM = font_path(["Poppins-Medium.ttf", "DejaVuSans.ttf"])
F = lambda p, s: ImageFont.truetype(p, s)

WHITE, DARK = (255, 255, 255), (18, 22, 20)
NAMED = {"red": "#eb2d2d", "blue": "#1e46a0", "green": "#288246", "yellow": "#ffc400", "gold": "#ffc400", "orange": "#ff7a00",
         "purple": "#8a3ffc", "pink": "#ff4fa3", "teal": "#00a6a6", "white": "#ffffff", "black": "#121614", "gray": "#5a6460"}
DEFAULT_COLORS = {"accent": "red", "title": "white", "caption": "white", "under": "#d62828", "even": "green",
                  "over": "blue", "scoreboard": "black", "drop": "yellow"}
COL = {}
def rgb(v):
    if isinstance(v, (list, tuple)): return tuple(int(x) for x in v[:3])
    v = NAMED.get(str(v).lower().strip(), str(v)).lstrip("#")
    if len(v) == 3: v = "".join(ch * 2 for ch in v)
    return tuple(int(v[i:i + 2], 16) for i in (0, 2, 4))
def set_colors(cfg):
    COL.clear(); COL.update({k: rgb(v) for k, v in {**DEFAULT_COLORS, **cfg.get("colors", {})}.items()})
def ink(bg):
    return DARK if (0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]) > 160 else WHITE
NAMES = {-4: "CONDOR!", -3: "ALBATROSS!", -2: "EAGLE!", -1: "BIRDIE!", 0: "PAR", 1: "BOGEY", 2: "DOUBLE BOGEY", 3: "TRIPLE BOGEY"}
PRE, POST, LAST_PRE, HOOK_SECS = 0.4, 1.0, 0.9, 2.6

def sh(cmd): subprocess.run(cmd, check=True)
def probe(p, stream, entry):
    out = subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", stream, "-show_entries", f"stream={entry}", "-of", "csv=p=0", p]).decode().strip()
    return float(out.splitlines()[0]) if out else None
def dur(p):
    return float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p]).strip())
def freezes(p):
    log = subprocess.run(["ffmpeg", "-i", p, "-vf", "freezedetect=n=0.001:d=0.2", "-an", "-f", "null", "-"], capture_output=True, text=True).stderr
    starts = [float(x) for x in re.findall(r"freeze_start: ([0-9.]+)", log)]
    ends = [float(x) for x in re.findall(r"freeze_end: ([0-9.]+)", log)]
    return starts, ends

def fmt(t): return "E" if t == 0 else (f"+{t}" if t > 0 else f"−{-t}")
def tcol(t): return COL["under"] if t < 0 else (COL["over"] if t > 0 else COL["even"])
def ctext(d, box, txt, font, fill):
    x0, y0, x1, y1 = box; bb = d.textbbox((0, 0), txt, font=font)
    d.text(((x0 + x1 - (bb[2] - bb[0])) / 2 - bb[0], (y0 + y1 - (bb[3] - bb[1])) / 2 - bb[1]), txt, font=font, fill=fill)

def scoreboard(path, hole, par, total, thru):
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    x0, y0, x1, y1 = 150, 210, 930, 360
    d.rounded_rectangle((x0 + 6, y0 + 8, x1 + 6, y1 + 8), 34, fill=(0, 0, 0, 90))
    d.rounded_rectangle((x0, y0, x1, y1), 34, fill=(*COL["scoreboard"], 225))
    ctext(d, (x0 + 20, y0 + 8, x0 + 300, y0 + 100), f"HOLE {hole}", F(FB, 58), WHITE)
    ctext(d, (x0 + 20, y0 + 88, x0 + 300, y1 - 10), f"PAR {par}", F(FM, 34), (190, 220, 190))
    d.line((x0 + 320, y0 + 25, x0 + 320, y1 - 25), fill=(255, 255, 255, 70), width=3)
    ctext(d, (x0 + 330, y0 + 8, x0 + 540, y0 + 60), "TOTAL", F(FM, 30), (190, 220, 190))
    ctext(d, (x0 + 330, y0 + 60, x0 + 540, y1 - 12), f"THRU {thru}", F(FB, 38), WHITE)
    bx = (x1 - 200, y0 + 18, x1 - 20, y1 - 18)
    d.rounded_rectangle(bx, 24, fill=(*tcol(total), 255) if thru else (60, 70, 65, 255))
    ctext(d, bx, fmt(total), F(FB, 72), ink(tcol(total)) if thru else WHITE)
    im.save(path)

def result_card(path, strokes, diff, cy=880):
    name = NAMES.get(diff, f"+{diff}")
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    col = tcol(diff)
    font = F(FB, 118 if len(name) < 10 else 92)
    bb = d.textbbox((0, 0), name, font=font); bw = max(bb[2] - bb[0] + 120, 560)
    cx = W // 2
    box = (cx - bw // 2, cy - 110, cx + bw // 2, cy + 110)
    d.rounded_rectangle((box[0] + 8, box[1] + 10, box[2] + 8, box[3] + 10), 40, fill=(0, 0, 0, 110))
    d.rounded_rectangle(box, 40, fill=(*col, 240), outline=WHITE, width=6)
    ctext(d, (box[0], box[1] + 10, box[2], cy + 40), name, font, ink(col))
    ctext(d, (box[0], cy + 30, box[2], box[3] - 10), f"{strokes} SHOTS", F(FM, 44), ink(col))
    im.save(path)

def drop_tag(path):
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    box = (330, 385, 750, 465)
    d.rounded_rectangle(box, 40, fill=(*COL["drop"], 240))
    ctext(d, box, "DROP  •  +1 STROKE", F(FB, 34), ink(COL["drop"]))
    im.save(path)

def hook_lines(hook):
    if "lines" in hook: return hook["lines"]
    title = hook.get("title", [])
    if isinstance(title, str): title = [title]
    acc = hook.get("accent_lines", [0])
    return [[[t, "accent" if i in acc else "title"]] for i, t in enumerate(title)]

def hook_card(path, hook, y=600):
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    for segs in hook_lines(hook):
        size = 130; f = F(FB, size)
        while sum(d.textlength(t, font=f) for t, _ in segs) > W - 80: size -= 4; f = F(FB, size)
        x = (W - sum(d.textlength(t, font=f) for t, _ in segs)) / 2
        for t, c in segs:
            col = COL["accent"] if c == "accent" else COL["title"]
            d.text((x + 6, y + 9), t, font=f, fill=(0, 0, 0, 150), stroke_width=12, stroke_fill=(0, 0, 0, 150))
            d.text((x, y), t, font=f, fill=col, stroke_width=12, stroke_fill=(0, 0, 0))
            x += d.textlength(t, font=f)
        y += size + 24
    cap = hook.get("caption", hook.get("sub"))
    if cap:
        d.text((W / 2, y + 30), cap, font=F(FB, 58), fill=COL["caption"], anchor="mm", stroke_width=8, stroke_fill=(0, 0, 0))
    im.save(path)

def find_clip(clips_dir, n):
    hits = [p for p in glob.glob(os.path.join(clips_dir, "*")) if p.lower().endswith((".mp4", ".mov"))
            and re.search(rf"(?<!\d){n}(?!\d)", os.path.basename(p).rsplit(".", 1)[0])]
    if not hits: raise SystemExit(f"clip {n} not found in {clips_dir}")
    hits.sort(key=lambda p: ("trail" not in p.lower(), p))
    return hits[0]

def prep_clip(cfg, n, norm_dir):
    src = find_clip(cfg["clips_dir"], n)
    vdur = probe(src, "v", "duration") or dur(src)
    starts, ends = freezes(src)
    head = 0.0
    if starts and starts[0] == 0.0 and ends: head = ends[0]
    tail = vdur
    if str(n) not in map(str, cfg.get("keep_tail", [])) and starts:
        chain_start = None
        if len(starts) > len(ends):
            chain_start = starts[-1]
            i = len(ends) - 1
            while i >= 0 and abs(ends[i] - chain_start) < 0.05:
                chain_start = starts[i]; i -= 1
        if chain_start is not None and chain_start > head + 0.3: tail = chain_start
    tail = min(vdur, tail + float(cfg.get("extend_tail", {}).get(str(n), 0)))
    ashift = float(cfg.get("audio_shift", {}).get(str(n), 0))
    has_audio = probe(src, "a", "duration") is not None
    seg = tail - head
    out = os.path.join(norm_dir, f"shot_{n}.mp4")
    vf = f"trim={head}:{tail},setpts=PTS-STARTPTS,scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2,fps={FPS},setsar=1"
    zm = cfg.get("zoom", {}).get(str(n))
    if zm:
        z, t0, t1, cx, cy = zm["z"], zm["t0"] - head, zm["t1"] - head, zm["cx"], zm["cy"]
        T = f"(in/{FPS})"
        ramp = f"if(lt({T},{t0}),0,if(gt({T},{t1}),1,(({T}-{t0})/({t1}-{t0}))*(({T}-{t0})/({t1}-{t0}))*(3-2*(({T}-{t0})/({t1}-{t0})))))"
        vf += (f",scale={W*2}:{H*2},zoompan=z='1+({z}-1)*{ramp}':d=1:s={W}x{H}:fps={FPS}"
               f":x='max(0,min(iw-iw/zoom,{cx*2}-iw/zoom/2))':y='max(0,min(ih-ih/zoom,{cy*2}-ih/zoom/2))'")
    vf += ",format=yuv420p"
    if has_audio:
        af = f"atrim=start={head + ashift},asetpts=PTS-STARTPTS,apad,atrim=0:{seg},asetpts=PTS-STARTPTS"
        cmd = ["ffmpeg", "-v", "error", "-y", "-i", src, "-filter_complex", f"[0:v]{vf}[v];[0:a]{af},aresample=48000,aformat=channel_layouts=stereo[a]"]
    else:
        cmd = ["ffmpeg", "-v", "error", "-y", "-i", src, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
               "-filter_complex", f"[0:v]{vf}[v];[1:a]atrim=0:{seg}[a]"]
    sh(cmd + ["-map", "[v]", "-map", "[a]", "-t", f"{seg:.3f}", "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-c:a", "aac", "-b:a", "192k", out])
    cuts = cfg.get("cuts", {}).get(str(n))
    if cuts:
        keep, t = [], 0.0
        for a, b in sorted(cuts):
            if a > t: keep.append((t, a))
            t = b
        keep.append((t, None))
        fc = ""; labels = ""
        for i, (a, b) in enumerate(keep):
            rng = f"{a}:{b}" if b is not None else f"{a}"
            fc += f"[0:v]trim={rng},setpts=PTS-STARTPTS[v{i}];[0:a]atrim={rng},asetpts=PTS-STARTPTS[a{i}];"
            labels += f"[v{i}][a{i}]"
        fc += f"{labels}concat=n={len(keep)}:v=1:a=1[v][a]"
        tmp = out.replace(".mp4", "_cut.mp4")
        sh(["ffmpeg", "-v", "error", "-y", "-i", out, "-filter_complex", fc, "-map", "[v]", "-map", "[a]",
            "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-c:a", "aac", "-b:a", "192k", tmp])
        os.replace(tmp, out)
    return out, (head, tail)

def build_part(cfg, part, norm, ov_dir, out_dir):
    name = part["name"]; total = int(part.get("start_total", 0)); t = 0.0
    first = int(part.get("first_hole", 1)); thru0 = int(part.get("start_thru", 0))
    clips_all, ends, drops, pops = [], [], [], []
    for hi, hole in enumerate(part["holes"], 1):
        tag = f"{name}_h{hi}"
        scoreboard(f"{ov_dir}/{tag}_before.png", first + hi - 1, hole["par"], total, thru0 + hi - 1)
        diff = hole["score"] - hole["par"]; total += diff
        scoreboard(f"{ov_dir}/{tag}_after.png", first + hi - 1, hole["par"], total, thru0 + hi)
        result_card(f"{ov_dir}/{tag}_res.png", hole["score"], diff, hole.get("card_y", 880))
        dc = hole.get("drop_clip")
        dclips = dc if isinstance(dc, list) else ([dc] if dc else [])
        for c in hole["clips"]:
            d = dur(norm[c])
            if c in dclips: drops.append((t, t + max(0.5, min(d - LAST_PRE, 2.0))))
            clips_all.append(c); t += d
        ends.append(t)
        pops.append(t - dur(norm[hole["clips"][-1]]) + hole["result_at"] if "result_at" in hole else None)
    T = t
    ins, fc = [], ""
    for i, c in enumerate(clips_all):
        ins += ["-i", norm[c]]; fc += f"[{i}:v][{i}:a]"
    fc += f"concat=n={len(clips_all)}:v=1:a=1[v0][a]"
    k = len(clips_all); ovs = []; start = 0.0
    for hi, e in enumerate(ends, 1):
        tag = f"{name}_h{hi}"; last = hi == len(ends)
        pop = pops[hi - 1] if pops[hi - 1] is not None else e - (LAST_PRE if last else PRE); stop = T + 1 if last else e + POST
        ovs += [(f"{ov_dir}/{tag}_before.png", start, pop, False), (f"{ov_dir}/{tag}_after.png", pop, stop, False),
                (f"{ov_dir}/{tag}_res.png", pop, stop, True)]
        start = stop
    ovs += [(f"{ov_dir}/drop.png", a, b, False) for a, b in drops]
    teaser = part.get("teaser")
    if part.get("hook"):
        hook_card(f"{ov_dir}/hook_{name}.png", part["hook"], y=260 if teaser else 600)
        if not teaser:
            ovs.append((f"{ov_dir}/hook_{name}.png", 0.0, HOOK_SECS, False))
    cur = "v0"
    for j, (png, a, b, fade) in enumerate(ovs):
        ins += ["-loop", "1", "-i", png]; src = f"[{k}:v]"
        if fade:
            fc += f";{src}format=rgba,fade=in:st={a:.3f}:d=0.15:alpha=1[o{j}]"; src = f"[o{j}]"
        fc += f";[{cur}]{src}overlay=0:0:enable='between(t,{a:.3f},{b:.3f})':shortest=1[w{j}]"
        cur = f"w{j}"; k += 1
    out = os.path.join(out_dir, f"fingagolf_{name}.mp4")
    sh(["ffmpeg", "-v", "error", "-y", *ins, "-filter_complex", fc, "-map", f"[{cur}]", "-map", "[a]", "-t", f"{T:.3f}",
        "-r", str(FPS), "-c:v", "libx264", "-preset", "medium", "-crf", "21", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out])
    if teaser:
        c, a, b, sp = teaser["clip"], teaser["from"], teaser["to"], teaser.get("speed", 1.0)
        main = out.replace(".mp4", "_main.mp4"); os.replace(out, main)
        tl = (b - a) / sp
        at = []; r = sp
        while r < 0.5: at.append("atempo=0.5"); r /= 0.5
        at.append(f"atempo={r}")
        hook = ["-loop", "1", "-i", f"{ov_dir}/hook_{name}.png"] if part.get("hook") else []
        fc = (f"[0:v]trim={a}:{b},setpts=(PTS-STARTPTS)/{sp},fps={FPS}[tv0];[0:a]atrim={a}:{b},asetpts=PTS-STARTPTS,{','.join(at)}[ta];"
              + (f"[tv0][2:v]overlay=0:0:shortest=1[tv];" if hook else "[tv0]null[tv];")
              + f"[1:v]fade=in:st=0:d=0.25:color=white[mv];[tv][ta][mv][1:a]concat=n=2:v=1:a=1[v][a]")
        sh(["ffmpeg", "-v", "error", "-y", "-i", norm[c], "-i", main, *hook, "-filter_complex", fc, "-map", "[v]", "-map", "[a]",
            "-r", str(FPS), "-c:v", "libx264", "-preset", "medium", "-crf", "21", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out])
        os.remove(main); T += tl
    return out, T, total, ends

def main():
    cfg = json.load(open(sys.argv[1]))
    base = os.path.dirname(os.path.abspath(sys.argv[1]))
    for k in ("clips_dir", "out_dir", "work_dir"):
        cfg[k] = os.path.join(base, cfg.get(k, k.split("_")[0]))
    set_colors(cfg)
    norm_dir = os.path.join(cfg["work_dir"], "norm"); ov_dir = os.path.join(cfg["work_dir"], "ov")
    for d in (norm_dir, ov_dir, cfg["out_dir"]): os.makedirs(d, exist_ok=True)
    drop_tag(f"{ov_dir}/drop.png")
    norm = {}
    for part in cfg["parts"]:
        for hole in part["holes"]:
            for c in hole["clips"]:
                if c not in norm:
                    norm[c], (h, tl) = prep_clip(cfg, c, norm_dir)
                    print(f"  clip {c}: kept {h:.2f}-{tl:.2f}s -> {dur(norm[c]):.2f}s")
    for part in cfg["parts"]:
        out, T, total, ends = build_part(cfg, part, norm, ov_dir, cfg["out_dir"])
        print(f"{out}: {T:.1f}s, final {fmt(total)}, hole ends {[round(e, 2) for e in ends]}, size {os.path.getsize(out) / 1e6:.1f} MB")

if __name__ == "__main__":
    main()
```