// What one or two hand fixes do for the clips the taps alone can't handle.
import fs from 'fs';
import { blur3, frameCandidates, teePresence, solvePath, smoothTrack } from '../site/core.js';
const dir = '/home/claude/fgtest/';
for (const [id, fixFrames] of [['259', [40]], ['259', [38, 45]], ['293', [45]], ['293', [42, 52]], ['280', [10]]]) {
  const m = JSON.parse(fs.readFileSync(dir + id + '.json'));
  const fr = fs.readFileSync(dir + id + '.frames'), cr = fs.readFileSync(dir + id + '.crops');
  const { AW, AH, n, C, pts, W0 } = m; const sc = AW / W0;
  const first = pts[0], last = pts[pts.length - 1]; const tapF = Math.max(0, first[0] - 8);
  const crops = []; for (let i = 0; i < n; i++) crops.push(cr.subarray(i * C * C, (i + 1) * C * C));
  const absent = teePresence(crops, C, C, tapF, last[0]);
  const G = {}; const get = (f) => G[f] ?? (G[f] = blur3(fr.subarray(f * AW * AH, (f + 1) * AW * AH), AW, AH));
  const cands = {}; for (let f = tapF + 1; f < last[0]; f++) if (f >= 2 && f + 2 < n) cands[f] = frameCandidates(get(f - 2), get(f), get(f + 2), AW, AH);
  const byV = {}; for (const [f, x, y] of pts) byV[f] = [x, y];
  const forced = {};
  for (const f of fixFrames) { const near = pts.reduce((a, p) => Math.abs(p[0] - f) < Math.abs(a[0] - f) ? p : a); forced[near[0]] = { x: near[1] * sc, y: near[2] * sc }; }
  const path = solvePath(cands, { x: first[1] * sc, y: first[2] * sc, f0: tapF, absent }, { f: last[0], x: last[1] * sc, y: last[2] * sc }, forced, { fps: 50, H: AH });
  const sm = smoothTrack(path); const by = {}; for (const p of sm) by[p.f] = p;
  const e = pts.slice(1, -1).filter(([f]) => by[f]).map(([f, x, y]) => Math.hypot(by[f].x / sc - x, by[f].y / sc - y)).sort((a, b) => a - b);
  console.log(id, 'fixes at', Object.keys(forced).join(','), ' med', e[e.length >> 1].toFixed(0), 'p90', e[Math.floor(e.length * .9)].toFixed(0), 'max', e[e.length - 1].toFixed(0));
}
