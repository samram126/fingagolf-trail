// Single tap (ball at address) -> careful trail, on hand-verified clips.
// Analysis at 720 px short side with colour, full-resolution recheck.
import fs from 'fs';
import { spawnSync } from 'child_process';
import { blur3, frameCandidates, teePresence, carefulTrack, indexTrail, ballColor, landingIndex } from '../docs/core.js';
const dir = '/home/claude/fgtest/';
const ids = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
const OPTS = JSON.parse(process.env.OPTS || '{}');
const SHORT = +(process.env.SHORT || 720);
const vidOf = (id) => ['/home/claude/b3/', '/home/claude/b4/'].map((d) => d + 'v_' + id + '.mp4').find((p) => fs.existsSync(p));
const dec = (id, lo, hi, args, fmt) => spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', vidOf(id), '-fps_mode', 'passthrough',
  '-vf', `select=between(n\\,${lo}\\,${hi})${args}`, '-f', 'rawvideo', '-pix_fmt', fmt, '-'], { maxBuffer: 2 ** 31 }).stdout;
let tot = { good: 0, bad: 0, flaggedBad: 0, falseAlarm: 0, endOk: 0 };
const rows = [];
for (const id of ids) {
  const m = JSON.parse(fs.readFileSync(dir + id + '.json'));
  const cr = fs.readFileSync(dir + id + '.crops');
  const { n, C, pts, W0, H0 } = m;
  const AW = W0 <= H0 ? SHORT : Math.round(W0 * SHORT / H0), AH = W0 <= H0 ? Math.round(H0 * SHORT / W0) : SHORT;
  const k = AW / W0;
  const first = pts[0], last = pts[pts.length - 1];
  const tapF = Math.max(0, first[0] - 8);
  const endF = Math.min(n - 3, tapF + 4 * 50);
  const t0 = Date.now();
  // analysis frames, RGB
  const rgb = dec(id, tapF - 2, endF + 2, `,scale=${AW}:${AH}:flags=area`, 'rgba');
  const fsz = AW * AH * 4;
  const RGBA = (f) => rgb.subarray((f - tapF + 2) * fsz, (f - tapF + 3) * fsz);
  const G = {}; const get = (f) => {
    if (G[f]) return G[f];
    const a = RGBA(f); const g = new Uint8Array(AW * AH);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (a[j] * 77 + a[j + 1] * 150 + a[j + 2] * 29) >> 8;
    return (G[f] = blur3(g, AW, AH));
  };
  const cands = {};
  for (let f = tapF + 1; f <= endF; f++) cands[f] = frameCandidates(get(f - 2), get(f), get(f + 2), AW, AH, { rgba: RGBA(f), ...OPTS.cand });
  for (const key of Object.keys(G)) delete G[key];
  const crops = []; for (let i = 0; i < n; i++) crops.push(cr.subarray(i * C * C, (i + 1) * C * C));
  const absent = teePresence(crops, C, C, tapF, endF);
  const rgbRef = ballColor(RGBA(tapF), AW, AH, first[1] * k, first[2] * k, Math.max(2, 10 * k));
  // native gray for the careful pass
  const nat = dec(id, tapF - 2, endF + 2, '', 'gray');
  const nsz = W0 * H0;
  const NF = (f) => (f >= tapF - 2 && f <= endF + 2 ? nat.subarray((f - tapF + 2) * nsz, (f - tapF + 3) * nsz) : null);
  const crop = (frm, rc) => { const o = new Uint8Array(rc.w * rc.h); for (let y = 0; y < rc.h; y++) o.set(frm.subarray((rc.y + y) * W0 + rc.x, (rc.y + y) * W0 + rc.x + rc.w), y * rc.w); return o; };
  const cropRGBA = (f, rc) => { // nearest-neighbour from the analysis frame
    const a = RGBA(f); const o = new Uint8ClampedArray(rc.w * rc.h * 4);
    for (let y = 0; y < rc.h; y++) for (let x = 0; x < rc.w; x++) {
      const sx = Math.min(AW - 1, Math.floor((rc.x + x) * k)), sy = Math.min(AH - 1, Math.floor((rc.y + y) * k));
      const si = 4 * (sy * AW + sx), di = 4 * (y * rc.w + x);
      o[di] = a[si]; o[di + 1] = a[si + 1]; o[di + 2] = a[si + 2]; o[di + 3] = 255;
    }
    return o;
  };
  const getWindows = async (reqs) => {
    const out = new Map();
    for (const q of reqs) {
      const a = NF(q.f - 2), b = NF(q.f), c = NF(q.f + 2);
      if (q.single) { if (b) out.set(q.f, { cur: crop(b, q.rect) }); continue; }
      if (a && b && c) out.set(q.f, { prev: crop(a, q.rect), cur: crop(b, q.rect), next: crop(c, q.rect), rgba: cropRGBA(q.f, q.rect) });
    }
    return out;
  };
  const res = await carefulTrack({
    cands, tee: { x: first[1] * k, y: first[2] * k, f0: tapF, absent, rgb: rgbRef }, endF,
    k, W: W0, H: H0, fps: 50, analysisLong: Math.max(AW, AH), getWindows, solveOpts: OPTS.solve,
  });
  if (process.env.DBG) {
    console.log('quick path:', res.path.map((p) => `${p.f}:${Math.round(p.x / k)},${Math.round(p.y / k)}${p.kind[0]}`).join(' '));
    console.log('verified  :', pts.map(([f, x, y]) => `${f}:${Math.round(x)},${Math.round(y)}`).join(' '));
  }
  const by = indexTrail(res.trail);
  const lastT = res.trail[res.trail.length - 1];
  // the verified track's first landing (b3 tracks carry on through bounces)
  const vp = pts.map(([f, x, y], i) => ({ f, x, y, kind: i ? 'det' : 'tee' }));
  const vLand = vp[landingIndex(vp, { fps: 50, H: Math.max(W0, H0) })].f;
  const upto = Math.min(lastT.f, last[0]);
  const e = pts.slice(1, -1).filter(([f]) => f <= upto).map(([f, x, y]) => {
    const p = by.get(f) || res.trail[0];
    return Math.hypot(p.x - x, p.y - y);
  }).sort((a, b) => a - b);
  const p90 = e[Math.floor(e.length * 0.9)] ?? 0, med = e[e.length >> 1] ?? 0;
  const endDiff = lastT.f - last[0];
  const endDist = Math.hypot(lastT.x - last[1], lastT.y - last[2]);
  // over-running is harmless if the line ends where the ball ended (it sat in the cup)
  const endOk = (lastT.f >= vLand - 3 && (lastT.f <= last[0] + 3 || endDist < 40));
  const ok = p90 < 40 && endOk;
  const flagged = res.report.runs.length > 0;
  if (ok) tot.good++; else { tot.bad++; if (flagged) tot.flaggedBad++; }
  if (ok && flagged) tot.falseAlarm++;
  if (endOk) tot.endOk++;
  console.log(`${id.padEnd(6)} med ${med.toFixed(0).padStart(3)} p90 ${p90.toFixed(0).padStart(4)}  start ${res.trail[0].f}(${first[0]}) end ${lastT.f} (land ${vLand}, last ${last[0]}) ${endOk ? 'ok' : 'BAD'} ${endDist.toFixed(0)}px${ok ? '' : ' <<'}  check: ${res.report.runs.map((r) => (r.from === r.to ? r.from : r.from + '-' + r.to)).join(' ') || 'none'}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
console.log(`good ${tot.good}/${ids.length}  ends ok ${tot.endOk}/${ids.length}  bad ${tot.bad} (flagged ${tot.flaggedBad})  good-but-flagged ${tot.falseAlarm}`);
