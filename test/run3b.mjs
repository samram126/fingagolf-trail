// Careful mode end to end (carefulTrack) on verified clips, with the report.
import fs from 'fs';
import { spawnSync } from 'child_process';
import { blur3, frameCandidates, teePresence, carefulTrack, indexTrail } from '../docs/core.js';
const dir = process.env.TDIR || '/home/claude/fgtest/';
const ids = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
const vidOf = (id) => process.env.VID || ['/home/claude/b3/', '/home/claude/b4/'].map((d) => d + 'v_' + id + '.mp4').find((p) => fs.existsSync(p));
let good = 0, flaggedBad = 0, bad = 0, falseAlarm = 0;
for (const id of ids) {
  const m = JSON.parse(fs.readFileSync(dir + id + '.json'));
  const fr = fs.readFileSync(dir + id + '.frames'), cr = fs.readFileSync(dir + id + '.crops');
  const { AW, AH, n, C, pts, W0, H0 } = m; const k = AW / W0;
  const first = pts[0], last = pts[pts.length - 1]; const tapF = Math.max(0, first[0] - 8);
  const E = { f: last[0], x: last[1] * k, y: last[2] * k };
  const crops = []; for (let i = 0; i < n; i++) crops.push(cr.subarray(i * C * C, (i + 1) * C * C));
  const absent = teePresence(crops, C, C, tapF, E.f);
  const G = {}; const get = (f) => G[f] ?? (G[f] = blur3(fr.subarray(f * AW * AH, (f + 1) * AW * AH), AW, AH));
  const cands = {};
  for (let f = tapF + 1; f < E.f; f++) if (f >= 2 && f + 2 < n) cands[f] = frameCandidates(get(f - 2), get(f), get(f + 2), AW, AH);
  const lo = Math.max(0, tapF - 2), hi = Math.min(n - 1, E.f + 2);
  const r = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', vidOf(id), '-fps_mode', 'passthrough', '-vf', `select=between(n\\,${lo}\\,${hi})`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 2 ** 31 });
  const sz = W0 * H0; const NF = (f) => (f >= lo && f <= hi ? r.stdout.subarray((f - lo) * sz, (f - lo + 1) * sz) : null);
  const crop = (frm, rc) => { const o = new Uint8Array(rc.w * rc.h); for (let y = 0; y < rc.h; y++) o.set(frm.subarray((rc.y + y) * W0 + rc.x, (rc.y + y) * W0 + rc.x + rc.w), y * rc.w); return o; };
  const getWindows = async (reqs) => {
    const out = new Map();
    for (const q of reqs) {
      const a = NF(q.f - 2), b = NF(q.f), c = NF(q.f + 2);
      if (a && b && c) out.set(q.f, { prev: crop(a, q.rect), cur: crop(b, q.rect), next: crop(c, q.rect) });
    }
    return out;
  };
  const t0 = Date.now();
  const res = await carefulTrack({ cands, tee: { x: first[1] * k, y: first[2] * k, f0: tapF, absent }, E, k, W: W0, H: H0, fps: 50, analysisLong: Math.max(AW, AH), getWindows });
  const by = indexTrail(res.trail);
  const e = pts.slice(1, -1).map(([f, x, y]) => { const p = by.get(f); return p ? Math.hypot(p.x - x, p.y - y) : 0; }).sort((a, b) => a - b);
  const p90 = e[Math.floor(e.length * 0.9)];
  const ok = p90 < 40;
  const flagged = res.report.runs.length > 0;
  if (ok) good++; else bad++;
  if (!ok && flagged) flaggedBad++;
  if (ok && flagged) falseAlarm++;
  console.log(`${id.padEnd(6)} p90 ${p90.toFixed(0).padStart(4)} max ${e[e.length - 1].toFixed(0).padStart(4)}  seen ${res.report.seen}/${res.report.total}  check: ${res.report.runs.map((r) => r.from === r.to ? r.from : r.from + '-' + r.to).join(' ') || 'none'}  ${Date.now() - t0}ms`);
}
console.log(`good ${good}/${ids.length}; bad ${bad} (flagged ${flaggedBad}); good-but-flagged ${falseAlarm}`);
