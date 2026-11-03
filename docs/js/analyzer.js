// Samples a local video file entirely in the browser.
//
// Nothing is uploaded: the File becomes a blob: URL, and several hidden <video>
// elements seek through different parts of the film in parallel, letting the
// browser's (usually hardware) decoder do the work. Each sampled frame is drawn
// onto a tiny 64x36 canvas and reduced to one colour.

import { frameColor } from './color.js';

const SAMPLE_W = 64;
const SAMPLE_H = 36;
const SEEK_TIMEOUT_MS = 8000;

function mediaErrorMessage(err) {
  if (err && err.code === 4) {
    return "Your browser can't play this file's format or codec. Try Chrome or Edge, " +
      'convert it to MP4 (H.264), or use the Python command-line tool.';
  }
  return 'The video could not be loaded' + (err && err.message ? `: ${err.message}` : '.');
}

function waitFor(target, events, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(null), ms);
    const onEvent = (e) => finish(e);
    const onError = () => { cleanup(); reject(new Error(mediaErrorMessage(target.error))); };
    function cleanup() {
      clearTimeout(timer);
      events.forEach((ev) => target.removeEventListener(ev, onEvent));
      target.removeEventListener('error', onError);
    }
    function finish(e) { cleanup(); resolve(e); }
    events.forEach((ev) => target.addEventListener(ev, onEvent));
    target.addEventListener('error', onError);
  });
}

async function openVideo(url, host) {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  host.appendChild(v);
  v.src = url;
  const ok = await waitFor(v, ['loadeddata'], 20000);
  if (!ok) throw new Error('Timed out while opening the video.');
  return v;
}

/** Files recorded by MediaRecorder etc. report duration = Infinity until you seek to the end. */
async function ensureDuration(v) {
  if (Number.isFinite(v.duration) && v.duration > 0) return v.duration;
  v.currentTime = 1e9;
  await waitFor(v, ['seeked'], 10000);
  const d = v.duration;
  v.currentTime = 0;
  await waitFor(v, ['seeked'], 5000);
  if (!Number.isFinite(d) || d <= 0) throw new Error('Could not determine the video length.');
  return d;
}

function seek(v, t, fast) {
  const p = waitFor(v, ['seeked'], SEEK_TIMEOUT_MS);
  if (fast && typeof v.fastSeek === 'function') v.fastSeek(t);
  else v.currentTime = t;
  return p;
}

function newContext(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

/**
 * Find letterbox / pillarbox bars. A row (or column) counts as picture if in
 * ANY sampled frame at least 20% of its pixels are brighter than near-black.
 * Using the union of all frames means dark scenes never crop real picture.
 */
async function detectCrop(v, t0, t1, samples = 12) {
  const W = 160, H = 90;
  const ctx = newContext(W, H);
  const rows = new Uint8Array(H);
  const cols = new Uint8Array(W);
  for (let s = 0; s < samples; s++) {
    await seek(v, t0 + ((s + 0.5) / samples) * (t1 - t0), true);
    ctx.drawImage(v, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;
    const rowHits = new Uint16Array(H);
    const colHits = new Uint16Array(W);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] > 24) { rowHits[y]++; colHits[x]++; }
      }
    }
    for (let y = 0; y < H; y++) if (rowHits[y] > W * 0.2) rows[y] = 1;
    for (let x = 0; x < W; x++) if (colHits[x] > H * 0.2) cols[x] = 1;
  }
  const y0 = rows.indexOf(1), y1 = rows.lastIndexOf(1);
  const x0 = cols.indexOf(1), x1 = cols.lastIndexOf(1);
  if (y0 < 0 || x0 < 0) return null; // every sample was black
  const vw = v.videoWidth, vh = v.videoHeight;
  // Shave one sample row/column inwards so the blurry bar edge isn't included.
  const top = y0 > 0 ? y0 + 1 : 0, bottom = y1 < H - 1 ? y1 : H;
  const left = x0 > 0 ? x0 + 1 : 0, right = x1 < W - 1 ? x1 : W;
  const rect = {
    sx: Math.round((left / W) * vw),
    sy: Math.round((top / H) * vh),
    sw: Math.round(((right - left) / W) * vw),
    sh: Math.round(((bottom - top) / H) * vh),
  };
  if (rect.sw >= vw - 2 && rect.sh >= vh - 2) return null; // no bars
  if (rect.sw < vw * 0.3 || rect.sh < vh * 0.3) return null; // implausible
  return rect;
}

