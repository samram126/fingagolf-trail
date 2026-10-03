// Fingagolf Trail — the page. Tracking lives in core.js; decoding and
// encoding use Mediabunny (WebCodecs), so every frame is read and written
// exactly, at hardware speed, whatever the device.
import {
  blur3, rgbaToGray, frameCandidates, teePresence, solvePath, smoothTrack,
  carefulTrack, checkTrail, mergeFine, landingIndex, ballColor,
} from './core.js?v=2.0.0';
import {
  Input, ALL_FORMATS, BlobSource, CanvasSink, EncodedPacketSink, AudioBufferSink,
  Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource,
  getFirstEncodableVideoCodec, getFirstEncodableAudioCodec,
} from './vendor/mediabunny.min.mjs';
import { makeZip } from './zip.js?v=2.0.0';

export const VERSION = '2.0.0';
const REPO = 'https://github.com/samram126/fingagolf-trail';

const $ = (s) => document.querySelector(s);
const canvas = $('#stage');
const ctx = canvas.getContext('2d');

const ANALYSIS_SHORT = 720;  // analysis frames: short side in px
const SEARCH_SECONDS = 4;    // how long after the tap to look for the shot

const S = {
  step: 'load',
  clips: [], ci: 0,
  frame: 0, cur: null,
  zoom: null, fixing: false, playing: false,
  color: '#ff0000', thick: 1, trim: true,
  zipUrl: null,
};
const C = () => S.clips[S.ci];

$('#ver').textContent = `Version ${VERSION}`;
$('#repoLink').href = REPO;

// ---------- steps ----------
function show(step) {
  S.step = step;
  document.querySelectorAll('.step').forEach((el) => { el.hidden = el.dataset.step !== step; });
  $('#scrub').hidden = !['tap', 'review'].includes(step);
  $('#drop').hidden = step !== 'load';
  if (step === 'load' || step === 'list' || step === 'done') { S.cur = null; }
  // lists use the whole width; the video box is for tapping and checking
  document.querySelector('.app').classList.toggle('no-stage', ['list', 'done', 'busy'].includes(step));
  canvas.classList.toggle('tappable', step === 'tap' || S.fixing);
  hideError();
  draw();
}
function error(msg) { const e = $('#error'); e.textContent = msg; e.hidden = false; }
function hideError() { $('#error').hidden = true; }
function setBusy(title, frac, text, clipText) {
  $('#busyTitle').textContent = title;
  $('#barFill').style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
  $('#busyText').textContent = text || '';
  if (clipText !== undefined) $('#busyClip').textContent = clipText;
}
const yieldUI = () => new Promise((r) => setTimeout(r, 0));

// ---------- loading ----------
$('#file').addEventListener('change', (e) => { const f = [...e.target.files]; if (f.length) load(f); e.target.value = ''; });
const drop = $('#drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => { const f = [...e.dataTransfer.files].filter((x) => x.type.startsWith('video') || /\.(mp4|mov|m4v|webm)$/i.test(x.name)); if (f.length) load(f); });

async function load(files) {
  if (!('VideoDecoder' in window)) {
    error('This browser is too old to read video frames. Use a recent Chrome, Edge, Safari or Firefox.');
    return;
  }
  stopPlay();
  // numbered clips in number order
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  S.clips = [];
  show('busy');
  for (let i = 0; i < files.length; i++) {
    const clip = {
      file: files[i], name: (files[i].name || `clip ${i + 1}`).replace(/\.[^.]+$/, ''),
      fixes: {}, history: [], endAt: null, status: 'new', note: '',
    };
    S.clips.push(clip);
    setBusy('Opening your clips', i / files.length, files.length > 1 ? `Clip ${i + 1} of ${files.length}` : '', '');
    try { await openClip(clip); } catch (err) { clip.status = 'failed'; clip.note = err.message || "Couldn't open this video."; }
  }
  const first = S.clips.findIndex((c) => c.status === 'new');
  if (first < 0) {
    show('load');
    error(S.clips.length === 1 ? S.clips[0].note : "Couldn't open any of those videos.");
    return;
  }
  await startTap(first);
}

async function openClip(clip) {
  clip.input = new Input({ source: new BlobSource(clip.file), formats: ALL_FORMATS });
  clip.vtrack = await clip.input.getPrimaryVideoTrack();
  if (!clip.vtrack) throw new Error('No video in that file.');
  if (!(await clip.vtrack.canDecode())) {
    throw new Error("This browser can't decode this video's format. iPhone clips (HEVC) open in Safari; or export the clip as \"Most compatible\" (H.264).");
  }
  clip.atrack = await clip.input.getPrimaryAudioTrack();
  clip.W = clip.vtrack.displayWidth; clip.H = clip.vtrack.displayHeight;
  // exact frame list: presentation timestamps of every packet
  const ps = new EncodedPacketSink(clip.vtrack);
  const times = [];
  let p = await ps.getFirstPacket({ metadataOnly: true });
  while (p) { times.push(p.timestamp); p = await ps.getNextPacket(p, { metadataOnly: true }); }
  times.sort((a, b) => a - b);
  if (times.length < 10) throw new Error('That clip is too short.');
  clip.times = times;
  clip.n = times.length;
  const d = [];
  for (let i = 1; i < times.length; i++) d.push(times[i] - times[i - 1]);
  d.sort((a, b) => a - b);
  clip.fps = Math.round(1 / d[d.length >> 1]) || 30;
  clip.sink = new CanvasSink(clip.vtrack, { poolSize: 2 });
}

// nearest frame index for a timestamp
function indexOf(clip, t) {
  const a = clip.times;
  let lo = 0, hi = a.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] < t) lo = mid + 1; else hi = mid; }
  if (lo > 0 && Math.abs(a[lo - 1] - t) < Math.abs(a[lo] - t)) lo--;
  return lo;
}

