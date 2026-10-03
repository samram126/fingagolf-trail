// The website's tracing pipeline (app.js analyze + careful), outside the
// browser, decoding with ffmpeg. Shared by sim.mjs and eval.mjs so tests run
// exactly what the page runs.
import { spawnSync } from 'child_process';
import { blur3, rgbaToGray, frameCandidates, teePresence, carefulTrack, ballColor, planWindow, colourFrame, whiteRef, findLaunch, pickLaunch } from '../docs/core.js';

export function probe(vid) {
  const st = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:stream_side_data=rotation', '-of', 'json', vid]).stdout.toString()).streams[0];
  let W = st.width, H = st.height;
  const rot = Math.abs(((st.side_data_list || []).find((d) => 'rotation' in d) || {}).rotation || 0);
  if (rot === 90 || rot === 270) [W, H] = [H, W];
  const cnt = spawnSync('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets,r_frame_rate', '-of', 'csv=p=0', vid]).stdout.toString().trim().split(',');
  const [rn, rd] = cnt[0].split('/').map(Number);
  return { W, H, fps: Math.round(rn / (rd || 1)), n: +cnt[1] };
}

export async function runClip(vid, tap, opts = {}) {
  const { W, H, fps, n } = probe(vid);
  const dec = (args, fmt) => spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', vid, '-fps_mode', 'passthrough', ...args, '-f', 'rawvideo', '-pix_fmt', fmt, '-'], { maxBuffer: 2 ** 32 - 1 }).stdout;
  const short = Math.min(W, H), long = Math.max(W, H);
  // tee crops over the rest of the clip
  const CS = Math.max(64, Math.round(long * 0.05)) & ~1;
  const csx = Math.max(0, Math.min(W - CS, Math.round(tap.x - CS / 2)));
  const csy = Math.max(0, Math.min(H - CS, Math.round(tap.y - CS / 2)));
  const crb = dec(['-vf', `crop=${CS}:${CS}:${csx}:${csy}`], 'rgba');
  const crops = [];
  for (let i = tap.f; i < n; i++) crops[i] = rgbaToGray(crb.subarray(i * CS * CS * 4, (i + 1) * CS * CS * 4), CS * CS);
  let rgb = ballColor(crb.subarray(tap.f * CS * CS * 4, (tap.f + 1) * CS * CS * 4), CS, CS, tap.x - csx, tap.y - csy, Math.max(3, Math.round(6 * short / 1440)));
  let pres = teePresence(crops, CS, CS, tap.f, n - 1, { cx: tap.x - csx, cy: tap.y - csy });
  const plan = planWindow(pres, tap.f, n, fps, opts.plan);
  if (plan.refF !== undefined) pres = teePresence(crops, CS, CS, tap.f, n - 1, { cx: tap.x - csx, cy: tap.y - csy, refF: plan.refF });
  const cf = colourFrame(plan, pres, tap.f, fps);
  if (cf > tap.f) rgb = ballColor(crb.subarray(cf * CS * CS * 4, (cf + 1) * CS * CS * 4), CS, CS, tap.x - csx, tap.y - csy, Math.max(3, Math.round(6 * short / 1440)));
  const { f0, endF } = plan;
  // analysis frames
  const k = Math.min(1, 720 / short);
  const AW = Math.round(W * k), AH = Math.round(H * k);
  const from = Math.max(0, f0 - 2), to = Math.min(n - 1, endF + 2);
  const ab = dec(['-vf', `select=between(n\\,${from}\\,${to}),scale=${AW}:${AH}`], 'rgba');
  const asz = AW * AH * 4;
  const RGBA = (i) => ab.subarray((i - from) * asz, (i - from + 1) * asz);
  if (!plan.reliable) rgb = whiteRef(RGBA(Math.max(from, f0)), AW, AH, tap.x * k, tap.y * k, 0.12 * Math.max(AW, AH));
  const G = {}; const g = (i) => G[i] ?? (G[i] = blur3(rgbaToGray(RGBA(i), AW * AH), AW, AH));
  const cands = {};
  for (let f = f0 + 1; f <= endF; f++) {
    if (f - 2 >= from && f + 2 <= to) cands[f] = frameCandidates(g(f - 2), g(f), g(f + 2), AW, AH, { rgba: RGBA(f), keepNear: { x: tap.x * k, y: tap.y * k, r: 0.08 * Math.max(AW, AH) }, ...(opts.cand || {}) });
    delete G[f - 3];
  }
  // native frames for careful mode
  const nb = dec(['-vf', `select=between(n\\,${from}\\,${to})`], 'gray');
  const nsz = W * H;
  const NF = (i) => (i >= from && i <= to ? nb.subarray((i - from) * nsz, (i - from + 1) * nsz) : null);
  const crop = (fr, rc) => { const o = new Uint8Array(rc.w * rc.h); for (let y = 0; y < rc.h; y++) o.set(fr.subarray((rc.y + y) * W + rc.x, (rc.y + y) * W + rc.x + rc.w), y * rc.w); return o; };
  const cropRGBA = (i, rc) => {
    const a = RGBA(i); const o = new Uint8ClampedArray(rc.w * rc.h * 4);
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
  const tee = { x: tap.x * k, y: tap.y * k, f0, absent: plan.reliable ? pres : null, rgb };
  if (!plan.reliable) {
    const L = findLaunch(cands, tee, f0, endF, { H: Math.max(AW, AH), fps, W: AW });
    const P = pickLaunch(cands, tee, L, { fps, H: Math.max(AW, AH), endF, frameW: AW, frameH: AH, debugLaunch: !!process.env.DBGL });
    if (P) { tee.launch = P.f; tee.f1 = P.f - 1; }
    plan.launch = P ? P.f : -1;
    plan.launches = L ? [...L.all].sort((a, b) => b.score - a.score).slice(0, 30).map((q) => `${q.f}(${q.speed.toFixed(1)}x${q.chain.length})`) : [];
  }
  const res = await carefulTrack({
    cands, tee, forced: opts.fixes || {},
    k, W, H, fps, analysisLong: Math.max(AW, AH), endF, ballRadius: pres.ballRadius, getWindows, solveOpts: opts.solve,
  });
  return { ...res, W, H, fps, n, plan, pres, rgb, k };
}
