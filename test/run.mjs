// Replays verified clips with only the two taps a user makes, and measures
// the drawn trail against the hand-verified ball positions (native px).
import fs from 'fs';
import { blur3, frameCandidates, teePresence, solvePath, smoothTrack } from '../site/core.js';

const dir = '/home/claude/fgtest/';
const ids = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
const opts = JSON.parse(process.env.OPTS || '{}');
let all = [];
for (const id of ids) {
  const m = JSON.parse(fs.readFileSync(dir + id + '.json'));
  const fr = fs.readFileSync(dir + id + '.frames');
  const cr = fs.readFileSync(dir + id + '.crops');
  const { AW, AH, n, C, pts, W0 } = m;
  const sc = AW / W0;
  const P = pts; // [f,x,y] native
  const first = P[0], last = P[P.length - 1];
  const tapF = Math.max(0, first[0] - 8);
  const E = { f: last[0], x: last[1] * sc, y: last[2] * sc };
  const crops = [];
  for (let i = 0; i < n; i++) crops.push(cr.subarray(i * C * C, (i + 1) * C * C));
  const t0 = Date.now();
  const absent = teePresence(crops, C, C, tapF, E.f);
  const S = { f: tapF, x: first[1] * sc, y: first[2] * sc };
  const G = {};
  const get = (f) => G[f] ?? (G[f] = blur3(fr.subarray(f * AW * AH, (f + 1) * AW * AH), AW, AH));
  const cands = {};
  for (let f = S.f + 1; f < E.f; f++) {
    if (f - 2 < 0 || f + 2 >= n) continue;
    cands[f] = frameCandidates(get(f - 2), get(f), get(f + 2), AW, AH, opts);
  }
  const path = solvePath(cands, { x: S.x, y: S.y, f0: tapF, absent }, E, {}, { fps: 50, H: AH, ...opts });
  const strike = path[0].f;
  const sm = smoothTrack(path, opts);
  const byF = {}; for (const p of sm) byF[p.f] = p;
  const errs = [];
  let worst = [0, 0];
  for (const [f, x, y] of P.slice(1, -1)) {
    const p = byF[f];
    if (!p) { errs.push(f < path[0].f ? Math.hypot(path[0].x / sc - x, path[0].y / sc - y) : 999); continue; }
    const e = Math.hypot(p.x / sc - x, p.y / sc - y);
    if (e > worst[0]) worst = [e, f];
    errs.push(e);
  }
  errs.sort((a, b) => a - b);
  const med = errs[errs.length >> 1] ?? 0, p90 = errs[Math.floor(errs.length * 0.9)] ?? 0, mx = errs[errs.length - 1] ?? 0;
  const det = path.filter((p) => p.kind === 'det').length;
  all.push({ id, med, p90, mx });
  console.log(`${id.padEnd(6)} strike ${String(strike).padStart(4)} (true ${first[0]})  nodes ${String(det).padStart(3)}  err med ${med.toFixed(0).padStart(4)} p90 ${p90.toFixed(0).padStart(4)} max ${mx.toFixed(0).padStart(4)}  ${Date.now() - t0}ms worst@${worst[1]} (S..E ${path[0].f}..${E.f})`);
}
const good = all.filter((r) => r.p90 < 40).length;
console.log(`clips with p90 < 40px: ${good}/${all.length}`);
