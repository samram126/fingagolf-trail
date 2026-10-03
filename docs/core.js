// Finger golf trail: tracking core.
// Pure functions on grayscale frames, no DOM, so the same file runs in the
// browser and in Node tests.
//
// The person taps the ball twice: once sitting at address, once where it
// first lands (or drops in the cup). Between those two fixed points the ball
// is found with consecutive-frame differencing, and the most physical path
// through the candidates is chosen with dynamic programming. Knowing both ends
// is what makes this robust: shots toward the camera (ball starts as a speck),
// apex gaps, a ball crossing the player's face. Any frame can be pinned by hand
// ("fix") and the path is re-solved through it.

// ---------- image helpers ----------

export function blur3(src, W, H) {
  // 3x3 binomial blur, returns Int16Array
  const tmp = new Int16Array(W * H);
  const out = new Int16Array(W * H);
  for (let y = 0; y < H; y++) {
    const r = y * W;
    for (let x = 0; x < W; x++) {
      const a = src[r + (x > 0 ? x - 1 : x)];
      const b = src[r + x];
      const c = src[r + (x < W - 1 ? x + 1 : x)];
      tmp[r + x] = a + 2 * b + c;
    }
  }
  for (let y = 0; y < H; y++) {
    const up = (y > 0 ? y - 1 : y) * W;
    const r = y * W;
    const dn = (y < H - 1 ? y + 1 : y) * W;
    for (let x = 0; x < W; x++) {
      out[r + x] = (tmp[up + x] + 2 * tmp[r + x] + tmp[dn + x] + 8) >> 4;
    }
  }
  return out;
}

export function rgbaToGray(rgba, n) {
  const g = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  }
  return g;
}

function maxFilter(m, W, H, r) {
  // separable square dilation of radius r, O(1) per pixel (running counts)
  if (r <= 0) return m;
  const t = new Uint8Array(W * H);
  const o = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    let c = 0;
    for (let x = 0; x < Math.min(W, r); x++) c += m[row + x];
    for (let x = 0; x < W; x++) {
      if (x + r < W) c += m[row + x + r];
      if (x - r - 1 >= 0) c -= m[row + x - r - 1];
      t[row + x] = c > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < W; x++) {
    let c = 0;
    for (let y = 0; y < Math.min(H, r); y++) c += t[y * W + x];
    for (let y = 0; y < H; y++) {
      if (y + r < H) c += t[(y + r) * W + x];
      if (y - r - 1 >= 0) c -= t[(y - r - 1) * W + x];
      o[y * W + x] = c > 0 ? 1 : 0;
    }
  }
  return o;
}

function minFilter(m, W, H, r) {
  if (r <= 0) return m;
  const inv = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) inv[i] = m[i] ? 0 : 1;
  const d = maxFilter(inv, W, H, r);
  for (let i = 0; i < W * H; i++) d[i] = d[i] ? 0 : 1;
  return d;
}

function label(mask, W, H) {
  // 8-connected labelling; returns Int32Array labels (0 = background), count
  const lab = new Int32Array(W * H);
  const stack = new Int32Array(W * H);
  let n = 0;
  for (let i = 0; i < W * H; i++) {
    if (!mask[i] || lab[i]) continue;
    n++;
    let sp = 0;
    stack[sp++] = i;
    lab[i] = n;
    while (sp) {
      const p = stack[--sp];
      const px = p % W, py = (p - px) / W;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = py + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = px + dx;
          if (xx < 0 || xx >= W) continue;
          const q = yy * W + xx;
          if (mask[q] && !lab[q]) { lab[q] = n; stack[sp++] = q; }
        }
      }
    }
  }
  return { lab, n };
}

// ---------- ball candidates ----------

