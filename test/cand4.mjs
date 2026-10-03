import fs from 'fs';
import { spawnSync } from 'child_process';
import { blur3, frameCandidates, ballColor, chromaDist } from '../docs/core.js';
const [id, ...fr] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync('/home/claude/fgtest/' + id + '.json'));
const { pts, W0, H0 } = m; const AW = 720, AH = Math.round(H0 * 720 / W0), k = AW / W0;
const vid = ['/home/claude/b3/', '/home/claude/b4/'].map((d) => d + 'v_' + id + '.mp4').find((p) => fs.existsSync(p));
const lo = 0, hi = Math.max(...fr.map(Number)) + 2;
const rgb = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', vid, '-fps_mode', 'passthrough', '-vf', `select=between(n\\,${lo}\\,${hi}),scale=${AW}:${AH}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 2 ** 31 }).stdout;
const fsz = AW * AH * 4; const R = (f) => rgb.subarray(f * fsz, (f + 1) * fsz);
const g = (f) => { const a = R(f); const o = new Uint8Array(AW * AH); for (let i = 0, j = 0; i < o.length; i++, j += 4) o[i] = (a[j] * 77 + a[j + 1] * 150 + a[j + 2] * 29) >> 8; return blur3(o, AW, AH); };
const tapF = Math.max(0, pts[0][0] - 8);
const ref = ballColor(R(tapF), AW, AH, pts[0][1] * k, pts[0][2] * k, 5);
console.log('ball colour', ref.map(Math.round));
const v = {}; for (const [f, x, y] of pts) v[f] = [x * k, y * k];
for (const f of fr.map(Number)) {
  const cs = frameCandidates(g(f - 2), g(f), g(f + 2), AW, AH, { rgba: R(f) });
  const t = v[f];
  console.log(f, 'true', t ? t.map(Math.round) : '-', cs.slice(0, 8).map((c) => `${Math.round(c.x)},${Math.round(c.y)} a${c.a} d${chromaDist(c.rgb, ref).toFixed(2)}${t && Math.hypot(c.x - t[0], c.y - t[1]) < 15 ? '*' : ''}`).join(' | '));
}
