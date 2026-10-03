import fs from 'fs';
import { spawnSync } from 'child_process';
import { blur3, frameCandidates, ballColor, chromaDist } from '../docs/core.js';
const dir = '/home/claude/fgtest/';
const ids = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
const ball = [], other = [];
for (const id of ids) {
  const m = JSON.parse(fs.readFileSync(dir + id + '.json'));
  const { pts, W0, H0 } = m; const AW = 720, AH = Math.round(H0 * 720 / W0), k = AW / W0;
  const vid = ['/home/claude/b3/', '/home/claude/b4/'].map((d) => d + 'v_' + id + '.mp4').find((p) => fs.existsSync(p));
  const tapF = Math.max(0, pts[0][0] - 8), lo = tapF, hi = pts[pts.length - 1][0] + 2;
  const rgb = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', vid, '-fps_mode', 'passthrough', '-vf', `select=between(n\\,${lo}\\,${hi}),scale=${AW}:${AH}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 2 ** 31 }).stdout;
  const fsz = AW * AH * 4; const R = (f) => rgb.subarray((f - lo) * fsz, (f - lo + 1) * fsz);
  const g = (f) => { const a = R(f); const o = new Uint8Array(AW * AH); for (let i = 0, j = 0; i < o.length; i++, j += 4) o[i] = (a[j] * 77 + a[j + 1] * 150 + a[j + 2] * 29) >> 8; return blur3(o, AW, AH); };
  const ref = ballColor(R(tapF), AW, AH, pts[0][1] * k, pts[0][2] * k, 5);
  const sel = pts.slice(2, -1).filter((_, i) => i % 3 === 0);
  const bl = [], ot = [];
  for (const [f, x, y] of sel) {
    if (f - 2 < lo || f + 2 > hi) continue;
    const cs = frameCandidates(g(f - 2), g(f), g(f + 2), AW, AH, { rgba: R(f) });
    for (const c of cs) {
      const d = chromaDist(c.rgb, ref);
      if (Math.hypot(c.x - x * k, c.y - y * k) < 12) bl.push(d); else ot.push(d);
    }
  }
  ball.push(...bl); other.push(...ot);
  const q = (a, p) => (a.sort((x, y) => x - y), a[Math.floor(a.length * p)] ?? NaN);
  console.log(id.padEnd(6), 'ref', ref.map(Math.round).join(','), ' ball d p50', q(bl, .5)?.toFixed(3), 'p90', q(bl, .9)?.toFixed(3), 'max', q(bl, .999)?.toFixed(3), '| other p10', q(ot, .1)?.toFixed(3), 'p50', q(ot, .5)?.toFixed(3));
}
const q = (a, p) => (a.sort((x, y) => x - y), a[Math.floor(a.length * p)]);
console.log('ALL ball p50', q(ball, .5).toFixed(3), 'p90', q(ball, .9).toFixed(3), 'p95', q(ball, .95).toFixed(3), 'p99', q(ball, .99).toFixed(3), '| other p10', q(other, .1).toFixed(3), 'p25', q(other, .25).toFixed(3), 'p50', q(other, .5).toFixed(3));