// prev = frame f-2, cur = frame f, next = frame f+2 (blurred Int16 arrays).
// A pixel is "ball" only if it is brighter than BOTH neighbours: that isolates
// the ball itself rather than the patch it just uncovered, and needs no
// background model.
export function frameCandidates(prev, cur, next, W, H, o = {}) {
  const diff = o.diff ?? 10;
  // thresholds were tuned with the short side at 480 px (1440 native)
  const scale = (o.scaleShort ?? Math.min(W, H)) / 1440;
  const amin = o.minArea ?? Math.max(2, Math.round(8 * scale * scale));
  const amax = o.maxArea ?? Math.round(20000 * scale * scale);
  const bodyArea = o.bodyArea ?? Math.round(20000 * scale * scale);
  const mergeR = o.mergeR ?? Math.max(2, Math.round(15 * scale));
  const K = o.maxPerFrame ?? 20;
  const n = W * H;

  const m = new Uint8Array(n);
  const mov = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = cur[i] - prev[i];
    if (a > diff && cur[i] - next[i] > diff) m[i] = 1;
    if (a > diff || a < -diff) mov[i] = 1;
  }
  // At full resolution a 3x3 opening removes speckle; at analysis resolution a
  // distant ball is only 2-3 px across and would be erased, so the minimum
  // area does that job instead.
  const opened = o.open ? maxFilter(minFilter(m, W, H, 1), W, H, 1) : m;
  if (o.open) for (let i = 0; i < n; i++) opened[i] = opened[i] && m[i] ? 1 : 0;

  // The player: large moving regions. Small blobs inside one (folds of a
  // shirt, fingers, a face) are not the ball. A ball close to the camera can
  // itself make a big moving region, but then it IS most of that region —
  // so only blobs that are small next to their region are dropped.
  let bodyLab = null, bodyCnt = null;
  if (bodyArea > 0) {
    const cr = Math.max(2, Math.round(9 * scale));
    const closed = minFilter(maxFilter(mov, W, H, cr), W, H, cr);
    const L = label(closed, W, H);
    const cnt = new Int32Array(L.n + 1);
    for (let i = 0; i < n; i++) cnt[L.lab[i]]++;
    bodyLab = L.lab; bodyCnt = cnt;
  }
  const inBody = (cx, cy, a) => {
    if (!bodyLab) return false;
    // look a little around the blob: the region may hug its edge
    const r = Math.max(2, Math.round(6 * scale));
    let best = 0;
    for (const [dx, dy] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) {
      const x = Math.min(W - 1, Math.max(0, Math.round(cx + dx))), y = Math.min(H - 1, Math.max(0, Math.round(cy + dy)));
      const l = bodyLab[y * W + x];
      if (l && bodyCnt[l] > best) best = bodyCnt[l];
    }
    return best >= bodyArea && a < (o.bodyShare ?? 0.12) * best;
  };

  // Blobs as they are, plus merged groups: a streaked ball close to the
  // camera splits in two (the part it shares with the neighbouring frames is
  // cut out), so nearby pieces are also offered as one candidate. Both are
  // kept — merging alone glues a ball to the club right after the hit.
  const out = [];
  const collect = (labRes, isMerged) => {
    const { lab, n: nl } = labRes;
    const sx = new Float64Array(nl + 1), sy = new Float64Array(nl + 1);
    const cnt = new Int32Array(nl + 1);
    const rgba = o.rgba;
    const sr = rgba ? new Float64Array(nl + 1) : null, sgc = rgba ? new Float64Array(nl + 1) : null, sbc = rgba ? new Float64Array(nl + 1) : null;
    const x0 = new Int32Array(nl + 1).fill(W), x1 = new Int32Array(nl + 1).fill(-1);
    const y0 = new Int32Array(nl + 1).fill(H), y1 = new Int32Array(nl + 1).fill(-1);
    const pieces = isMerged ? new Map() : null;
    for (let i = 0; i < n; i++) {
      if (!opened[i]) continue;
      const l = lab[i];
      if (!l) continue;
      const x = i % W, y = (i - x) / W;
      sx[l] += x; sy[l] += y; cnt[l]++;
      if (rgba) { sr[l] += rgba[4 * i]; sgc[l] += rgba[4 * i + 1]; sbc[l] += rgba[4 * i + 2]; }
      if (x < x0[l]) x0[l] = x; if (x > x1[l]) x1[l] = x;
      if (y < y0[l]) y0[l] = y; if (y > y1[l]) y1[l] = y;
      if (pieces) {
        const s0 = single.lab[i];
        let set = pieces.get(l);
        if (!set) pieces.set(l, (set = new Set()));
        set.add(s0);
      }
    }
    for (let l = 1; l <= nl; l++) {
      const a = cnt[l];
      if (a < amin || a > amax) continue;
      if (pieces && (pieces.get(l)?.size ?? 0) < 2) continue; // same as a single blob
      const w = x1[l] - x0[l] + 1, h = y1[l] - y0[l] + 1;
      if (Math.max(w, h) > 12 * Math.max(1, Math.min(w, h))) continue;
      const cx = sx[l] / a, cy = sy[l] / a;
      if (inBody(cx, cy, a)) continue;
      // u: how far off the centroid may be. A streaked ball's centroid
      // wanders along the streak.
      const c = { x: cx, y: cy, a, u: Math.min(o.maxU ?? 8, 1.5 + 0.3 * (Math.max(w, h) - Math.min(w, h))), merged: isMerged };
      if (rgba) c.rgb = [sr[l] / a, sgc[l] / a, sbc[l] / a];
      out.push(c);
    }
  };
  const single = label(opened, W, H);
  collect(single, false);
  if (mergeR > 0) collect(label(minFilter(maxFilter(opened, W, H, mergeR), W, H, mergeR), W, H), true);
  out.sort((p, q) => q.a - p.a);
  return out.slice(0, K);
}

// ---------- tee presence ----------

// crops: array (by frame) of Uint8 gray patches of the tee area at native
// resolution (cw x ch), centred on the tapped ball. Returns, per frame, how
// different the tee looks from the tapped frame (0 = ball sitting there,
// >= 1 = clearly not). The path solver turns this into a small cost for
// "still on the tee", so it decides itself when the ball leaves — a hand
// covering the ball before a flick no longer fools it.
export function teePresence(crops, cw, ch, tapF, endF, o = {}) {
  const ref = crops[tapF];
  const out = new Float32Array(endF + 1);
  if (!ref) return out;
  // where the ball sits in the crop (the crop is shifted at frame edges)
  const cx = Math.round(o.cx ?? (cw >> 1)), cy = Math.round(o.cy ?? (ch >> 1));
  const edge = Math.max(3, Math.min(cx, cy, cw - 1 - cx, ch - 1 - cy));
  let rb = o.ballRadius;
  if (!rb) {
    const ring = [];
    for (let r = 1; r < edge; r++) {
      let s = 0;
      for (let t = 0; t < 24; t++) {
        const xx = Math.round(cx + r * Math.cos(t * Math.PI / 12));
        const yy = Math.round(cy + r * Math.sin(t * Math.PI / 12));
        s += ref[yy * cw + xx];
      }
      ring.push(s / 24);
    }
    const c0 = ref[cy * cw + cx];
    const bg = ring[ring.length - 1];
    rb = ring.length;
    for (let r = 0; r < ring.length; r++) if (ring[r] < (c0 + bg) / 2) { rb = r + 1; break; }
    rb = Math.max(2, Math.min(rb, edge - 4));
  }
  // Compare only the middle of the ball: a distant ball is a few pixels
  // across, and averaging over a wider disk drowns its departure in grass.
  const Rc = Math.max(1, Math.round(rb * 0.6));
  const idx = [];
  for (let y = -Rc; y <= Rc; y++) for (let x = -Rc; x <= Rc; x++) {
    if (x * x + y * y <= Rc * Rc) idx.push((cy + y) * cw + cx + x);
  }
  let inner = 0;
  for (const i of idx) inner += ref[i];
  inner /= idx.length;
  const r1 = rb + 2, r2 = rb + 5;
  let outer = 0, k = 0;
  for (let y = -r2; y <= r2; y++) for (let x = -r2; x <= r2; x++) {
    const d = x * x + y * y;
    if (d > r1 * r1 && d <= r2 * r2 && cx + x >= 0 && cx + x < cw && cy + y >= 0 && cy + y < ch) {
      outer += ref[(cy + y) * cw + cx + x]; k++;
    }
  }
  outer /= Math.max(1, k);
  const contrast = Math.max(6, Math.abs(inner - outer));
  for (let f = tapF; f <= endF; f++) {
    const c = crops[f];
    if (!c) { out[f] = 1; continue; }
    let s = 0;
    for (const i of idx) s += Math.abs(c[i] - ref[i]);
    out[f] = s / idx.length / contrast / 0.5;
  }
  out.ballRadius = rb; // native px, handy for following a roll
  return out;
}

