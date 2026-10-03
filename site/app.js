// Fingagolf Trail — the page. Tracking lives in core.js; decoding and
// encoding use Mediabunny (WebCodecs), so every frame is read and written
// exactly, at hardware speed, whatever the device.
import { blur3, rgbaToGray, frameCandidates, teePresence, solvePath, smoothTrack } from './core.js';
import {
  Input, ALL_FORMATS, BlobSource, CanvasSink, EncodedPacketSink, AudioBufferSink,
  Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource,
  getFirstEncodableVideoCodec, getFirstEncodableAudioCodec,
} from './vendor/mediabunny.min.mjs';

export const VERSION = '1.0.0';
const REPO = 'https://github.com/samram126/fingagolf-trail';

const $ = (s) => document.querySelector(s);
const canvas = $('#stage');
const ctx = canvas.getContext('2d');

const ANALYSIS_LONG = 854; // analysis frames: long side in px (480 x 854 for portrait)

const S = {
  step: 'load',
  input: null, vtrack: null, atrack: null, sink: null,
  times: [], fps: 30, n: 0, W: 0, H: 0,
  frame: 0, cur: null,  // current frame canvas (native size)
  tee: null, land: null, // {f,x,y} native px
  fixes: {}, fixOrder: [], fixing: false,
  zoom: null,
  cands: null, absent: null, aScale: 1, aDims: null,
  path: null, trail: null,
  color: '#ff0000', thick: 1, trim: true,
  playing: false,
  fileName: 'shot',
  resultUrl: null,
};

$('#ver').textContent = `Version ${VERSION}`;
$('#repoLink').href = REPO;

// ---------- steps ----------
function show(step) {
  S.step = step;
  document.querySelectorAll('.step').forEach((el) => { el.hidden = el.dataset.step !== step; });
  $('#scrub').hidden = !['tee', 'land', 'review'].includes(step);
  $('#drop').hidden = step !== 'load';
  canvas.classList.toggle('tappable', step === 'tee' || step === 'land' || S.fixing);
  hideError();
  draw();
}
function error(msg) { const e = $('#error'); e.textContent = msg; e.hidden = false; }
function hideError() { $('#error').hidden = true; }
function setBusy(title, frac, text) {
  $('#busyTitle').textContent = title;
  $('#barFill').style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
  $('#busyText').textContent = text;
}
const yieldUI = () => new Promise((r) => setTimeout(r, 0));

// ---------- loading ----------
$('#file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) load(f); e.target.value = ''; });
const drop = $('#drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) load(f); });

async function load(file) {
  if (!('VideoDecoder' in window)) {
    error('This browser is too old to read video frames. Use a recent Chrome, Edge, Safari or Firefox.');
    return;
  }
  reset();
  S.fileName = (file.name || 'shot').replace(/\.[^.]+$/, '');
  show('busy');
  setBusy('Opening the video', 0.1, '');
  try {
    S.input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    S.vtrack = await S.input.getPrimaryVideoTrack();
    if (!S.vtrack) throw new Error('No video track in that file.');
    if (!(await S.vtrack.canDecode())) {
      throw new Error("This browser can't decode that video's format. iPhone clips (HEVC) open in Safari; or export the clip as \"Most compatible\" (H.264).");
    }
    S.atrack = await S.input.getPrimaryAudioTrack();
    S.W = S.vtrack.displayWidth; S.H = S.vtrack.displayHeight;
    // exact frame list: presentation timestamps of every packet
    const ps = new EncodedPacketSink(S.vtrack);
    const times = [];
    let p = await ps.getFirstPacket({ metadataOnly: true });
    while (p) {
      times.push(p.timestamp);
      if ((times.length & 63) === 0) setBusy('Opening the video', 0.1 + Math.min(0.8, times.length / 2000), '');
      p = await ps.getNextPacket(p, { metadataOnly: true });
    }
    times.sort((a, b) => a - b);
    if (times.length < 5) throw new Error('That clip is too short.');
    S.times = times;
    S.n = times.length;
    const d = [];
    for (let i = 1; i < times.length; i++) d.push(times[i] - times[i - 1]);
    d.sort((a, b) => a - b);
    S.fps = Math.round(1 / d[d.length >> 1]) || 30;
    S.sink = new CanvasSink(S.vtrack, { poolSize: 2 });
  } catch (err) {
    show('load');
    error(err.message || "Couldn't open that video.");
    return;
  }
  sizeCanvas();
  $('#slider').max = S.n - 1;
  await goto(0);
  show('tee');
}

function reset() {
  stopPlay();
  Object.assign(S, { tee: null, land: null, fixes: {}, fixOrder: [], fixing: false, zoom: null,
    cands: null, absent: null, path: null, trail: null, frame: 0, cur: null });
  $('#teeStatus').textContent = 'Not marked yet.'; $('#teeStatus').classList.remove('ok');
  $('#landStatus').textContent = 'Not marked yet.'; $('#landStatus').classList.remove('ok');
  $('#toLand').disabled = true; $('#trace').disabled = true;
  $('#undoFix').disabled = true;
}

// nearest frame index for a timestamp
function indexOf(t) {
  const a = S.times;
  let lo = 0, hi = a.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < t) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(a[lo - 1] - t) < Math.abs(a[lo] - t)) lo--;
  return lo;
}

