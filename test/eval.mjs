// Every hand-checked clip through the website pipeline with one tap.
// TAPBACK = frames before the hit to tap (default 8). Prints one line per clip.
import fs from 'fs';
import { runClip } from './pipeline.mjs';
import { landingIndex, indexTrail } from '../docs/core.js';
const sets = [
  ['/home/claude/b3/', (id) => `/home/claude/b3/v_${id}.mp4`],
  ['/home/claude/b4/', (id) => `/home/claude/b4/v_${id}.mp4`],
  ['/home/claude/batch/', (id) => fs.readdirSync('/mnt/user-data/uploads/').filter((f) => f.endsWith(`_${id}.mp4`)).map((f) => '/mnt/user-data/uploads/' + f)[0]],
];
const want = process.argv.slice(2);
const back = +(process.env.TAPBACK || 8);
for (const [dir, vidOf] of sets) {
  for (const fn of fs.readdirSync(dir).filter((f) => /^e_[0-9_]+\.txt$/.test(f)).sort()) {
    const id = fn.slice(2, -4);
    if (want.length && !want.includes(id)) continue;
    const vid = vidOf(id);
    if (!vid || !fs.existsSync(vid)) continue;
    const pts = fs.readFileSync(dir + fn, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => { const [f, xy] = l.split(':'); const [x, y] = xy.split(','); return [+f, +x, +y]; }).sort((a, b) => a[0] - b[0]);
    const first = pts[0], last = pts[pts.length - 1];
    const t0 = Date.now();
    let r;
    try { r = await runClip(vid, { f: Math.max(0, first[0] - back), x: first[1], y: first[2] }); } catch (e) { console.log(id, 'ERROR', e.message); continue; }
    const by = indexTrail(r.trail);
    const lastT = r.trail[r.trail.length - 1];
    const vp = pts.map(([f, x, y], i) => ({ f, x, y, kind: i ? 'det' : 'tee' }));
    const vLand = vp[landingIndex(vp, { fps: r.fps, H: Math.max(r.W, r.H) })].f;
    const upto = Math.min(lastT.f, last[0]);
    const e = pts.slice(1, -1).filter(([f]) => f <= upto).map(([f, x, y]) => { const p = by.get(f) || r.trail[0]; return Math.hypot(p.x - x, p.y - y); }).sort((a, b) => a - b);
    const p90 = e[Math.floor(e.length * 0.9)] ?? 999, med = e[e.length >> 1] ?? 999;
    const endDist = Math.hypot(lastT.x - last[1], lastT.y - last[2]);
    const endOk = lastT.f >= vLand - 3 && (lastT.f <= last[0] + 3 || endDist < 40);
    const ok = p90 < 40 && endOk && r.trail.length > 3;
    console.log(`${id.padEnd(6)} ${ok ? 'OK ' : 'BAD'} med ${med.toFixed(0).padStart(3)} p90 ${p90.toFixed(0).padStart(4)} start ${r.trail[0].f}(${first[0]}) end ${lastT.f}(land ${vLand}, last ${last[0]}) ${endOk ? '' : 'END '}tee ${r.plan.reliable ? 'vis' : 'faint'}${r.plan.launch !== undefined ? ' launch ' + r.plan.launch : ''} check ${r.report.runs.length} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