// ---------- frames ----------
let gotoSeq = 0;
async function goto(i) {
  const c = C();
  if (!c || !c.sink) return;
  i = Math.max(0, Math.min(c.n - 1, i | 0));
  S.frame = i;
  $('#slider').value = i;
  $('#frameNo').textContent = i;
  const seq = ++gotoSeq;
  const wc = await c.sink.getCanvas(c.times[i]);
  if (seq !== gotoSeq || !wc) return;
  S.cur = wc.canvas;
  draw();
}

function sizeCanvas() {
  const c = C();
  if (!c) return;
  const box = $('#stageBox').getBoundingClientRect();
  const k = Math.min(box.width / c.W, box.height / c.H);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.style.width = `${Math.round(c.W * k)}px`;
  canvas.style.height = `${Math.round(c.H * k)}px`;
  canvas.width = Math.round(c.W * k * dpr);
  canvas.height = Math.round(c.H * k * dpr);
}
window.addEventListener('resize', () => { if (S.cur) { sizeCanvas(); draw(); } });

function viewRect() {
  const c = C();
  if (!S.zoom) return { x: 0, y: 0, w: c.W, h: c.H };
  const k = 4, w = c.W / k, h = c.H / k;
  return {
    x: Math.max(0, Math.min(c.W - w, S.zoom.x - w / 2)),
    y: Math.max(0, Math.min(c.H - h, S.zoom.y - h / 2)),
    w, h,
  };
}

function trailUpTo(trail, f) {
  if (!trail || f <= trail[0].f) return null;
  return trail.filter((p) => p.f <= f);
}
function drawTrail(g, pts, sx, sy, sc, width, color) {
  if (!pts || pts.length < 2) return;
  g.save();
  g.lineJoin = 'round'; g.lineCap = 'round';
  g.strokeStyle = color; g.lineWidth = width;
  g.beginPath();
  g.moveTo((pts[0].x - sx) * sc, (pts[0].y - sy) * sc);
  for (let i = 1; i < pts.length; i++) g.lineTo((pts[i].x - sx) * sc, (pts[i].y - sy) * sc);
  g.stroke();
  g.restore();
}
const trailWidth = (c) => Math.max(3, c.W * 0.0085) * S.thick;

function draw() {
  const c = C();
  if (!c || !S.cur || !['tap', 'review'].includes(S.step)) { canvas.style.width = '0'; canvas.style.height = '0'; return; }
  const v = viewRect();
  const sc = canvas.width / v.w;
  ctx.drawImage(S.cur, v.x, v.y, v.w, v.h, 0, 0, canvas.width, canvas.height);
  if (S.step === 'review') drawTrail(ctx, trailUpTo(c.trail, S.frame), v.x, v.y, sc, trailWidth(c) * sc, S.color);
  const mark = (p, color, label) => {
    const x = (p.x - v.x) * sc, y = (p.y - v.y) * sc;
    const r = Math.max(10, canvas.width * 0.025);
    ctx.save();
    ctx.lineWidth = Math.max(2, canvas.width * 0.006);
    ctx.strokeStyle = color;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    if (label) {
      ctx.fillStyle = color;
      ctx.font = `700 ${Math.round(r * 0.95)}px "Atkinson Hyperlegible", sans-serif`;
      ctx.fillText(label, x + r * 1.2, y - r * 0.6);
    }
    ctx.restore();
  };
  if (S.step === 'tap' && c.tee) { ctx.globalAlpha = c.tee.f === S.frame ? 1 : 0.5; mark(c.tee, '#ffd23f', ''); ctx.globalAlpha = 1; }
  if (S.step === 'review' && c.fixes[S.frame]) mark({ f: S.frame, ...c.fixes[S.frame] }, '#18c8ff', 'fix');
}