// ---------- frames ----------
let gotoSeq = 0;
async function goto(i) {
  i = Math.max(0, Math.min(S.n - 1, i | 0));
  S.frame = i;
  $('#slider').value = i;
  $('#frameNo').textContent = i;
  const seq = ++gotoSeq;
  const wc = await S.sink.getCanvas(S.times[i]);
  if (seq !== gotoSeq || !wc) return; // a newer request won
  S.cur = wc.canvas;
  draw();
}

// ---------- drawing ----------
function sizeCanvas() {
  const box = $('#stageBox').getBoundingClientRect();
  const k = Math.min(box.width / S.W, box.height / S.H);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.style.width = `${Math.round(S.W * k)}px`;
  canvas.style.height = `${Math.round(S.H * k)}px`;
  canvas.width = Math.round(S.W * k * dpr);
  canvas.height = Math.round(S.H * k * dpr);
}
window.addEventListener('resize', () => { if (S.W) { sizeCanvas(); draw(); } });

function viewRect() {
  if (!S.zoom) return { x: 0, y: 0, w: S.W, h: S.H };
  const k = 4, w = S.W / k, h = S.H / k;
  return {
    x: Math.max(0, Math.min(S.W - w, S.zoom.x - w / 2)),
    y: Math.max(0, Math.min(S.H - h, S.zoom.y - h / 2)),
    w, h,
  };
}

function trailUpTo(f) {
  if (!S.trail) return null;
  if (f <= S.trail[0].f) return null;
  return S.trail.filter((p) => p.f <= f);
}

function drawTrail(c, pts, sx, sy, sc, width, color) {
  if (!pts || pts.length < 2) return;
  c.save();
  c.lineJoin = 'round';
  c.lineCap = 'round';
  c.strokeStyle = color;
  c.lineWidth = width;
  c.beginPath();
  c.moveTo((pts[0].x - sx) * sc, (pts[0].y - sy) * sc);
  for (let i = 1; i < pts.length; i++) c.lineTo((pts[i].x - sx) * sc, (pts[i].y - sy) * sc);
  c.stroke();
  c.restore();
}
const trailWidth = () => Math.max(3, S.W * 0.0085) * S.thick;

function draw() {
  if (!S.W || !S.cur) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
  const v = viewRect();
  const sc = canvas.width / v.w;
  ctx.drawImage(S.cur, v.x, v.y, v.w, v.h, 0, 0, canvas.width, canvas.height);
  if (S.step === 'review' || S.step === 'done') {
    drawTrail(ctx, trailUpTo(S.frame), v.x, v.y, sc, trailWidth() * sc, S.color);
  }
  const mark = (p, color, label) => {
    if (!p) return;
    const x = (p.x - v.x) * sc, y = (p.y - v.y) * sc;
    const r = Math.max(10, canvas.width * 0.025);
    ctx.save();
    ctx.lineWidth = Math.max(2, canvas.width * 0.006);
    ctx.strokeStyle = color;
    ctx.globalAlpha = p.f === S.frame ? 1 : 0.5;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    if (label) {
      ctx.fillStyle = color;
      ctx.font = `700 ${Math.round(r * 0.95)}px "Atkinson Hyperlegible", sans-serif`;
      ctx.fillText(label, x + r * 1.2, y - r * 0.6);
    }
    ctx.restore();
  };
  if (S.step === 'tee' || S.step === 'land') {
    mark(S.tee, '#ffd23f', '1');
    mark(S.land, '#ffd23f', '2');
  }
  if (S.step === 'review' && S.fixes[S.frame]) mark({ f: S.frame, ...S.fixes[S.frame] }, '#18c8ff', 'fix');
}

