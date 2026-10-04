# Changelog

## Skill 1.2 (2026-10-04)
- Every output is trimmed to the shot: 0.6 s before the strike to 0.9 s after
  the landing, then the 1.2 s hold. `--full` keeps the whole clip.
- Trimming now cuts the sound from the same moment (before, a trimmed clip
  kept the sound from the start of the source, out of sync).
- `draw_trail.py` trims the same way around the contact frame.

## Skill 1.1 (2026-10-03)
- Trail colour and thickness are the user's pick: 13 named colours or any hex,
  and thin / medium / thick / extra thick. Asked for up front or changed after
  (only the render is redone). Defaults stay red and medium.
- Scripts: `--thickness` and more colour names in `render_trail.py` and
  `draw_trail.py`; clear error for an unknown colour.

## Skill 1.0 (2026-10-03)
- First shared version of the Claude skill. Lofted shots, rolls, chips,
  shots filmed head-on (tracked backwards from the landing), flights that
  leave the picture and come back, white balls on a white rug.
- The repo now hosts the skill and its download page. The in-browser website
  (versions 1.0–2.1.0 below) moved to the `website` branch.

## Website 2.1.0
- Faint balls at address, launch found from motion, flights out of frame,
  early taps. (See the `website` branch.)

## Website 2.0.0
- Batches of clips, one tap per clip, automatic landing, player masking.

## Website 1.1.0
- Careful mode: full-resolution recheck of every frame.

## Website 1.0.0
- First version: two-tap tracing, fixes, MP4 export.