// ---------- tapping the ball ----------
async function startTap(i) {
  S.ci = i;
  const c = C();
  show('tap');
  sizeCanvas();
  $('#slider').max = c.n - 1;
  const waiting = S.clips.filter((x) => x.status !== 'failed').length;
  const pos = S.clips.slice(0, i + 1).filter((x) => x.status !== 'failed').length;
  $('#tapCount').textContent = waiting > 1 ? `Clip ${pos} of ${waiting}: ${c.name}` : c.name;
  $('#tapStatus').textContent = c.tee ? `Ball marked in frame ${c.tee.f}.` : 'Not marked yet.';
  $('#tapStatus').classList.toggle('ok', !!c.tee);
  $('#tapNext').disabled = !c.tee;
  $('#tapNext').textContent = nextTapIndex(i) >= 0 ? 'Next clip' : 'Trace the shots';
  $('#tapBack').disabled = prevTapIndex(i) < 0;
  await goto(c.tee ? c.tee.f : 0);
  scrollToStage();
}
const nextTapIndex = (i) => S.clips.findIndex((x, j) => j > i && x.status !== 'failed');
const prevTapIndex = (i) => { for (let j = i - 1; j >= 0; j--) if (S.clips[j].status !== 'failed') return j; return -1; };

$('#tapNext').onclick = () => {
  const n = nextTapIndex(S.ci);
  if (n >= 0) startTap(n); else traceAll();
};
$('#tapBack').onclick = () => { const p = prevTapIndex(S.ci); if (p >= 0) startTap(p); };
$('#tapSkip').onclick = () => {
  C().status = 'skipped'; C().tee = null;
  const n = nextTapIndex(S.ci);
  if (n >= 0) startTap(n);
  else if (S.clips.some((x) => x.tee)) traceAll();
  else { show('load'); }
};

canvas.addEventListener('click', (e) => {
  const tapping = S.step === 'tap' || S.fixing;
  if (!tapping || S.playing) return;
  const c = C();
  const r = canvas.getBoundingClientRect();
  const v = viewRect();
  const x = v.x + ((e.clientX - r.left) / r.width) * v.w;
  const y = v.y + ((e.clientY - r.top) / r.height) * v.h;
  if (!S.zoom) {
    S.zoom = { x, y };
    $('#zoomHint').hidden = false;
    draw();
    return;
  }
  S.zoom = null;
  $('#zoomHint').hidden = true;
  if (S.fixing) {
    setFixing(false);
    c.fixes[S.frame] = { x, y };
    c.history.push({ type: 'fix', f: S.frame });
    if (c.endAt !== null && S.frame > c.endAt) c.endAt = null;
    $('#undoFix').disabled = false;
    resolve(c);
    draw();
    return;
  }
  if (c.status === 'skipped') c.status = 'new';
  c.tee = { f: S.frame, x, y };
  $('#tapStatus').textContent = `Ball marked in frame ${S.frame}.`;
  $('#tapStatus').classList.add('ok');
  $('#tapNext').disabled = false;
  draw();
  // on a phone the button is below the video: bring it up
  if (window.innerWidth < 860) setTimeout(() => $('#tapNext').scrollIntoView({ behavior: 'smooth', block: 'center' }), 250);
});
function scrollToStage() {
  if (window.innerWidth < 860) $('#stageBox').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.zoom) { S.zoom = null; $('#zoomHint').hidden = true; draw(); }
  if (!['tap', 'review'].includes(S.step) || e.target.matches('input')) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); stopPlay(); goto(S.frame - 1); }
  if (e.key === 'ArrowRight') { e.preventDefault(); stopPlay(); goto(S.frame + 1); }
  if (e.key === ' ') { e.preventDefault(); S.playing ? stopPlay() : startPlay(); }
});
$('#prev').onclick = () => { stopPlay(); goto(S.frame - 1); };
$('#next').onclick = () => { stopPlay(); goto(S.frame + 1); };
$('#slider').oninput = (e) => { stopPlay(); goto(+e.target.value); };
$('#play').onclick = () => (S.playing ? stopPlay() : startPlay());

