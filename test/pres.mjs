// print tee presence + plan for a clip: node test/pres.mjs vid tapF x y
import { spawnSync } from 'child_process';
import { rgbaToGray, teePresence, planWindow } from '../docs/core.js';
import { probe } from './pipeline.mjs';
const [vid, tf, tx, ty] = process.argv.slice(2);
const tap = { f: +tf, x: +tx, y: +ty };
const { W, H, fps, n } = probe(vid);
const long = Math.max(W, H);
const CS = Math.max(64, Math.round(long * 0.05)) & ~1;
const csx = Math.max(0, Math.min(W - CS, Math.round(tap.x - CS / 2)));
const csy = Math.max(0, Math.min(H - CS, Math.round(tap.y - CS / 2)));
const crb = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', vid, '-fps_mode', 'passthrough', '-vf', `crop=${CS}:${CS}:${csx}:${csy}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 2 ** 31 }).stdout;
const crops = [];
for (let i = tap.f; i < n; i++) crops[i] = rgbaToGray(crb.subarray(i * CS * CS * 4, (i + 1) * CS * CS * 4), CS * CS);
const pres = teePresence(crops, CS, CS, tap.f, n - 1, { cx: tap.x - csx, cy: tap.y - csy });
console.log('radius', pres.ballRadius, 'contrast', pres.contrast, JSON.stringify(planWindow(pres, tap.f, n, fps)));
console.log(Array.from(pres).map((v, i) => i >= tap.f ? `${i}:${v.toFixed(2)}` : '').filter(Boolean).join(' '));
