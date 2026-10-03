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
  // separable square max filter (dilation) of radius r
  if (r <= 0) return m;
  const t = new Uint8Array(W * H);
  const o = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      let v = 0;
      const x0 = Math.max(0, x - r), x1 = Math.min(W - 1, x + r);
      for (let k = x0; k <= x1; k++) if (m[row + k]) { v = 1; break; }
      t[row + x] = v;
    }
  }
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      let v = 0;
      const y0 = Math.max(0, y - r), y1 = Math.min(H - 1, y + r);
      for (let k = y0; k <= y1; k++) if (t[k * W + x]) { v = 1; break; }
      o[y * W + x] = v;
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
  const scale = Math.min(W, H) / 1440;
  const amin = o.minArea ?? Math.max(2, Math.round(8 * scale * scale));
  const amax = o.maxArea ?? Math.round(20000 * scale * scale);
  const bodyArea = o.bodyArea ?? Math.round(80000 * scale * scale);
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

  // the player: very large moving regions, grown a little
  let body = null;
  if (bodyArea > 0) {
    const closed = minFilter(maxFilter(mov, W, H, 3), W, H, 3);
    const { lab, n: nb } = label(closed, W, H);
    const cnt = new Int32Array(nb + 1);
    for (let i = 0; i < n; i++) cnt[lab[i]]++;
    const big = new Uint8Array(n);
    let any = false;
    for (let i = 0; i < n; i++) if (lab[i] && cnt[lab[i]] >= bodyArea) { big[i] = 1; any = true; }
    if (any) body = maxFilter(big, W, H, Math.max(3, Math.round(15 * scale)));
  }

  // Blobs as they are, plus merged groups: a streaked ball close to the
  // camera splits in two (the part it shares with the neighbouring frames is
  // cut out), so nearby pieces are also offered as one candidate. Both are
  // kept — merging alone glues a ball to the club right after the hit.
  const out = [];
  const collect = (labRes, isMerged) => {
    const { lab, n: nl } = labRes;
    const sx = new Float64Array(nl + 1), sy = new Float64Array(nl + 1);
    const cnt = new Int32Array(nl + 1);
    const x0 = new Int32Array(nl + 1).fill(W), x1 = new Int32Array(nl + 1).fill(-1);
    const y0 = new Int32Array(nl + 1).fill(H), y1 = new Int32Array(nl + 1).fill(-1);
    const pieces = isMerged ? new Map() : null;
    for (let i = 0; i < n; i++) {
      if (!opened[i]) continue;
      const l = lab[i];
      if (!l) continue;
      const x = i % W, y = (i - x) / W;
      sx[l] += x; sy[l] += y; cnt[l]++;
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
      if (body && body[Math.round(cy) * W + Math.round(cx)]) continue;
      // u: how far off the centroid may be. A streaked ball's centroid
      // wanders along the streak.
      out.push({ x: cx, y: cy, a, u: Math.min(o.maxU ?? 8, 1.5 + 0.3 * (Math.max(w, h) - Math.min(w, h))), merged: isMerged });
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
  return out;
}

// ---------- path ----------

// cands: frame -> [{x,y,a}] in analysis px.
// tee: {x, y, f0, absent} — the tapped ball and the frame it was tapped in;
//   absent[f] from teePresence (>= 1 means the tee looks empty).
// E: {f,x,y} where the ball first lands (or drops in).
// forced: {frame: {x,y}} hand fixes. Returns [{f,x,y,kind}] tee -> landing;
// the first point is the tee in the last frame before the ball moves.
export function solvePath(cands, tee, E, forced = {}, o = {}) {
  for (const lt of [o.leaveThresh ?? 0.8, 0.4, -1]) {
    const r = solveOnce(cands, tee, E, forced, { ...o, leaveThresh: lt });
    if (r) return r;
  }
  return fallbackPath(tee, E, forced, Math.min(tee.f0, E.f - 1));
}

function fallbackPath(tee, E, forced, f0) {
  const ff = Object.keys(forced).map(Number).filter((f) => f > f0 && f < E.f).sort((a, b) => a - b);
  const pts = [{ f: f0, x: tee.x, y: tee.y, kind: 'tee' }];
  for (const f of ff) pts.push({ f, x: forced[f].x, y: forced[f].y, kind: 'fix' });
  pts.push({ f: E.f, x: E.x, y: E.y, kind: 'land' });
  return pts;
}

function solveOnce(cands, tee, E, forced, o) {
  const fps = o.fps ?? 50;
  const H = o.H ?? 960;
  const sig = (o.sigmaAcc ?? 1.1) * Math.pow(50 / fps, 2) * (H / 960);
  const R = o.nodeReward ?? 2.5;
  const Cm = o.missCost ?? 0.6;
  const Pa = o.absentCost ?? 0.6;
  const K = o.keepPerFrame ?? 8;
  const G = o.maxGap ?? 30;
  const capCost = 400;
  const vmax = (o.vmax ?? 0.3) * H * (50 / fps);
  const nearTee = (o.nearTee ?? 0.12) * H;
  const f0 = Math.min(tee.f0, E.f - 1);
  const forcedFrames = Object.keys(forced).map(Number).filter((f) => f > f0 && f < E.f).sort((a, b) => a - b);
  const firstForced = forcedFrames.length ? forcedFrames[0] : Infinity;

  const nodes = [];
  for (let f = f0; f < E.f; f++) {
    // the ball cannot still be on the tee after a hand fix further along
    if (f >= firstForced) break;
    nodes.push({ f, x: tee.x, y: tee.y, kind: 'tee' });
  }
  for (let f = f0 + 1; f < E.f; f++) {
    if (forced[f]) { nodes.push({ f, x: forced[f].x, y: forced[f].y, kind: 'fix' }); continue; }
    const c = cands[f];
    if (!c) continue;
    for (const p of c.slice(0, K)) nodes.push({ f, x: p.x, y: p.y, u: p.u ?? 1.5, kind: 'det' });
  }
  nodes.push({ f: E.f, x: E.x, y: E.y, kind: 'land' });
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
    const reward = nc.kind === 'det' ? R : 0;
    for (let j = 0; j < pl.length; j++) {
      const b = pl[j];
      const nb = nodes[b];
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
          if (ac > capCost) ac = capCost;
          if (prevCost + ac < best) { best = prevCost + ac; arg = i; }
          continue;
        }
        const t1 = nb.f - na.f, t2 = nc.f - nb.f;
        const px = nb.x + (nb.x - na.x) * t2 / t1;
        const py = nb.y + (nb.y - na.y) * t2 / t1;
        const d = Math.hypot(nc.x - px, nc.y - py);
        // position error expected from a constant acceleration over the gap,
        // plus ~1.5 px of centroid noise
        const tol = 0.5 * sig * t2 * (t1 + t2) + (na.u ?? 1.5) + (nb.u ?? 1.5) + (nc.u ?? 1.5);
        let ac = (d / tol) * (d / tol);
        if (ac > capCost) ac = capCost;
        const tot = prevCost + ac;
        if (tot < best) { best = tot; arg = i; }
      }
      if (arg >= 0) { cost[c][j] = best + gapC; back[c][j] = arg; }
    }
  }
  const e = N - 1;
  let bj = -1, bc = Infinity;
  for (let j = 0; j < preds[e].length; j++) if (cost[e][j] < bc) { bc = cost[e][j]; bj = j; }
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
  return path.map((p) => ({ f: p.f, x: p.x, y: p.y, kind: p.kind }));
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