// ---------- preview playback (no sound; the finished videos have it) ----------
async function startPlay() {
  const c = C();
  if (S.playing || !c?.sink) return;
  S.playing = true;
  S.zoom = null; $('#zoomHint').hidden = true;
  $('#play').setAttribute('aria-label', 'Pause');
  $('#playIcon').innerHTML = '<path d="M7 5h4v14H7zM13 5h4v14h-4z" class="fill"/>';
  const start = S.frame >= c.n - 1 ? 0 : S.frame;
  const t0 = c.times[start];
  const wall0 = performance.now();
  const play = new CanvasSink(c.vtrack, { poolSize: 3 });
  try {
    for await (const wc of play.canvases(t0)) {
      if (!S.playing) break;
      const wait = (wc.timestamp - t0) * 1000 - (performance.now() - wall0);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (!S.playing) break;
      S.cur = wc.canvas;
      S.frame = indexOf(c, wc.timestamp);
      $('#slider').value = S.frame; $('#frameNo').textContent = S.frame;
      draw();
    }
  } catch { /* stopped mid-decode */ }
  if (S.playing) stopPlay();
}
function stopPlay() {
  if (!S.playing) return;
  S.playing = false;
  $('#play').setAttribute('aria-label', 'Play');
  $('#playIcon').innerHTML = '<path d="M8 5v14l11-7z" class="fill"/>';
  goto(S.frame);
}

// ---------- tracing ----------
async function traceAll() {
  stopPlay();
  const todo = S.clips.filter((c) => c.tee && c.status !== 'failed');
  show('busy');
  for (let i = 0; i < todo.length; i++) {
    const c = todo[i];
    const label = todo.length > 1 ? `Clip ${i + 1} of ${todo.length}: ${c.name}` : c.name;
    const step = (title, frac, text) => setBusy(title, frac, text, label);
    try {
      await analyze(c, step);
      await careful(c, step);
      c.status = c.failed ? 'nofind' : 'done';
    } catch (err) {
      c.status = 'failed';
      c.note = `Something went wrong: ${err.message || err}`;
    }
    await yieldUI();
  }
  showList();
}

// Pass 1: every frame from the tap to a few seconds later, at 720 px, in
// colour. Ball candidates come from consecutive-frame differencing.
async function analyze(c, step) {
  const short = Math.min(c.W, c.H);
  const k = Math.min(1, ANALYSIS_SHORT / short);
  const AW = Math.round(c.W * k), AH = Math.round(c.H * k);
  c.aScale = k; c.aDims = { AW, AH };
  const off = document.createElement('canvas');
  off.width = AW; off.height = AH;
  const octx = off.getContext('2d', { willReadFrequently: true });
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  const long = Math.max(c.W, c.H);
  const CS = Math.max(64, Math.round(long * 0.05)) & ~1;
  const cc = document.createElement('canvas');
  cc.width = CS; cc.height = CS;
  const cctx = cc.getContext('2d', { willReadFrequently: true });
  const csx = Math.max(0, Math.min(c.W - CS, Math.round(c.tee.x - CS / 2)));
  const csy = Math.max(0, Math.min(c.H - CS, Math.round(c.tee.y - CS / 2)));

  // When does the ball leave the spot that was tapped? A cheap scan of just
  // the tee area over the rest of the clip, so a tap long before the shot is
  // fine.
  const crops = [];
  {
    const sink0 = new CanvasSink(c.vtrack, { poolSize: 2 });
    const eps0 = 0.25 / c.fps;
    let k0 = 0;
    const tot0 = c.n - c.tee.f;
    for await (const wc of sink0.canvases(c.times[c.tee.f] - eps0)) {
      const i = indexOf(c, wc.timestamp);
      if (i < c.tee.f) continue;
      cctx.drawImage(wc.canvas, csx, csy, CS, CS, 0, 0, CS, CS);
      const cr = cctx.getImageData(0, 0, CS, CS).data;
      crops[i] = rgbaToGray(cr, CS * CS);
      if (i === c.tee.f) {
        const r = Math.max(3, Math.round(6 * short / 1440));
        c.rgb = ballColor(cr, CS, CS, c.tee.x - csx, c.tee.y - csy, r);
      }
      if ((++k0 & 7) === 0) { step('Finding the shot', k0 / tot0, 'Watching for the ball to leave the tee'); await yieldUI(); }
    }
  }
  const pres = teePresence(crops, CS, CS, c.tee.f, c.n - 1, { cx: c.tee.x - csx, cy: c.tee.y - csy });
  const hold = Math.max(3, Math.round(0.3 * c.fps));
  let leave = -1;
  for (let f = c.tee.f + 1; f + hold < c.n && leave < 0; f++) {
    let gone = true;
    for (let j = 0; j < hold; j++) if (pres[f + j] < 1) { gone = false; break; }
    if (gone) leave = f;
  }
  c.f0 = leave > 0 ? Math.max(c.tee.f, leave - Math.round(0.5 * c.fps)) : c.tee.f;
  c.endF = Math.min(c.n - 3, (leave > 0 ? leave : c.tee.f) + Math.round(SEARCH_SECONDS * c.fps));
  const from = Math.max(0, c.f0 - 2), to = Math.min(c.n - 1, c.endF + 2);
  const blurred = new Map(), colour = new Map();
  const cands = {};
  const total = to - from + 1;
  const sink = new CanvasSink(c.vtrack, { poolSize: 2 });
  const eps = 0.25 / c.fps;
  let count = 0;
  for await (const wc of sink.canvases(c.times[from] - eps, c.times[to] + eps)) {
    const i = indexOf(c, wc.timestamp);
    if (i < from || i > to) continue;
    octx.drawImage(wc.canvas, 0, 0, AW, AH);
    const rgba = octx.getImageData(0, 0, AW, AH).data;
    blurred.set(i, blur3(rgbaToGray(rgba, AW * AH), AW, AH));
    colour.set(i, rgba);
    const f = i - 2;
    if (f > c.f0 && f <= c.endF && blurred.has(f - 2) && blurred.has(f)) {
      cands[f] = frameCandidates(blurred.get(f - 2), blurred.get(f), blurred.get(i), AW, AH, { rgba: colour.get(f) });
    }
    blurred.delete(i - 4); colour.delete(i - 4);
    count++;
    step('Finding the ball', count / total, `First pass: frame ${count} of ${total}`);
    if ((count & 3) === 0) await yieldUI();
  }
  c.cands = cands;
  c.absent = pres;
}