// ---------- taps ----------
canvas.addEventListener('click', (e) => {
  const tapping = S.step === 'tee' || S.step === 'land' || S.fixing;
  if (!tapping || S.playing) return;
  const r = canvas.getBoundingClientRect();
  const v = viewRect();
  const x = v.x + ((e.clientX - r.left) / r.width) * v.w;
  const y = v.y + ((e.clientY - r.top) / r.height) * v.h;
  if (!S.zoom) {
    // first tap zooms in around the ball so the second can be exact
    S.zoom = { x, y };
    $('#zoomHint').hidden = false;
    draw();
    return;
  }
  S.zoom = null;
  $('#zoomHint').hidden = true;
  const p = { f: S.frame, x, y };
  if (S.fixing) {
    setFixing(false);
    S.fixes[S.frame] = { x, y };
    S.fixOrder = S.fixOrder.filter((f) => f !== S.frame).concat(S.frame);
    $('#undoFix').disabled = false;
    solve();
    draw();
    return;
  }
  if (S.step === 'tee') {
    if (S.land && p.f >= S.land.f - 2) S.land = null;
    S.tee = p;
    $('#teeStatus').textContent = `Ball marked in frame ${p.f}.`;
    $('#teeStatus').classList.add('ok');
    $('#toLand').disabled = false;
  } else {
    if (p.f <= S.tee.f + 2) {
      error('The landing has to come after the frame where you tapped the ball at rest. Step forward and tap again.');
      return;
    }
    hideError();
    S.land = p;
    $('#landStatus').textContent = `Landing marked in frame ${p.f}.`;
    $('#landStatus').classList.add('ok');
    $('#trace').disabled = false;
  }
  draw();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.zoom) { S.zoom = null; $('#zoomHint').hidden = true; draw(); }
  if (!['tee', 'land', 'review'].includes(S.step) || e.target.matches('input')) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); goto(S.frame - 1); }
  if (e.key === 'ArrowRight') { e.preventDefault(); goto(S.frame + 1); }
  if (e.key === ' ') { e.preventDefault(); S.playing ? stopPlay() : startPlay(); }
});

$('#prev').onclick = () => { stopPlay(); goto(S.frame - 1); };
$('#next').onclick = () => { stopPlay(); goto(S.frame + 1); };
$('#slider').oninput = (e) => { stopPlay(); goto(+e.target.value); };
$('#play').onclick = () => (S.playing ? stopPlay() : startPlay());
$('#toLand').onclick = () => { show('land'); if (S.land) goto(S.land.f); };
$('#backTee').onclick = () => { show('tee'); if (S.tee) goto(S.tee.f); };
$('#trace').onclick = () => analyze();

