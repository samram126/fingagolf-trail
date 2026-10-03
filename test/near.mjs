import { spawnSync } from 'child_process';
import { blur3, rgbaToGray, frameCandidates, chromaDist } from '../docs/core.js';
const [vid, lo, hi, tx, ty] = process.argv.slice(2).map((v, i) => (i ? +v : v));
const W = 1920, H = 1088, k = 720 / 1088, AW = Math.round(W * k), AH = 720;
const b = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', vid, '-vf', `select=between(n\\,${lo - 2}\\,${hi + 2}),scale=${AW}:${AH}`, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 2 ** 31 }).stdout;
const sz = AW * AH * 4, R = (i) => b.subarray((i - lo + 2) * sz, (i - lo + 3) * sz);
const g = (i) => blur3(rgbaToGray(R(i), AW * AH), AW, AH);
for (let f = lo; f <= hi; f++) {
  const cs = frameCandidates(g(f - 2), g(f), g(f + 2), AW, AH, { rgba: R(f) });
  const near = cs.filter((c) => Math.hypot(c.x / k - tx, c.y / k - ty) < 200);
  console.log(f, near.map((c) => `${Math.round(c.x / k)},${Math.round(c.y / k)} a${c.a} rgb${c.rgb.map(Math.round).join('/')} dN${chromaDist(c.rgb, [1, 1, 1]).toFixed(2)}`).join(' | '));
}