const teeA = (c) => ({ x: c.tee.x * c.aScale, y: c.tee.y * c.aScale, f0: c.f0 ?? c.tee.f, absent: c.absent, rgb: c.rgb });
const solveOpts = (c) => ({ fps: c.fps, H: Math.max(c.aDims.AW, c.aDims.AH), endF: c.endF });

// Passes 2-4: full-resolution look at every frame, re-solve, double-check,
// wider search where the ball was hard to see, follow a roll to its stop.
async function careful(c, step) {
  const stages = {
    quick: ['Finding the ball', 'First pass done'],
    fine: ['Checking every frame up close', 'Looking at full resolution around the line'],
    recheck: ['Double-checking the hard frames', 'Searching wider where the ball was hard to see'],
    follow: ['Following the roll', ''],
  };
  const res = await carefulTrack({
    cands: c.cands, tee: teeA(c), forced: c.fixes,
    k: c.aScale, W: c.W, H: c.H, fps: c.fps, analysisLong: Math.max(c.aDims.AW, c.aDims.AH),
    endF: c.endF, ballRadius: c.absent.ballRadius,
    getWindows: (reqs, prog) => getWindows(c, reqs, prog),
    onProgress: (stage, frac) => { const t = stages[stage]; if (t) step(t[0], frac, t[1]); },
  });
  c.failed = !!res.failed;
  Object.assign(c, { path: res.path, trail: res.trail, quick: res.quick, fine: res.fine, report: res.report, E: res.E, carefulTrail: res.trail });
}

// Full-resolution crops: for each request, the same rectangle from frames
// f-2, f and f+2 (or just f for `single`). Only needed frames are decoded.
async function getWindows(c, reqs, progress = () => {}) {
  const need = new Map();
  const out = new Map();
  for (const r of reqs) {
    out.set(r.f, { single: !!r.single });
    const offs = r.single ? [[0, 'cur']] : [[-2, 'prev'], [0, 'cur'], [2, 'next']];
    for (const [d, slot] of offs) {
      const i = r.f + d;
      if (i < 0 || i >= c.n) continue;
      if (!need.has(i)) need.set(i, []);
      need.get(i).push({ r, slot });
    }
  }
  const frames = [...need.keys()].sort((a, b) => a - b);
  const sink = new CanvasSink(c.vtrack, { poolSize: 2 });
  const cv = document.createElement('canvas');
  const cx = cv.getContext('2d', { willReadFrequently: true });
  let done = 0;
  for await (const wc of sink.canvasesAtTimestamps(frames.map((i) => c.times[i] + 1e-6))) {
    const i = frames[done++];
    if (wc) {
      for (const { r, slot } of need.get(i)) {
        const { x, y, w, h } = r.rect;
        if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
        cx.drawImage(wc.canvas, x, y, w, h, 0, 0, w, h);
        const data = cx.getImageData(0, 0, w, h).data;
        const o = out.get(r.f);
        o[slot] = rgbaToGray(data, w * h);
        if (slot === 'cur') o.rgba = data;
      }
    }
    progress(done / frames.length);
    if ((done & 3) === 0) await yieldUI();
  }
  for (const [f, w] of out) if (w.single ? !w.cur : (!w.prev || !w.cur || !w.next)) out.delete(f);
  return out;
}