// ---------- preview playback (no sound; the finished video has it) ----------
async function startPlay() {
  if (S.playing || !S.sink) return;
  S.playing = true;
  S.zoom = null; $('#zoomHint').hidden = true;
  $('#play').setAttribute('aria-label', 'Pause');
  $('#playIcon').innerHTML = '<path d="M7 5h4v14H7zM13 5h4v14h-4z" class="fill"/>';
  let start = S.frame >= S.n - 1 ? 0 : S.frame;
  const t0 = S.times[start];
  const wall0 = performance.now();
  const play = new CanvasSink(S.vtrack, { poolSize: 3 });
  try {
    for await (const wc of play.canvases(t0)) {
      if (!S.playing) break;
      const wait = (wc.timestamp - t0) * 1000 - (performance.now() - wall0);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (!S.playing) break;
      S.cur = wc.canvas;
      S.frame = indexOf(wc.timestamp);
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

// ---------- analysis ----------
async function analyze() {
  if (!S.tee || !S.land) return;
  stopPlay();
  show('busy');
  setBusy('Finding the ball', 0, '');
  const long = Math.max(S.W, S.H);
  const k = ANALYSIS_LONG / long;
  const AW = Math.round(S.W * k), AH = Math.round(S.H * k);
  S.aScale = k; S.aDims = { AW, AH };
  const off = document.createElement('canvas');
  off.width = AW; off.height = AH;
  const octx = off.getContext('2d', { willReadFrequently: true });
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  const C = Math.max(64, Math.round(long * 0.05)) & ~1;
  const cc = document.createElement('canvas');
  cc.width = C; cc.height = C;
  const cctx = cc.getContext('2d', { willReadFrequently: true });
  const csx = Math.max(0, Math.min(S.W - C, Math.round(S.tee.x - C / 2)));
  const csy = Math.max(0, Math.min(S.H - C, Math.round(S.tee.y - C / 2)));

  const from = Math.max(0, S.tee.f - 2), to = Math.min(S.n - 1, S.land.f + 2);
  const blurred = new Map();
  const crops = [];
  const cands = {};
  const total = to - from + 1;
  const sink = new CanvasSink(S.vtrack, { poolSize: 2 });
  const eps = 0.25 / S.fps;
  let count = 0;
  const handle = (i) => {
    const f = i - 2;
    if (f > S.tee.f && f < S.land.f && blurred.has(f - 2) && blurred.has(f)) {
      cands[f] = frameCandidates(blurred.get(f - 2), blurred.get(f), blurred.get(i), AW, AH);
    }
    blurred.delete(i - 4);
  };
  for await (const wc of sink.canvases(S.times[from] - eps, S.times[to] + eps)) {
    const i = indexOf(wc.timestamp);
    if (i < from || i > to) continue;
    octx.drawImage(wc.canvas, 0, 0, AW, AH);
    blurred.set(i, blur3(rgbaToGray(octx.getImageData(0, 0, AW, AH).data, AW * AH), AW, AH));
    if (i >= S.tee.f) {
      cctx.drawImage(wc.canvas, csx, csy, C, C, 0, 0, C, C);
      crops[i] = rgbaToGray(cctx.getImageData(0, 0, C, C).data, C * C);
    }
    handle(i);
    count++;
    setBusy('Finding the ball', count / total, `Frame ${count} of ${total}`);
    if ((count & 3) === 0) await yieldUI();
  }
  S.cands = cands;
  S.absent = teePresence(crops, C, C, S.tee.f, S.land.f, { cx: S.tee.x - csx, cy: S.tee.y - csy });
  solve();
  show('review');
  await goto(Math.round((S.trail[0].f + S.land.f) / 2));
}

function solve() {
  const k = S.aScale;
  const forced = {};
  for (const [f, p] of Object.entries(S.fixes)) forced[f] = { x: p.x * k, y: p.y * k };
  S.path = solvePath(
    S.cands,
    { x: S.tee.x * k, y: S.tee.y * k, f0: S.tee.f, absent: S.absent },
    { f: S.land.f, x: S.land.x * k, y: S.land.y * k },
    forced,
    { fps: S.fps, H: Math.max(S.aDims.AW, S.aDims.AH) },
  );
  S.trail = smoothTrack(S.path).map((p) => ({ f: p.f, x: p.x / k, y: p.y / k }));
}

// ---------- review ----------
function setFixing(on) {
  S.fixing = on;
  $('#fix').classList.toggle('active', on);
  $('#fix').textContent = on ? 'Tap the ball…' : 'Fix this frame';
  canvas.classList.toggle('tappable', on);
  if (!on) { S.zoom = null; $('#zoomHint').hidden = true; }
  draw();
}
$('#fix').onclick = () => { stopPlay(); setFixing(!S.fixing); };
$('#undoFix').onclick = () => {
  const f = S.fixOrder.pop();
  if (f !== undefined) delete S.fixes[f];
  $('#undoFix').disabled = !S.fixOrder.length;
  solve(); draw();
};
document.querySelectorAll('.sw').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.sw').forEach((x) => { x.classList.remove('on'); x.setAttribute('aria-checked', 'false'); });
  b.classList.add('on'); b.setAttribute('aria-checked', 'true');
  S.color = b.dataset.color; draw();
}));
$('#thick').oninput = (e) => { S.thick = +e.target.value; draw(); };
$('#trim').onchange = (e) => { S.trim = e.target.checked; };
const restart = () => { reset(); S.W = 0; show('load'); };
$('#restart').onclick = restart;
$('#restart2').onclick = restart;
$('#again').onclick = () => { show('review'); goto(S.frame); };
$('#make').onclick = () => exportVideo().catch((err) => {
  show('review');
  error(`Couldn't make the video: ${err.message || err}`);
});

