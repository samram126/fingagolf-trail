// For every verified clip: tee presence from an early tap and from tap-8,
// where planWindow puts the leave, and the step size there.
import fs from 'fs';
import { spawnSync } from 'child_process';
import { rgbaToGray, teePresence, planWindow } from '../docs/core.js';
import { probe } from './pipeline.mjs';
const sets = [
  ['/home/claude/b3/', (id) => `/home/claude/b3/v_${id}.mp4`],
  ['/home/claude/b4/', (id) => `/home/claude/b4/v_${id}.mp4`],
  ['/home/claude/batch/', (id) => fs.readdirSync('/mnt/user-data/uploads/').filter((f) => f.endsWith(`_${id}.mp4`)).map((f) => '/mnt/user-data/uploads/' + f)[0]],
  ['/home/claude/dbg211/', (id) => `/home/claude/dbg211/v_${id}.mp4`],
];
const plan = (await import('../docs/core.js')).planWindow;
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
for (const [dir, vidOf] of sets) for (const fn of fs.readdirSync(dir).filter((f) => /^e_[0-9_]+\.txt$/.test(f)).sort()) {
  const id = fn.slice(2, -4); const vid = vidOf(id);
  if (!vid || !fs.existsSync(vid)) continue;
  const pts = fs.readFileSync(dir + fn, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => { const [f, xy] = l.split(':'); const [x, y] = xy.split(','); return [+f, +x, +y]; }).sort((a, b) => a[0] - b[0]);
  const [sf, tx, ty] = pts[0];
  const { W, H, fps, n } = probe(vid);
  const CS = Math.max(64, Math.round(Math.max(W, H) * 0.05)) & ~1;
  const csx = Math.max(0, Math.min(W - CS, Math.round(tx - CS / 2))), csy = Math.max(0, Math.min(H - CS, Math.round(ty - CS / 2)));
  const crb = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', vid, '-fps_mode', 'passthrough', '-vf', `crop=${CS}:${CS}:${csx}:${csy}`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 2 ** 31 }).stdout;
  const crops = []; for (let i = 0; i < n; i++) crops[i] = crb.subarray(i * CS * CS, (i + 1) * CS * CS);
  const out = [];
  for (const back of [8, 100]) {
    const tf = Math.max(0, sf - back);
    const pres = teePresence(crops, CS, CS, tf, n - 1, { cx: tx - csx, cy: ty - csy });
    const p = plan(pres, tf, n, fps, { seconds: 4 });
    const L = p.leave;
    const pre = L > tf ? med(Array.from(pres.slice(Math.max(tf, L - 5), L))) : 0;
    const post = L >= 0 ? med(Array.from(pres.slice(L, L + Math.max(3, Math.round(0.3 * fps))))) : 0;
    const preS = sf > tf ? med(Array.from(pres.slice(Math.max(tf, sf - 5), sf))) : 0;
    const postS = med(Array.from(pres.slice(sf, sf + Math.max(3, Math.round(0.3 * fps)))));
    out.push(`tap${back}@${tf} ${p.reliable ? 'vis' : 'faint'} leave ${L} (${pre.toFixed(2)}->${post.toFixed(2)}) atStrike ${preS.toFixed(2)}->${postS.toFixed(2)}`);
  }
  console.log(id.padEnd(6), 'strike', sf, '|', out.join(' | '));
}