/**
 * @param {Blob} file
 * @param {object} o
 * @param {number} o.samples      number of colour slices
 * @param {'average'|'dominant'} o.mode
 * @param {boolean} o.crop        auto-remove letterbox bars
 * @param {number} o.parallel     number of simultaneous decoders
 * @param {boolean} o.fast        keyframe seeking (Firefox / Safari only)
 * @param {number} o.start        seconds
 * @param {number|null} o.end     seconds
 * @param {(info:object)=>void} o.onStart
 * @param {(i:number, rgbLinear:number[], done:number)=>void} o.onSample
 * @param {AbortSignal} o.signal
 */
export async function analyzeVideo(file, o = {}) {
  const {
    samples = 800, mode = 'average', crop = true, parallel = 4, fast = false,
    start = 0, end = null, onStart, onSample, signal,
  } = o;
  const url = URL.createObjectURL(file);
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText =
    'position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:0;pointer-events:none;z-index:-1';
  document.body.appendChild(host);
  const videos = [];
  let stopped = false;
  const checkAbort = () => {
    if (stopped || signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  };

  try {
    const first = await openVideo(url, host);
    videos.push(first);
    if (!first.videoWidth) {
      throw new Error("This file's video track can't be decoded by your browser " +
        '(you may only get audio). Try Chrome/Edge, MP4 (H.264), or the Python tool.');
    }
    const duration = await ensureDuration(first);
    const t0 = Math.min(Math.max(0, start || 0), duration);
    const t1 = end ? Math.min(end, duration) : duration;
    if (t1 - t0 < 0.5) throw new Error('The selected time range is empty.');
    checkAbort();

    let rect = { sx: 0, sy: 0, sw: first.videoWidth, sh: first.videoHeight };
    let cropped = false;
    if (crop) {
      const found = await detectCrop(first, t0, t1);
      if (found) { rect = found; cropped = true; }
    }
    checkAbort();

    const extra = await Promise.allSettled(
      Array.from({ length: Math.max(0, parallel - 1) }, () => openVideo(url, host)));
    extra.forEach((r) => r.status === 'fulfilled' && videos.push(r.value));

    onStart?.({
      duration: t1 - t0, start: t0, width: first.videoWidth, height: first.videoHeight,
      crop: cropped ? rect : null, samples, decoders: videos.length,
    });

    const lin = new Float32Array(samples * 3);
    const timeOf = (i) => t0 + ((i + 0.5) / samples) * (t1 - t0);
    let done = 0;
    const n = videos.length;

    await Promise.all(videos.map(async (v, w) => {
      const ctx = newContext(SAMPLE_W, SAMPLE_H);
      const from = Math.floor((w * samples) / n);
      const to = Math.floor(((w + 1) * samples) / n);
      for (let i = from; i < to; i++) {
        checkAbort();
        await seek(v, timeOf(i), fast);
        checkAbort();
        ctx.drawImage(v, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, SAMPLE_W, SAMPLE_H);
        const c = frameColor(ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data, mode);
        lin.set(c, i * 3);
        done++;
        onSample?.(i, c, done);
      }
    }));

    return {
      lin, samples, mode, duration: t1 - t0, start: t0,
      width: first.videoWidth, height: first.videoHeight, crop: cropped ? rect : null,
    };
  } finally {
    stopped = true;
    videos.forEach((v) => { v.removeAttribute('src'); v.load(); });
    host.remove();
    URL.revokeObjectURL(url);
  }
}

export const canFastSeek = () => typeof HTMLVideoElement.prototype.fastSeek === 'function';