// After a hand fix or "end here": solve again with everything already found.
function resolve(c) {
  const k = c.aScale;
  const forced = {};
  for (const [f, p] of Object.entries(c.fixes)) forced[f] = { x: p.x * k, y: p.y * k };
  const fixFrames = Object.keys(c.fixes).map(Number);
  const maxFix = fixFrames.length ? Math.max(...fixFrames) : -1;
  let trail;
  if (!fixFrames.length) {
    trail = c.carefulTrail;
  } else {
    const so = solveOpts(c);
    const merged = mergeFine(c.cands, c.fine || {}, k);
    // keep the careful landing unless a fix is beyond it
    const E = c.E && maxFix < c.E.f ? c.E : null;
    let path = solvePath(merged, teeA(c), E, forced, so);
    if (!E) {
      let li = landingIndex(path, so);
      path.forEach((p, i) => { if (p.kind === 'fix') li = Math.max(li, i); });
      path = path.slice(0, li + 1);
    }
    c.path = path;
    trail = smoothTrack(path).map((p) => ({ f: p.f, x: p.x / k, y: p.y / k }));
  }
  if (c.endAt !== null) {
    const cutT = trail.filter((p) => p.f <= c.endAt);
    if (cutT.length >= 2) trail = cutT;
  }
  c.trail = trail;
  c.report = checkTrail(trail, c.fine || {}, c.quick || trail, c.fixes, c.W, c.H);
  c.failed = trail.length < 3;
  showReport(c);
}

// ---------- the list ----------
function clipState(c) {
  if (c.status === 'failed') return { text: c.note || "Couldn't open this one.", cls: 'bad' };
  if (c.status === 'skipped' || !c.tee) return { text: 'Skipped', cls: '' };
  if (c.status === 'nofind' || c.failed) return { text: "Couldn't find the shot. Open it and use Fix on the ball.", cls: 'bad' };
  const r = c.report;
  if (r && r.runs.length) return { text: `${r.runs.length === 1 ? 'One spot' : `${r.runs.length} spots`} to look at`, cls: 'warn' };
  if (r) return { text: `Checked: ball under the line in ${r.seen} of ${r.total} frames`, cls: '' };
  return { text: '', cls: '' };
}
function showList() {
  S.cur = null;
  show('list');
  const ul = $('#clipList');
  ul.innerHTML = '';
  S.clips.forEach((c, i) => {
    const li = document.createElement('li');
    li.className = 'clip';
    const name = document.createElement('span'); name.className = 'name'; name.textContent = c.name;
    const st = clipState(c);
    const state = document.createElement('span'); state.className = `state ${st.cls}`; state.textContent = st.text;
    li.append(name, state);
    if (c.tee && c.status !== 'failed') {
      const b = document.createElement('button');
      b.className = 'btn go'; b.textContent = 'Open';
      b.onclick = () => openReview(i);
      li.append(b);
    } else if (c.status !== 'failed') {
      const b = document.createElement('button');
      b.className = 'btn go'; b.textContent = 'Tap the ball';
      b.onclick = async () => { await startTap(i); $('#tapNext').textContent = 'Trace it'; $('#tapNext').onclick = traceOne; };
      li.append(b);
    }
    ul.append(li);
  });
  const ready = S.clips.filter((c) => c.trail && !c.failed && c.status === 'done');
  $('#make').disabled = !ready.length;
  $('#make').textContent = ready.length > 1 ? `Make ${ready.length} videos` : 'Make the video';
}
async function traceOne() {
  // a clip tapped from the list later
  $('#tapNext').onclick = () => { const n = nextTapIndex(S.ci); if (n >= 0) startTap(n); else traceAll(); };
  const c = C();
  show('busy');
  try { await analyze(c, (a, b, t) => setBusy(a, b, t, c.name)); await careful(c, (a, b, t) => setBusy(a, b, t, c.name)); c.status = c.failed ? 'nofind' : 'done'; } catch (err) { c.status = 'failed'; c.note = String(err.message || err); }
  showList();
}