// ---------- path ----------

// Colour difference between a candidate and the ball, as chromaticity (how
// the light splits between red, green and blue, ignoring brightness). A white
// or coloured ball keeps its chromaticity when lit differently; a hand, a
// face or a shirt does not have the ball's.
export function chromaDist(a, b) {
  const sa = a[0] + a[1] + a[2] + 1, sb = b[0] + b[1] + b[2] + 1;
  return (Math.abs(a[0] / sa - b[0] / sb) + Math.abs(a[1] / sa - b[1] / sb) + Math.abs(a[2] / sa - b[2] / sb)) / 2;
}

// Average colour of the ball at address: the brighter half of the pixels
// within radius r of (x, y) in an RGBA image.
export function ballColor(rgba, W, H, x, y, r) {
  const px = [];
  for (let yy = Math.max(0, Math.round(y - r)); yy <= Math.min(H - 1, Math.round(y + r)); yy++) {
    for (let xx = Math.max(0, Math.round(x - r)); xx <= Math.min(W - 1, Math.round(x + r)); xx++) {
      if ((xx - x) ** 2 + (yy - y) ** 2 > r * r) continue;
      const i = 4 * (yy * W + xx);
      px.push([rgba[i], rgba[i + 1], rgba[i + 2], rgba[i] + rgba[i + 1] + rgba[i + 2]]);
    }
  }
  px.sort((p, q) => q[3] - p[3]);
  const top = px.slice(0, Math.max(1, Math.ceil(px.length / 2)));
  const m = [0, 0, 0];
  for (const p of top) { m[0] += p[0]; m[1] += p[1]; m[2] += p[2]; }
  return m.map((v) => v / top.length);
}

// cands: frame -> [{x,y,a,u,rgb}] in analysis px.
// tee: {x, y, f0, absent, rgb} — the tapped ball, the frame it was tapped in,
//   absent[f] from teePresence (>= 1: the tee looks empty), and the ball's
//   colour.
// E: {f,x,y} to end the path at a known landing, or null to let the solver
//   end it wherever the ball stops being seen (o.endF bounds the search).
// forced: {frame: {x,y}} hand fixes. Returns [{f,x,y,kind}] from the tee
// (last frame before the ball moves) to the end.
export function solvePath(cands, tee, E, forced = {}, o = {}) {
  for (const lt of [o.leaveThresh ?? 0.8, 0.4, -1]) {
    const r = solveOnce(cands, tee, E, forced, { ...o, leaveThresh: lt });
    if (r) return r;
  }
  return fallbackPath(tee, E, forced, E ? Math.min(tee.f0, E.f - 1) : tee.f0);
}

function fallbackPath(tee, E, forced, f0) {
  const ff = Object.keys(forced).map(Number).filter((f) => f > f0 && (!E || f < E.f)).sort((a, b) => a - b);
  const pts = [{ f: f0, x: tee.x, y: tee.y, kind: 'tee' }];
  for (const f of ff) pts.push({ f, x: forced[f].x, y: forced[f].y, kind: 'fix' });
  if (E) pts.push({ f: E.f, x: E.x, y: E.y, kind: 'land' });
  return pts;
}

