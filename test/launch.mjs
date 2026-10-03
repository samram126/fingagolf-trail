import fs from 'fs';
import { spawnSync } from 'child_process';
import { windowCandidates } from '../docs/core.js';
const [id, f0, f1, cx, cy, R] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync('/home/claude/fgtest/' + id + '.json'));
const { W0, H0, pts } = m;
const vid = ['/home/claude/b3/', '/home/claude/b4/'].map((d) => d + 'v_' + id + '.mp4').find((p) => fs.existsSync(p));
const lo = +f0 - 2, hi = +f1 + 2;
const r = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', vid, '-fps_mode', 'passthrough', '-vf', `select=between(n\\,${lo}\\,${hi})`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 2 ** 31 });
const sz = W0 * H0; const F = (f) => r.stdout.subarray((f - lo) * sz, (f - lo + 1) * sz);
const rc = { x: Math.max(0, +cx - +R), y: Math.max(0, +cy - +R) }; rc.w = Math.min(W0 - rc.x, 2 * +R); rc.h = Math.min(H0 - rc.y, 2 * +R);
const crop = (fr) => { const o = new Uint8Array(rc.w * rc.h); for (let y = 0; y < rc.h; y++) o.set(fr.subarray((rc.y + y) * W0 + rc.x, (rc.y + y) * W0 + rc.x + rc.w), y * rc.w); return o; };
const v = {}; for (const [f, x, y] of pts) v[f] = [x, y];
for (let f = +f0; f <= +f1; f++) {
  const cs = windowCandidates(crop(F(f - 2)), crop(F(f)), crop(F(f + 2)), rc.w, rc.h, Math.min(W0, H0));
  console.log(f, 'true', v[f] || '-', JSON.stringify(cs.map((c) => [Math.round(c.x + rc.x), Math.round(c.y + rc.y), c.a])));
}
