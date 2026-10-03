// Quick (first pass) vs careful (full-resolution refinement) on verified clips.
import fs from 'fs';
import { spawnSync } from 'child_process';
import { blur3, frameCandidates, teePresence, solvePath, smoothTrack, fineRect, indexTrail, windowCandidates, mergeFine } from '../docs/core.js';

const dir = '/home/claude/fgtest/';
const ids = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
const opts = JSON.parse(process.env.OPTS || '{}');
const vidOf = (id) => ['/home/claude/b3/', '/home/claude/b4/'].map((d) => d + 'v_' + id + '.mp4').find((p) => fs.existsSync(p));

function nativeFrames(id, lo, hi, W0, H0) {
  const r = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', vidOf(id), '-fps_mode', 'passthrough',
    '-vf', `select=between(n\\,${lo}\\,${hi})`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 2 ** 31 });
  const fs_ = {};
  const sz = W0 * H0;
  for (let i = 0; i * sz < r.stdout.length; i++) fs_[lo + i] = r.stdout.subarray(i * sz, (i + 1) * sz);
  return fs_;
}
const crop = (fr, W0, rc) => {
  const out = new Uint8Array(rc.w * rc.h);
  for (let y = 0; y < rc.h; y++) out.set(fr.subarray((rc.y + y) * W0 + rc.x, (rc.y + y) * W0 + rc.x + rc.w), y * rc.w);
  return out;
};
function score(P, trail, sc) {
  const by = indexTrail(trail);
  const e = [];
  for (const [f, x, y] of P.slice(1, -1)) {
    const p = by.get(f);
    e.push(p ? Math.hypot(p.x / sc - x, p.y / sc - y) : Math.hypot(trail[0].x / sc - x, trail[0].y / sc - y));
  }
  e.sort((a, b) => a - b);
  return { med: e[e.length >> 1], p90: e[Math.floor(e.length * 0.9)], max: e[e.length - 1] };
}
let sum = { q: [0, 0], c: [0, 0] }, good = { q: 0, c: 0 };
for (const id of ids) {
  const m = JSON.parse(fs.readFileSync(dir + id + '.json'));
  const fr = fs.readFileSync(dir + id + '.frames'), cr = fs.readFileSync(dir + id + '.crops');
  const { AW, AH, n, C, pts, W0, H0 } = m; const k = AW / W0;
  const first = pts[0], last = pts[pts.length - 1]; const tapF = Math.max(0, first[0] - 8);
  const E = { f: last[0], x: last[1] * k, y: last[2] * k };
  const crops = []; for (let i = 0; i < n; i++) crops.push(cr.subarray(i * C * C, (i + 1) * C * C));
  const absent = teePresence(crops, C, C, tapF, E.f);
  const G = {}; const get = (f) => G[f] ?? (G[f] = blur3(fr.subarray(f * AW * AH, (f + 1) * AW * AH), AW, AH));
  let cands = {};
  for (let f = tapF + 1; f < E.f; f++) if (f >= 2 && f + 2 < n) cands[f] = frameCandidates(get(f - 2), get(f), get(f + 2), AW, AH);
  const tee = { x: first[1] * k, y: first[2] * k, f0: tapF, absent };
  const so = { fps: 50, H: Math.max(AW, AH), ...opts };
  const path1 = solvePath(cands, tee, E, {}, so);
  const trail1 = smoothTrack(path1).map((p) => ({ f: p.f, x: p.x / k, y: p.y / k }));
  const q = score(pts, trail1.map((p) => ({ f: p.f, x: p.x * k, y: p.y * k })), k);
  // careful pass
  const t0 = Date.now();
  const lo = Math.max(0, path1[0].f - 2), hi = Math.min(n - 1, E.f + 2);
  const NF = nativeFrames(id, lo, hi, W0, H0);
  const byF = indexTrail(trail1);
  const fine = {};
  for (let f = path1[0].f + 1; f < E.f; f++) {
    if (!NF[f - 2] || !NF[f + 2]) continue;
    const rc = fineRect(trail1, f, W0, H0, { byF, ...opts.rect });
    if (!rc) continue;
    const cs = windowCandidates(crop(NF[f - 2], W0, rc), crop(NF[f], W0, rc), crop(NF[f + 2], W0, rc), rc.w, rc.h, Math.min(W0, H0));
    fine[f] = cs.map((c) => ({ x: c.x + rc.x, y: c.y + rc.y, a: c.a, u: c.u }));
  }
  cands = mergeFine(cands, fine, k);
  const path2 = solvePath(cands, tee, E, {}, so);
  const trail2 = smoothTrack(path2, opts);
  const c = score(pts, trail2, k);
  sum.q[0] += q.med; sum.q[1] += q.p90; sum.c[0] += c.med; sum.c[1] += c.p90;
  if (q.p90 < 40) good.q++; if (c.p90 < 40) good.c++;
  console.log(`${id.padEnd(6)} quick med ${q.med.toFixed(0).padStart(3)} p90 ${q.p90.toFixed(0).padStart(4)} max ${q.max.toFixed(0).padStart(4)} | careful med ${c.med.toFixed(0).padStart(3)} p90 ${c.p90.toFixed(0).padStart(4)} max ${c.max.toFixed(0).padStart(4)}  fine-nodes ${path2.filter((p) => p.fine).length}/${path2.length}  ${Date.now() - t0}ms`);
}
console.log(`TOTAL quick med ${sum.q[0].toFixed(0)} p90 ${sum.q[1].toFixed(0)} good ${good.q}/${ids.length} | careful med ${sum.c[0].toFixed(0)} p90 ${sum.c[1].toFixed(0)} good ${good.c}/${ids.length}`);