// ---------- review ----------
async function openReview(i) {
  S.ci = i;
  const c = C();
  show('review');
  sizeCanvas();
  $('#slider').max = c.n - 1;
  $('#reviewName').textContent = c.name;
  $('#undoFix').disabled = !c.history.length;
  showReport(c);
  scrollToStage();
  const mid = c.trail && c.trail.length > 1 ? Math.round((c.trail[0].f + c.trail[c.trail.length - 1].f) / 2) : c.tee.f;
  await goto(mid);
}
function showReport(c) {
  const el = $('#report');
  el.innerHTML = '';
  const p = document.createElement('p');
  if (c.failed || !c.trail || c.trail.length < 3) {
    el.className = 'report warn';
    p.textContent = "Couldn't find the shot. Step to a frame where the ball is in the air, press Fix this frame and tap it.";
    el.append(p);
    return;
  }
  const r = c.report;
  if (!r) return;
  if (!r.runs.length) {
    el.className = 'report ok';
    p.textContent = r.seen === r.total
      ? `Checked every frame up close: the ball is under the line in all ${r.total}.`
      : `Checked every frame up close: the ball is under the line in ${r.seen} of ${r.total}. The others are short gaps (blur, or the ball crossing a light), bridged from both sides.`;
    el.append(p);
    return;
  }
  el.className = 'report warn';
  p.textContent = 'Checked every frame up close. The ball was hard to see here — have a look, and fix a frame if the line is off:';
  const row = document.createElement('div');
  row.className = 'chips';
  for (const run of r.runs) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = run.from === run.to ? `Frame ${run.from}` : `Frames ${run.from}–${run.to}`;
    b.onclick = () => { stopPlay(); goto(run.from); };
    row.append(b);
  }
  el.append(p, row);
}
function setFixing(on) {
  S.fixing = on;
  $('#fix').classList.toggle('active', on);
  $('#fix').textContent = on ? 'Tap the ball…' : 'Fix this frame';
  canvas.classList.toggle('tappable', on);
  if (!on) { S.zoom = null; $('#zoomHint').hidden = true; }
  draw();
}
$('#fix').onclick = () => { stopPlay(); setFixing(!S.fixing); };
$('#endHere').onclick = () => {
  stopPlay();
  const c = C();
  c.history.push({ type: 'end', prev: c.endAt });
  c.endAt = S.frame;
  $('#undoFix').disabled = false;
  resolve(c); draw();
};
$('#undoFix').onclick = () => {
  const c = C();
  const h = c.history.pop();
  if (h?.type === 'fix') delete c.fixes[h.f];
  if (h?.type === 'end') c.endAt = h.prev;
  $('#undoFix').disabled = !c.history.length;
  resolve(c); draw();
};
$('#reviewDone').onclick = () => { stopPlay(); setFixing(false); showList(); };

document.querySelectorAll('.sw').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.sw').forEach((x) => { x.classList.remove('on'); x.setAttribute('aria-checked', 'false'); });
  b.classList.add('on'); b.setAttribute('aria-checked', 'true');
  S.color = b.dataset.color;
}));
$('#thick').oninput = (e) => { S.thick = +e.target.value; };
$('#trim').onchange = (e) => { S.trim = e.target.checked; };
const restart = () => { stopPlay(); S.clips = []; show('load'); };
$('#restart').onclick = restart;
$('#restart2').onclick = restart;
$('#again').onclick = () => showList();
$('#make').onclick = () => makeAll().catch((err) => { showList(); error(`Couldn't make the videos: ${err.message || err}`); });

// ---------- export ----------
async function makeAll() {
  stopPlay();
  const list = S.clips.filter((c) => c.trail && !c.failed && c.status === 'done');
  show('busy');
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const label = list.length > 1 ? `Video ${i + 1} of ${list.length}: ${c.name}` : c.name;
    await exportVideo(c, (frac, text) => setBusy('Making the video', frac, text, label));
  }
  await showDone(list);
}