// ---------- export ----------
async function exportVideo() {
  stopPlay();
  S.zoom = null;
  show('busy');
  setBusy('Making the video', 0, '');
  const long = Math.max(S.W, S.H);
  const k = Math.min(1, 1920 / long);
  const OW = Math.round((S.W * k) / 2) * 2, OH = Math.round((S.H * k) / 2) * 2;
  const vcodec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: OW, height: OH });
  if (!vcodec) throw new Error("this browser can't encode video. Try Chrome or Safari.");

  const strike = S.trail[0].f, landF = S.trail[S.trail.length - 1].f;
  const fA = S.trim ? Math.max(0, strike - Math.round(0.6 * S.fps)) : 0;
  const fB = S.trim ? Math.min(S.n - 1, landF + Math.round(0.9 * S.fps)) : S.n - 1;
  const holdFrames = Math.round(1.3 * S.fps);
  const dt = 1 / S.fps;

  const out = document.createElement('canvas');
  out.width = OW; out.height = OH;
  const octx = out.getContext('2d');
  octx.imageSmoothingQuality = 'high';
  const paint = (src, f) => {
    octx.drawImage(src, 0, 0, OW, OH);
    drawTrail(octx, f >= landF ? S.trail : trailUpTo(f), 0, 0, k, trailWidth() * k, S.color);
  };

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const vsrc = new CanvasSource(out, { codec: vcodec, bitrate: 12e6, keyFrameInterval: 1 });
  output.addVideoTrack(vsrc, { frameRate: S.fps });
  let asrc = null, acodec = null;
  if (S.atrack && (await S.atrack.canDecode())) {
    acodec = await getFirstEncodableAudioCodec(['aac', 'opus'], {
      numberOfChannels: S.atrack.numberOfChannels, sampleRate: S.atrack.sampleRate,
    });
    if (acodec) {
      asrc = new AudioBufferSource({ codec: acodec, bitrate: 160e3 });
      output.addAudioTrack(asrc);
    }
  }
  await output.start();

  const total = fB - fA + 1 + holdFrames;
  const sink = new CanvasSink(S.vtrack, { poolSize: 2 });
  const eps = 0.25 / S.fps;
  let n = 0, last = null;
  for await (const wc of sink.canvases(S.times[fA] - eps, S.times[fB] + eps)) {
    const f = indexOf(wc.timestamp);
    if (f < fA || f > fB) continue;
    paint(wc.canvas, f);
    await vsrc.add(n * dt, dt);
    n++;
    last = wc.canvas;
    setBusy('Making the video', n / total, `Frame ${n} of ${total}`);
  }
  // hold the finished trail for a moment
  for (let h = 0; h < holdFrames; h++) {
    if (last) paint(last, landF);
    await vsrc.add(n * dt, dt);
    n++;
  }
  vsrc.close();

  if (asrc) {
    const tA = S.times[fA], tEnd = tA + n * dt;
    const as = new AudioBufferSink(S.atrack);
    let written = 0; // seconds of audio written
    for await (const wb of as.buffers(tA, tEnd)) {
      // trim the first buffer so sound lines up with the first video frame
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
  if (S.resultUrl) URL.revokeObjectURL(S.resultUrl);
  S.resultUrl = URL.createObjectURL(blob);
  const name = `${S.fileName}_trail.mp4`;
  $('#result').src = S.resultUrl;
  $('#download').href = S.resultUrl;
  $('#download').download = name;
  $('#doneNote').textContent = vcodec === 'avc' ? '' : 'Saved with a newer video format; if an app won\'t open it, make the video in Chrome or Safari on a computer.';
  const file = new File([blob], name, { type: 'video/mp4' });
  const share = $('#share');
  share.hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
  share.onclick = () => navigator.share({ files: [file] }).catch(() => {});
  show('done');
}

function sliceBuffer(buf, t0, t1) {
  const sr = buf.sampleRate;
  const a = Math.max(0, Math.floor(t0 * sr)), b = Math.min(buf.length, Math.ceil(t1 * sr));
  const len = Math.max(1, b - a);
  const out = new AudioBuffer({ length: len, numberOfChannels: buf.numberOfChannels, sampleRate: sr });
  for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).subarray(a, a + len), c);
  return out;
}

show('load');
// handle for automated tests
window.__fg = { S, goto, viewRect };