function solveOnce(cands, tee, E, forced, o) {
  const fps = o.fps ?? 50;
  const H = o.H ?? 960;
  const sig = (o.sigmaAcc ?? 1.1) * Math.pow(50 / fps, 2) * (H / 960);
  const R0 = o.rewardBase ?? 0.9, R1 = o.rewardMove ?? 2.1;
  const vRef = (o.vRef ?? 6) * (H / 960) * (50 / fps); // ~16 px/frame at 1440x2560, 50 fps
  const breakCost = o.breakCost ?? 16;
  const Cm = o.missCost ?? 0.6;
  const Pa = o.absentCost ?? 0.6;
  const K = o.keepPerFrame ?? 8;
  const G = o.maxGap ?? 30;
  const capCost = 400;
  const vmax = (o.vmax ?? 0.3) * H * (50 / fps);
  const colC = o.colorCost ?? 4;
  const col0 = o.colorFrom ?? 0.075, col1 = o.colorTo ?? 0.13;
  const lastF = E ? E.f : o.endF;
  const f0 = Math.min(tee.f0, lastF - 1);
  const teeLast = Math.min(lastF - 1, tee.f1 ?? lastF - 1);
  const forcedFrames = Object.keys(forced).map(Number).filter((f) => f > f0 && f <= lastF).sort((a, b) => a - b);
  const firstForced = forcedFrames.length ? forcedFrames[0] : Infinity;
  const lastForced = forcedFrames.length ? forcedFrames[forcedFrames.length - 1] : -Infinity;

  const nodes = [];
  for (let f = f0; f <= teeLast; f++) {
    // the ball cannot still be on the tee after a hand fix further along
    if (f >= firstForced) break;
    nodes.push({ f, x: tee.x, y: tee.y, kind: 'tee' });
  }
  const detEnd = E ? E.f - 1 : lastF;
  for (let f = f0 + 1; f <= detEnd; f++) {
    if (forced[f]) { nodes.push({ f, x: forced[f].x, y: forced[f].y, kind: 'fix' }); continue; }
    const c = cands[f];
    if (!c) continue;
    const fineC = c.filter((p) => p.fine);
    const keep = fineC.concat(c.filter((p) => !p.fine).slice(0, Math.max(0, K - fineC.length)));
    for (const p of keep) {
      let pen = 0;
      if (tee.rgb && p.rgb) {
        const d = chromaDist(p.rgb, tee.rgb);
        pen = colC * Math.min(1, Math.max(0, (d - col0) / (col1 - col0)));
      }
      nodes.push({ f, x: p.x, y: p.y, u: p.u ?? 1.5, kind: 'det', fine: !!p.fine, pen });
    }
  }
  if (E) nodes.push({ f: E.f, x: E.x, y: E.y, kind: 'land' });
  nodes.sort((a, b) => a.f - b.f || (a.kind === 'tee' ? -1 : 1));
  const N = nodes.length;
  const jumpsForced = (fa, fc) => {
    for (const ff of forcedFrames) if (ff > fa && ff < fc) return true;
    return false;
  };
  const preds = new Array(N), cost = new Array(N), back = new Array(N);
  let lo = 0;
  let prevTee = -1;
  for (let c = 0; c < N; c++) {
    const nc = nodes[c];
    if (nc.kind === 'tee') {
      const absent = tee.absent ? Math.min(1.5, tee.absent[nc.f] || 0) : 0;
      const step = absent >= 1 ? Pa : 0;
      if (prevTee < 0) {
        preds[c] = [-1]; cost[c] = Float64Array.of(0); back[c] = Int32Array.of(-1);
      } else {
        preds[c] = [prevTee];
        cost[c] = Float64Array.of(cost[prevTee][0] + step);
        back[c] = Int32Array.of(0);
      }
      prevTee = c;
      continue;
    }
    while (nodes[lo].f < nc.f - G) lo++;
    const pl = [];
    for (let b = lo; b < c; b++) {
      const nb = nodes[b];
      if (nb.f >= nc.f) break;
      if (jumpsForced(nb.f, nc.f)) continue;
      // can't leave the tee while the ball is plainly still sitting on it:
      // the frame after the last tee frame must look different
      if (nb.kind === 'tee' && tee.absent && nb.f + 1 < tee.absent.length &&
          tee.absent[nb.f + 1] < (o.leaveThresh ?? 0.8)) continue;
      const gap = nc.f - nb.f;
      const sp = Math.hypot(nc.x - nb.x, nc.y - nb.y) / gap;
      if (sp > vmax && (nc.kind === 'det' || nb.kind === 'det')) continue;
      pl.push(b);
    }
    preds[c] = pl;
    cost[c] = new Float64Array(pl.length).fill(Infinity);
    back[c] = new Int32Array(pl.length).fill(-1);
    const baseReward = nc.kind === 'det' ? (nc.fine ? (o.fineBonus ?? 0.5) : 0) - nc.pen : 0;
    for (let j = 0; j < pl.length; j++) {
      const b = pl[j];
      const nb = nodes[b];
      // A detection is worth more when the thing moved: a ball in the air
      // travels; an arm or a shirt drifting about barely does.
      let reward = 0;
      if (nc.kind === 'det') {
        const step = Math.hypot(nc.x - nb.x, nc.y - nb.y) / (nc.f - nb.f);
        reward = R0 + R1 * Math.min(1, step / vRef) + baseReward;
      }
      const gapC = Cm * (nc.f - nb.f - 1) - reward;
      if (nb.kind === 'tee') {
        // leaving the tee: no velocity to compare against yet
        cost[c][j] = cost[b][0] + gapC;
        back[c][j] = 0;
        continue;
      }
      const pb = preds[b];
      let best = Infinity, arg = -1;
      for (let i = 0; i < pb.length; i++) {
        const prevCost = cost[b][i];
        if (prevCost === Infinity) continue;
        const na = nodes[pb[i]];
        if (na.kind === 'tee') {
          // The ball is often hidden (hand, blur) for a few frames after the
          // hit, so the tee says nothing about its speed — but the ball still
          // leaves in a straight line. Check direction only.
          const ux = nb.x - na.x, uy = nb.y - na.y;
          const ul = Math.hypot(ux, uy) || 1;
          const vx = nc.x - nb.x, vy = nc.y - nb.y;
          const t1 = nb.f - na.f, t2 = nc.f - nb.f;
          const perp = Math.abs(ux * vy - uy * vx) / ul;
          const along = (ux * vx + uy * vy) / ul;
          const tol = 0.5 * sig * t2 * (t1 + t2) + 3;
          let ac = along < -tol ? capCost : (perp / tol) * (perp / tol);
          // ...and at a speed that carries on: a ball that left the tee at
          // 100 px/frame isn't crawling at 10 the frame after. (Something
          // that "leaves" impossibly fast and then crawls is the player.)
          const v1 = ul / t1, v2 = Math.hypot(vx, vy) / t2;
          const ratio = (v1 + 2) / (v2 + 2);
          const rHi = o.launchRatio ?? 4, rLo = 1 / (o.launchRatioLow ?? 6);
          if (ratio > rHi) ac += (o.launchCost ?? 6) * Math.log(ratio / rHi) ** 2 + 3;
          else if (ratio < rLo) ac += (o.launchCost ?? 6) * Math.log(rLo / ratio) ** 2 + 3;
          if (ac > breakCost) continue; // not a ball leaving the tee
          if (prevCost + ac < best) { best = prevCost + ac; arg = i; }
          continue;
        }
        const t1 = nb.f - na.f, t2 = nc.f - nb.f;
        const px = nb.x + (nb.x - na.x) * t2 / t1;
        const py = nb.y + (nb.y - na.y) * t2 / t1;
        const d = Math.hypot(nc.x - px, nc.y - py);
        // position error expected from a constant acceleration over the gap,
        // plus the centroid noise of the three blobs
        const tol = 0.5 * sig * t2 * (t1 + t2) + (na.u ?? 1.5) + (nb.u ?? 1.5) + (nc.u ?? 1.5);
        const ac = (d / tol) * (d / tol);
        // a ball in flight can't do that: whatever comes next is something else
        if (ac > breakCost) continue;
        const tot = prevCost + ac;
        if (tot < best) { best = tot; arg = i; }
      }
      if (arg >= 0) { cost[c][j] = best + gapC; back[c][j] = arg; }
    }
  }
  // where the path ends: the fixed landing, or the best place to stop
  let e = -1, bj = -1, bc = Infinity;
  if (E) {
    e = N - 1;
    for (let j = 0; j < preds[e].length; j++) if (cost[e][j] < bc) { bc = cost[e][j]; bj = j; }
  } else {
    for (let c = 0; c < N; c++) {
      const nc = nodes[c];
      if (nc.kind === 'tee' || nc.f < lastForced) continue;
      for (let j = 0; j < preds[c].length; j++) {
        if (cost[c][j] < bc) { bc = cost[c][j]; bj = j; e = c; }
      }
    }
    if (e < 0 || bc >= 0) return null; // nothing that looks like a flight
  }
  if (bj < 0) return null;
  const path = [];
  let c = e, j = bj;
  while (c >= 0) {
    path.push(nodes[c]);
    if (nodes[c].kind === 'tee') break; // earlier tee frames are just "waiting"
    const b = preds[c][j];
    const i = back[c][j];
    c = b; j = i;
  }
  path.reverse();
  return path.map((p) => ({ f: p.f, x: p.x, y: p.y, kind: p.kind, fine: !!p.fine }));
}