async function exportVideo(c, progress) {
  const long = Math.max(c.W, c.H);
  const k = Math.min(1, 1920 / long);
  const OW = Math.round((c.W * k) / 2) * 2, OH = Math.round((c.H * k) / 2) * 2;
  const vcodec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: OW, height: OH });
  if (!vcodec) throw new Error("this browser can't encode video. Try Chrome or Safari.");
  const trail = c.trail;
  const strike = trail[0].f, landF = trail[trail.length - 1].f;
  const fA = S.trim ? Math.max(0, strike - Math.round(0.6 * c.fps)) : 0;
  const fB = S.trim ? Math.min(c.n - 1, landF + Math.round(0.9 * c.fps)) : c.n - 1;
  const holdFrames = Math.round(1.3 * c.fps);
  const dt = 1 / c.fps;

  const out = document.createElement('canvas');
  out.width = OW; out.height = OH;
  const octx = out.getContext('2d');
  octx.imageSmoothingQuality = 'high';
  const paint = (src, f) => {
    octx.drawImage(src, 0, 0, OW, OH);
    drawTrail(octx, f >= landF ? trail : trailUpTo(trail, f), 0, 0, k, trailWidth(c) * k, S.color);
  };

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const vsrc = new CanvasSource(out, { codec: vcodec, bitrate: 12e6, keyFrameInterval: 1 });
  output.addVideoTrack(vsrc, { frameRate: c.fps });
  let asrc = null;
  if (c.atrack && (await c.atrack.canDecode())) {
    const acodec = await getFirstEncodableAudioCodec(['aac', 'opus'], {
      numberOfChannels: c.atrack.numberOfChannels, sampleRate: c.atrack.sampleRate,
    });
    if (acodec) { asrc = new AudioBufferSource({ codec: acodec, bitrate: 160e3 }); output.addAudioTrack(asrc); }
  }
  await output.start();

  const total = fB - fA + 1 + holdFrames;
  const sink = new CanvasSink(c.vtrack, { poolSize: 2 });
  const eps = 0.25 / c.fps;
  let n = 0, last = null;
  for await (const wc of sink.canvases(c.times[fA] - eps, c.times[fB] + eps)) {
    const f = indexOf(c, wc.timestamp);
    if (f < fA || f > fB) continue;
    paint(wc.canvas, f);
    await vsrc.add(n * dt, dt);
    n++;
    last = wc.canvas;
    progress(n / total, `Frame ${n} of ${total}`);
  }
  for (let h = 0; h < holdFrames; h++) {
    if (last) paint(last, landF);
    await vsrc.add(n * dt, dt);
    n++;
  }
  vsrc.close();
  if (asrc) {
    const tA = c.times[fA], tEnd = tA + n * dt;
    const as = new AudioBufferSink(c.atrack);
    let written = 0;
    for await (const wb of as.buffers(tA, tEnd)) {
      let buf = wb.buffer;
      const skip = Math.max(0, tA - wb.timestamp);
      if (skip > 0 && written === 0) buf = sliceBuffer(buf, skip, buf.duration);
      const room = tEnd - tA - written;
      if (room <= 0) break;
      if (buf.duration > room) buf = sliceBuffer(buf, 0, room);
      await asrc.add(buf);
      written += buf.duration;
    }
    asrc.close();
  }
  await output.finalize();
  const blob = new Blob([output.target.buffer], { type: 'video/mp4' });
  if (c.out?.url) URL.revokeObjectURL(c.out.url);
  c.out = { blob, name: `${c.name}_trail.mp4`, url: URL.createObjectURL(blob), codec: vcodec };
}

function sliceBuffer(buf, t0, t1) {
  const sr = buf.sampleRate;
  const a = Math.max(0, Math.floor(t0 * sr)), b = Math.min(buf.length, Math.ceil(t1 * sr));
  const len = Math.max(1, b - a);
  const out = new AudioBuffer({ length: len, numberOfChannels: buf.numberOfChannels, sampleRate: sr });
  for (let ch = 0; ch < buf.numberOfChannels; ch++) out.copyToChannel(buf.getChannelData(ch).subarray(a, a + len), ch);
  return out;
}

async function showDone(list) {
  show('done');
  $('#doneTitle').textContent = list.length > 1 ? `Your ${list.length} videos are ready` : 'Your video is ready';
  const ul = $('#doneList');
  ul.innerHTML = '';
  for (const c of list) {
    const li = document.createElement('li');
    li.className = 'clip';
    const name = document.createElement('span'); name.className = 'name'; name.textContent = c.out.name;
    const a = document.createElement('a');
    a.className = 'btn go'; a.textContent = 'Download'; a.href = c.out.url; a.download = c.out.name;
    const v = document.createElement('video');
    v.src = c.out.url; v.controls = true; v.playsInline = true; v.preload = 'metadata';
    li.append(name, a, v);
    ul.append(li);
  }
  const all = $('#downloadAll');
  if (list.length > 1) {
    all.textContent = 'Download all (.zip)';
    if (S.zipUrl) URL.revokeObjectURL(S.zipUrl);
    S.zipUrl = URL.createObjectURL(await makeZip(list.map((c) => ({ name: c.out.name, blob: c.out.blob }))));
    all.href = S.zipUrl; all.download = 'fingagolf_trails.zip';
  } else {
    all.textContent = 'Download video';
    all.href = list[0].out.url; all.download = list[0].out.name;
  }
  const files = list.map((c) => new File([c.out.blob], c.out.name, { type: 'video/mp4' }));
  const share = $('#shareAll');
  share.hidden = !(navigator.canShare && navigator.canShare({ files }));
  share.textContent = list.length > 1 ? 'Share all' : 'Share';
  share.onclick = () => navigator.share({ files }).catch(() => {});
  $('#doneNote').textContent = list.some((c) => c.out.codec !== 'avc')
    ? "Saved with a newer video format; if an app won't open it, make the videos in Chrome or Safari on a computer." : '';
}

show('load');
// handle for automated tests
window.__fg = { S, goto, viewRect, C };
