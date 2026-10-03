// usage: node test/sim.mjs video.mp4 tapFrame tapX tapY
import { runClip } from './pipeline.mjs';
const [vid, tf, tx, ty] = process.argv.slice(2);
const t0 = Date.now();
const r = await runClip(vid, { f: +tf, x: +tx, y: +ty }, JSON.parse(process.env.OPTS || '{}'));
console.log(`${r.W}x${r.H} ${r.fps}fps ${r.n} frames | tee ${r.plan.reliable ? 'visible' : 'too faint'} (radius ${r.pres.ballRadius}, contrast ${Math.round(r.pres.contrast)}) colour ${r.rgb ? r.rgb.map(Math.round) : '-'} | window ${r.plan.f0}..${r.plan.endF} launch ${r.plan.launch ?? '-'} [${(r.plan.launches || []).join(' ')}] | ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(`report: seen ${r.report.seen}/${r.report.total}, check ${r.report.runs.map((q) => q.from + '-' + q.to).join(' ') || 'none'}`);
if (process.env.PATH_DBG) console.log('path:', r.path.slice(0, 40).map((p) => `${p.f}:${Math.round(p.x / r.k)},${Math.round(p.y / r.k)}${p.kind[0]}${p.fine ? '*' : ''}`).join(' '));
console.log('trail:', r.trail.filter((_, i) => i % 3 === 0).map((p) => `${p.f}:${Math.round(p.x)},${Math.round(p.y)}`).join(' '));