// ---------- the landing ----------

// Where a trail should end. A shot in the air ends where it first lands: the
// ball was coming down and then stops coming down (it bounced or stuck). A
// roll or putt has no such moment and ends where the ball was last seen
// moving (stopped, or dropped in the cup).
// path: solver output (analysis px). Returns the index of the last point.
export function landingIndex(path, o = {}) {
  const fps = o.fps ?? 50;
  const H = o.H ?? 960;
  const k = (H / 960) * (50 / fps);       // px/frame scale
  const vDown = (o.vDown ?? 1.4) * k;     // ~4 px/frame at 1440x2560, 50 fps
  const pts = path.filter((p) => p.kind !== 'tee' || p === path[0]);
  if (pts.length < 4) return path.length - 1;
  // highest point of the flight (smallest y) after leaving the tee
  let apex = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i].y < pts[apex].y) apex = i;
  const rose = pts[0].y - pts[apex].y > 6 * k;
  const longGap = Math.max(5, Math.round((o.landGap ?? 0.12) * fps));
  for (let i = Math.max(apex, 1) + 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const v1 = (b.y - a.y) / (b.f - a.f);  // + = moving down the frame
    const v2 = (c.y - b.y) / (c.f - b.f);
    const coming = v1 > vDown && (rose || v1 > 2 * vDown);
    // it bounced or stuck
    if (coming && v2 < 0.3 * v1) return path.indexOf(b);
    // or it was coming down and then wasn't seen for a while: it landed and
    // stopped (anything found after that is something else moving)
    if (coming && c.f - b.f >= longGap) return path.indexOf(b);
  }
  // rolls: stop at a long gap too, once the ball has travelled
  for (let i = 2; i < pts.length - 1; i++) {
    if (pts[i + 1].f - pts[i].f >= 2 * longGap) return path.indexOf(pts[i]);
  }
  return path.length - 1;
}

// ---------- smoothing ----------

// Whittaker smoother with a third-difference penalty: parabolas pass through
// untouched (so the head never lags the ball the way a global fit does),
// jitter is removed, and the tee, landing and hand fixes are held exactly.
export function smoothTrack(path, o = {}) {
  const lam = o.lambda ?? 8;
  const f0 = path[0].f, f1 = path[path.length - 1].f;
  const N = f1 - f0 + 1;
  const w = new Float64Array(N), zx = new Float64Array(N), zy = new Float64Array(N);
  for (const p of path) {
    const i = p.f - f0;
    const wt = p.kind === 'det' ? 1 : 1e4;
    w[i] = wt; zx[i] = p.x * wt; zy[i] = p.y * wt;
  }
  if (N < 4) {
    // too short to smooth: linear interpolation
    return interpLinear(path);
  }
  // A = W + lam * D3' D3, banded with half-bandwidth 3
  const B = 3;
  const A = [];
  for (let i = 0; i < N; i++) A.push(new Float64Array(2 * B + 1));
  const d = [-1, 3, -3, 1];
  for (let r = 0; r + 3 < N; r++) {
    for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
      A[r + a][B + (r + b) - (r + a)] += lam * d[a] * d[b];
    }
  }
  for (let i = 0; i < N; i++) A[i][B] += w[i];
  const xs = bandSolve(A, zx, N, B);
  const ys = bandSolve(A, zy, N, B);
  const out = [];
  for (let i = 0; i < N; i++) out.push({ f: f0 + i, x: xs[i], y: ys[i] });
  return out;
}

function bandSolve(A0, rhs, N, B) {
  const A = A0.map((r) => Float64Array.from(r));
  const b = Float64Array.from(rhs);
  for (let k = 0; k < N; k++) {
    const piv = A[k][B];
    for (let i = k + 1; i <= Math.min(N - 1, k + B); i++) {
      const f = A[i][B + k - i] / piv;
      if (!f) continue;
      for (let j = k; j <= Math.min(N - 1, k + B); j++) A[i][B + j - i] -= f * A[k][B + j - k];
      b[i] -= f * b[k];
    }
  }
  const x = new Float64Array(N);
  for (let k = N - 1; k >= 0; k--) {
    let s = b[k];
    for (let j = k + 1; j <= Math.min(N - 1, k + B); j++) s -= A[k][B + j - k] * x[j];
    x[k] = s / A[k][B];
  }
  return x;
}

function interpLinear(path) {
  const out = [];
  for (let k = 0; k + 1 < path.length; k++) {
    const a = path[k], b = path[k + 1];
    for (let f = a.f; f < b.f; f++) {
      const t = (f - a.f) / (b.f - a.f);
      out.push({ f, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  const l = path[path.length - 1];
  out.push({ f: l.f, x: l.x, y: l.y });
  return out;
}

// ---------- careful mode: full-resolution refinement ----------

// The first pass works on a reduced frame (854 px long side), where a distant
// ball is 2-3 px and a streak's centroid can sit well off the ball. Careful
// mode goes back to the original frames: around each point of the first
// trail it cuts a window, finds the ball there at full resolution, and offers
// those detections to the solver again. This is the "zoom in and check every
// frame" step.

// Window to search in frame f, native px. Wider when the ball is fast.
export function fineRect(trail, f, W, H, o = {}) {
  const byF = o.byF || indexTrail(trail);
  const p = byF.get(f);
  if (!p) return null;
  const a = byF.get(f - 1) || p, b = byF.get(f + 1) || p;
  const v = Math.hypot(b.x - a.x, b.y - a.y) / 2;
  const s = Math.min(W, H) / 1440;
  const R = Math.round(Math.min(380 * s, Math.max(40 * s, (o.base ?? 40) * s + 2.2 * v) * (o.widen ?? 1)));
  const x0 = Math.max(0, Math.round(p.x - R)), y0 = Math.max(0, Math.round(p.y - R));
  const x1 = Math.min(W, Math.round(p.x + R)), y1 = Math.min(H, Math.round(p.y + R));
  if (x1 - x0 < 8 || y1 - y0 < 8) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function indexTrail(trail) {
  const m = new Map();
  for (const p of trail) m.set(p.f, p);
  return m;
}

// prev/cur/next: Uint8 gray windows (same rect) from frames f-2, f, f+2 at
// native resolution. Returns candidates in window coordinates.
export function windowCandidates(prev, cur, next, w, h, nativeShort, o = {}) {
  const s = nativeShort / 1440;
  return frameCandidates(blur3(prev, w, h), blur3(cur, w, h), blur3(next, w, h), w, h, {
    rgba: o.rgba,
    diff: o.diff ?? 10,
    minArea: Math.max(4, Math.round(8 * s * s)),
    maxArea: Math.round(20000 * s * s),
    bodyArea: 0, // the window is small; the solver deals with the player
    mergeR: Math.max(2, Math.round(8 * s)),
    maxPerFrame: 6,
    open: true,
    scaleShort: nativeShort,
  });
}

// Merge full-resolution detections (native px, per frame) into the analysis
// candidates: they replace coarse ones that sit on the same blob.
export function mergeFine(cands, fine, k) {
  const out = {};
  const frames = new Set([...Object.keys(cands), ...Object.keys(fine)].map(Number));
  for (const f of frames) {
    const fl = (fine[f] || []).map((c) => ({
      x: c.x * k, y: c.y * k, a: c.a * k * k, u: Math.max(0.6, (c.u ?? 1.5) * k), fine: true, rgb: c.rgb,
    }));
    const coarse = (cands[f] || []).filter((c) => !fl.some((q) => Math.hypot(q.x - c.x, q.y - c.y) < 5));
    out[f] = fl.concat(coarse);
  }
  return out;
}

// ---------- careful mode: the whole double-checked pipeline ----------

// getWindows(requests) -> Promise<Map f -> {prev, cur, next}> where each
// request is {f, rect} and the windows are Uint8 gray crops of `rect` from
// frames f-2, f and f+2 at native resolution.
//
// 1. quick pass on the reduced frames (already in `cands`)
// 2. full-resolution look around every frame of that trail, re-solve
// 3. check every frame: is there a ball under the line, and do the quick and
//    careful passes agree? Where not, search a wider window and re-solve.
// 4. report what is still uncertain, so the person can look at those frames.
export async function carefulTrack(a) {
  const { cands, tee, forced = {}, k, W, H, getWindows, onProgress = () => {} } = a;
  const so = { fps: a.fps, H: a.analysisLong, endF: a.endF, ...(a.solveOpts || {}) };
  const toNative = (tr) => tr.map((p) => ({ f: p.f, x: p.x / k, y: p.y / k }));
  const forcedA = {};
  for (const [f, p] of Object.entries(forced)) forcedA[f] = { x: p.x * k, y: p.y * k };

  // quick pass, ending wherever the ball stops being seen, then cut at the
  // first landing
  let E = a.E || null;
  let path1 = solvePath(cands, tee, E, forcedA, so);
  if (!E) {
    if (path1.length < 3) return { failed: true, path: path1, trail: toNative(path1), quick: toNative(path1), fine: {}, report: { unsure: [], runs: [], seen: 0, total: 0 } };
    const li = Math.max(landingIndex(path1, so), lastForcedIndex(path1));
    path1 = path1.slice(0, li + 1);
    const l = path1[path1.length - 1];
    E = { f: l.f, x: l.x, y: l.y };
  }
  const quick = toNative(smoothTrack(path1));
  onProgress('quick', 1);

  const fine = {};
  const addFine = async (reqs, stage) => {
    if (!reqs.length) return;
    const wins = await getWindows(reqs, (fr) => onProgress(stage, fr));
    for (const r of reqs) {
      const w = wins.get(r.f);
      if (!w) continue;
      const cs = windowCandidates(w.prev, w.cur, w.next, r.rect.w, r.rect.h, Math.min(W, H), { rgba: w.rgba });
      const list = fine[r.f] || (fine[r.f] = []);
      for (const c of cs) {
        const q = { x: c.x + r.rect.x, y: c.y + r.rect.y, a: c.a, u: c.u, rgb: c.rgb };
        if (!list.some((z) => Math.hypot(z.x - q.x, z.y - q.y) < 3)) list.push(q);
      }
    }
  };
  const solveNow = () => {
    const path = solvePath(mergeFine(cands, fine, k), tee, E, forcedA, so);
    return { path, trail: smoothTrack(path).map((p) => ({ f: p.f, x: p.x / k, y: p.y / k })) };
  };

  // full-resolution look around the quick trail
  const byQ = indexTrail(quick);
  const reqs = [];
  for (let f = quick[0].f + 1; f <= E.f; f++) {
    if (forced[f]) continue;
    const rect = fineRect(quick, f, W, H, { byF: byQ });
    if (rect) reqs.push({ f, rect });
  }
  await addFine(reqs, 'fine');
  if (!a.E && fine[E.f] && fine[E.f].length) {
    // the landing itself, at full resolution: nearest detection to the quick one
    const qx = E.x / k, qy = E.y / k;
    const best = fine[E.f].reduce((m, c) => (Math.hypot(c.x - qx, c.y - qy) < Math.hypot(m.x - qx, m.y - qy) ? c : m));
    if (Math.hypot(best.x - qx, best.y - qy) < 40 * Math.min(W, H) / 1440) E = { f: E.f, x: best.x * k, y: best.y * k };
  }
  let cur = solveNow();
  let report = checkTrail(cur.trail, fine, quick, forced, W, H);

  // look wider wherever the check failed, then solve again
  for (let round = 0; round < (a.rounds ?? 2) && report.unsure.length; round++) {
    const byT = indexTrail(cur.trail);
    const more = [];
    for (const f of report.unsure) {
      const r1 = fineRect(cur.trail, f, W, H, { byF: byT, widen: 2.5 + round });
      if (r1) more.push({ f, rect: r1 });
      // also around where the quick pass had the ball, if it disagreed
      const q = byQ.get(f), t = byT.get(f);
      if (q && t && Math.hypot(q.x - t.x, q.y - t.y) > 30) {
        const r2 = fineRect(quick, f, W, H, { byF: byQ, widen: 2 });
        if (r2) more.push({ f, rect: r2 });
      }
    }
    // windows for the same frame are fetched one request at a time
    const byFrame = new Map();
    for (const m of more) { if (!byFrame.has(m.f)) byFrame.set(m.f, []); byFrame.get(m.f).push(m); }
    for (let pass = 0; ; pass++) {
      const batch = [];
      for (const list of byFrame.values()) if (list[pass]) batch.push(list[pass]);
      if (!batch.length) break;
      await addFine(batch, 'recheck');
    }
    cur = solveNow();
    report = checkTrail(cur.trail, fine, quick, forced, W, H);
  }
  // rolls: follow the ball on by its look, or trim a tail that left it
  if (!a.E && a.follow !== false) {
    const t2 = await followRoll(cur.trail, { W, H, getWindows, fps: a.fps, endF: a.endF, ballRadius: a.ballRadius });
    if (t2 !== cur.trail) {
      cur = { path: cur.path, trail: t2 };
      report = checkTrail(cur.trail, fine, quick, forced, W, H);
      onProgress('follow', 1);
    }
  }
  return { path: cur.path, trail: cur.trail, quick, fine, report, E };
}

function lastForcedIndex(path) {
  let li = 0;
  path.forEach((p, i) => { if (p.kind === 'fix') li = i; });
  return li;
}

// Per-frame check of a finished trail (native px).
//  - seen: a full-resolution detection lies under the line in that frame
//  - agree: the quick pass put the ball in about the same place
// Frames that fail either are "unsure"; runs of them are what the person is
// asked to look at.
export function checkTrail(trail, fine, quick, forced, W, H, o = {}) {
  const s = Math.min(W, H) / 1440;
  const byQ = indexTrail(quick);
  const byT = indexTrail(trail);
  const unsure = [];
  let seen = 0, total = 0;
  for (let i = 1; i < trail.length - 1; i++) {
    const p = trail[i];
    if (forced[p.f]) { seen++; total++; continue; }
    const a = byT.get(p.f - 1) || p, b = byT.get(p.f + 1) || p;
    const v = Math.hypot(b.x - a.x, b.y - a.y) / 2;
    const tol = Math.max(14 * s, 0.35 * v + 8 * s);
    const ds = (fine[p.f] || []).map((c) => Math.hypot(c.x - p.x, c.y - p.y));
    const isSeen = p.seen || (ds.length && Math.min(...ds) <= tol);
    total++;
    if (isSeen) seen++;
    // seen at full resolution: confirmed, whatever the quick pass thought
    if (!isSeen) unsure.push(p.f);
  }
  // Short unseen stretches are normal — the ball crosses a light or the
  // ceiling near the apex, or blurs at launch — and the line there is bridged
  // from both sides. Ask the person to look only at long ones (the ball
  // really was lost) and at frames where the two passes disagree.
  const longRun = o.longRun ?? 9;
  const unseenRuns = [];
  for (const f of unsure) {
    const r = unseenRuns[unseenRuns.length - 1];
    if (r && f - r.to <= 1) r.to = f; else unseenRuns.push({ from: f, to: f });
  }
  const flagged = [];
  for (const r of unseenRuns) {
    for (let f = r.from; f <= r.to; f++) {
      const q = byQ.get(f), p = byT.get(f);
      const dis = q && p && Math.hypot(q.x - p.x, q.y - p.y) > Math.max(30 * s, 20);
      if (r.to - r.from + 1 >= longRun || dis) flagged.push(f);
    }
  }
  const runs = [];
  for (const f of flagged) {
    const r = runs[runs.length - 1];
    if (r && f - r.to <= 2) r.to = f; else runs.push({ from: f, to: f });
  }
  return { unsure: flagged, runs, seen, total, estimated: unsure.length - flagged.length };
}

// ---------- careful mode: carry a rolling ball on, trim the tail ----------

// Normalised cross-correlation of template T (tw x th) inside image I (iw x ih)
// at every offset; returns the best {x, y, score} (top-left of the match).
function nccSearch(I, iw, ih, T, tw, th) {
  let tm = 0;
  for (let i = 0; i < T.length; i++) tm += T[i];
  tm /= T.length;
  let tv = 0;
  for (let i = 0; i < T.length; i++) tv += (T[i] - tm) ** 2;
  if (tv < 1) return null;
  let best = { score: -2, x: 0, y: 0 };
  const n = tw * th;
  for (let y = 0; y + th <= ih; y++) {
    for (let x = 0; x + tw <= iw; x++) {
      let s = 0, s2 = 0, st = 0;
      for (let v = 0; v < th; v++) {
        const row = (y + v) * iw + x, trow = v * tw;
        for (let u = 0; u < tw; u++) {
          const p = I[row + u];
          s += p; s2 += p * p; st += p * (T[trow + u] - tm);
        }
      }
      const iv = s2 - (s * s) / n;
      if (iv < 1) continue;
      const score = st / Math.sqrt(iv * tv);
      if (score > best.score) best = { score, x, y };
    }
  }
  return best;
}

function cut(img, w, x, y, cw, ch) {
  const o = new Uint8Array(cw * ch);
  for (let v = 0; v < ch; v++) o.set(img.subarray((y + v) * w + x, (y + v) * w + x + cw), v * cw);
  return o;
}

// After the main trail: if the ball was rolling slowly at the end, follow it
// by its look (template matching at full resolution) until it stops or drops
// in; and if the last points have drifted off the ball, trim them.
// trail: native [{f,x,y}]. Returns a new trail.
export async function followRoll(trail, a) {
  const { W, H, getWindows, fps = 50, endF } = a;
  const s = Math.min(W, H) / 1440;
  const k = 50 / fps;
  if (trail.length < 6) return trail;
  const n = trail.length;
  const last = trail[n - 1], prev = trail[n - 4];
  const speed = Math.hypot(last.x - prev.x, last.y - prev.y) / (last.f - prev.f);
  if (speed > (a.rollSpeed ?? 15) * s * k) return trail; // still flying: not a roll
  // the template frame must be slow too (a streaked ball matches anything)
  const tq = trail[Math.max(1, n - 8)], tq0 = trail[Math.max(0, n - 11)];
  if (Math.hypot(tq.x - tq0.x, tq.y - tq0.y) / Math.max(1, tq.f - tq0.f) > (a.rollSpeed ?? 15) * s * k) return trail;
  const r = Math.round(Math.max(6 * s, Math.min(40 * s, a.ballRadius ?? 12 * s)));
  const T = 2 * r + 1;

  // template: the ball at a frame where it was moving slowly and clearly seen
  const grab = async (f, cx, cy, R) => {
    const x0 = Math.max(0, Math.round(cx - R)), y0 = Math.max(0, Math.round(cy - R));
    const x1 = Math.min(W, Math.round(cx + R)), y1 = Math.min(H, Math.round(cy + R));
    const rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    const m = await getWindows([{ f, rect, single: true }]);
    const w = m.get(f);
    return w ? { img: w.cur, rect } : null;
  };
  const tplAt = async (p) => {
    const g = await grab(p.f, p.x, p.y, r + 1);
    if (!g || g.rect.w < T || g.rect.h < T) return null;
    const ox = Math.round(p.x - r) - g.rect.x, oy = Math.round(p.y - r) - g.rect.y;
    if (ox < 0 || oy < 0 || ox + T > g.rect.w || oy + T > g.rect.h) return null;
    return cut(g.img, g.rect.w, ox, oy, T, T);
  };
  const matchAt = async (f, px, py, R, tpl) => {
    const g = await grab(f, px, py, R + r + 1);
    if (!g || g.rect.w < T || g.rect.h < T) return null;
    const b = nccSearch(g.img, g.rect.w, g.rect.h, tpl, T, T);
    if (!b) return null;
    return { x: g.rect.x + b.x + r, y: g.rect.y + b.y + r, score: b.score };
  };

  let out = trail.slice();
  // trim: the line drifted on after the ball stopped. Evidence: in the last
  // frame, the ball (template) is not under the line but IS sitting at an
  // earlier point of it. Walk back to where it stopped.
  let tpl = await tplAt(out[Math.max(1, n - 8)]);
  if (!tpl) return trail;
  {
    const end = out[out.length - 1];
    const here = await matchAt(end.f, end.x, end.y, Math.round(3 * s), tpl);
    if (!here || here.score < 0.5) {
      for (let i = out.length - 2; i >= Math.max(1, out.length - 25); i--) {
        const q = out[i];
        const there = await matchAt(end.f, q.x, q.y, Math.round(3 * s), tpl);
        if (there && there.score >= 0.75) {
          // the ball is still at q in the last frame: it stopped at q
          return out.slice(0, i + 1);
        }
      }
    }
  }

  // extend: follow it while it keeps rolling
  const maxF = Math.min(endF ?? Infinity, last.f + Math.round(3 * fps));
  let still = 0, misses = 0;
  let cur = out[out.length - 1], before = out[out.length - 2];
  for (let f = cur.f + 1; f <= maxF; f++) {
    const vx = (cur.x - before.x) / (cur.f - before.f), vy = (cur.y - before.y) / (cur.f - before.f);
    const px = cur.x + vx, py = cur.y + vy;
    const R = Math.round(Math.max(3 * r, 2 * Math.hypot(vx, vy) + r));
    const m = await matchAt(f, px, py, R, tpl);
    // strict: a ball sinking into the cup or behind something stops matching
    if (!m || m.score < (a.followMatch ?? 0.8)) break;
    misses = 0;
    const step = Math.hypot(m.x - cur.x, m.y - cur.y) / (f - cur.f);
    if (step < 0.6 * s * k) { if (++still >= 3) break; } else still = 0;
    const p = { f, x: m.x, y: m.y, seen: true };
    out.push(p);
    before = cur; cur = p;
    if (m.score > 0.85) { const t2 = await tplAt(p); if (t2) tpl = t2; }
  }
  // drop the frames where it had already stopped
  while (still > 0 && out.length > n && still--) out.pop();
  return out;
}
