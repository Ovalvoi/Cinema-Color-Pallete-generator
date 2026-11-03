import { analyzeVideo, canFastSeek } from './analyzer.js';
import { smooth, toSrgb, filmPalette, linearToSrgb8 } from './color.js';
import { draw, drawSlice, toPngBlob, toSvg } from './render.js';

const $ = (id) => document.getElementById(id);
const els = {
  drop: $('drop'), file: $('file'), pick: $('pick'), work: $('work'), stage: $('stage'), result: $('result'),
  samples: $('samples'), mode: $('mode'), start: $('start'), end: $('end'), parallel: $('parallel'),
  parallelVal: $('parallelVal'), crop: $('crop'), fast: $('fast'), fastWrap: $('fastWrap'),
  fileName: $('fileName'), status: $('status'), barFill: $('barFill'), cancel: $('cancel'),
  view: $('view'), canvasWrap: $('canvasWrap'), smooth: $('smooth'), exportSize: $('exportSize'),
  swatches: $('swatches'), stats: $('stats'), error: $('error'),
  dlPng: $('dlPng'), dlSvg: $('dlSvg'), dlJson: $('dlJson'), again: $('again'),
};

const state = { style: 'barcode', result: null, fileName: '', abort: null, srgb: null, palette: [] };

// ---------- settings (remembered per browser) ----------
const PREFS_KEY = 'cinema-palette-prefs';
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; }
}
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      samples: els.samples.value, mode: els.mode.value, parallel: els.parallel.value,
      crop: els.crop.checked, fast: els.fast.checked, style: state.style,
    }));
  } catch { /* storage unavailable: fine */ }
}
const prefs = loadPrefs();
if (prefs.samples) els.samples.value = prefs.samples;
if (prefs.mode) els.mode.value = prefs.mode;
els.parallel.value = prefs.parallel || Math.min(4, navigator.hardwareConcurrency || 4);
if (typeof prefs.crop === 'boolean') els.crop.checked = prefs.crop;
if (typeof prefs.fast === 'boolean') els.fast.checked = prefs.fast;
if (prefs.style) state.style = prefs.style;
els.fastWrap.hidden = !canFastSeek();
const showParallel = () => { els.parallelVal.textContent = els.parallel.value; };
showParallel();
els.parallel.addEventListener('input', showParallel);
[els.samples, els.mode, els.parallel, els.crop, els.fast].forEach((el) => el.addEventListener('change', savePrefs));

// ---------- helpers ----------
function parseTime(s) {
  s = (s || '').trim();
  if (!s) return null;
  let secs = 0;
  for (const part of s.split(':')) {
    const v = Number(part);
    if (!Number.isFinite(v) || part === '') throw new Error(`"${s}" is not a valid time. Use seconds, M:SS or H:MM:SS.`);
    secs = secs * 60 + v;
  }
  return secs;
}
const fmtTime = (sec) => {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
};
const baseName = () => state.fileName.replace(/\.[^.]+$/, '') || 'palette';
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
function showError(msg) {
  els.error.textContent = msg;
  els.error.hidden = !msg;
}
function setView(style) {
  // internal resolution of the on-screen canvas
  els.view.width = style === 'barcode' ? 1600 : 1000;
  els.view.height = style === 'barcode' ? 400 : 1000;
  els.canvasWrap.classList.toggle('ring', style !== 'barcode');
  const ctx = els.view.getContext('2d');
  ctx.clearRect(0, 0, els.view.width, els.view.height);
  return ctx;
}
function setStyleButtons() {
  document.querySelectorAll('.seg button').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.style === state.style)));
}

// ---------- file intake ----------
els.file.addEventListener('change', () => {
  const f = els.file.files[0];
  els.file.value = '';
  if (f) start(f);
});
['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => {
  e.preventDefault();
  if (!els.pick.hidden) els.drop.classList.add('over');
}));
['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => {
  e.preventDefault();
  if (ev === 'dragleave' && e.relatedTarget) return;
  els.drop.classList.remove('over');
}));
document.addEventListener('drop', (e) => {
  const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('video/') || /\.(mkv|mov|m4v|avi|webm|mp4)$/i.test(x.name))
    || e.dataTransfer?.files?.[0];
  if (f && !els.pick.hidden) start(f);
});

// ---------- run ----------
async function start(file) {
  showError('');
  let startSec, endSec;
  try {
    startSec = parseTime(els.start.value) || 0;
    endSec = parseTime(els.end.value);
  } catch (e) { showError(e.message); return; }

  state.fileName = file.name;
  els.fileName.textContent = file.name;
  els.status.textContent = 'Opening video…';
  els.barFill.style.width = '0%';
  els.pick.hidden = true;
  els.result.hidden = true;
  els.work.hidden = false;
  els.stage.hidden = true;

  const samples = Number(els.samples.value);
  const ctrl = new AbortController();
  state.abort = ctrl;
  const ctx = setView(state.style);
  let t0 = 0;

  try {
    const res = await analyzeVideo(file, {
      samples,
      mode: els.mode.value,
      crop: els.crop.checked,
      parallel: Number(els.parallel.value),
      fast: canFastSeek() && els.fast.checked,
      start: startSec,
      end: endSec,
      signal: ctrl.signal,
      onStart: (info) => {
        t0 = performance.now();
        els.stage.hidden = false;
        els.status.textContent = `${fmtTime(info.duration)} of film · ${info.width}×${info.height}` +
          (info.crop ? ' · letterbox removed' : '') + ` · ${info.decoders} decoders`;
      },
      onSample: (i, c, done) => {
        const fill = `rgb(${linearToSrgb8(c[0])},${linearToSrgb8(c[1])},${linearToSrgb8(c[2])})`;
        drawSlice(ctx, state.style, i, samples, fill);
        const frac = done / samples;
        els.barFill.style.width = `${(frac * 100).toFixed(1)}%`;
        if (done % 5 === 0 || done === samples) {
          const elapsed = (performance.now() - t0) / 1000;
          const eta = elapsed / frac - elapsed;
          els.status.textContent = `${Math.round(frac * 100)}% · ${done}/${samples} frames` +
            (done > 10 ? ` · about ${fmtTime(eta)} left` : '');
        }
      },
    });
    res.seconds = (performance.now() - t0) / 1000;
    state.result = res;
    showResult();
  } catch (e) {
    if (e.name === 'AbortError') reset();
    else { reset(); showError(e.message || String(e)); }
  } finally {
    state.abort = null;
  }
}

els.cancel.addEventListener('click', () => state.abort?.abort());

function reset() {
  els.work.hidden = true;
  els.stage.hidden = true;
  els.result.hidden = true;
  els.pick.hidden = false;
  state.result = null;
}

// ---------- result ----------
function rerender() {
  const r = state.result;
  if (!r) return;
  const lin = smooth(r.lin, Number(els.smooth.value));
  state.srgb = toSrgb(lin);
  state.palette = filmPalette(lin, 8);
  draw(setView(state.style), state.srgb, state.style);
  els.swatches.replaceChildren(...state.palette.map((p) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.title = `Copy ${p.hex}`;
    b.innerHTML = `<span class="chip" style="background:${p.hex}"></span>` +
      `<span class="meta"><span>${p.hex}</span><span>${Math.round(p.share * 100)}%</span></span>`;
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(p.hex);
        b.querySelector('.meta span').textContent = 'copied';
        setTimeout(() => { b.querySelector('.meta span').textContent = p.hex; }, 900);
      } catch { /* clipboard blocked */ }
    });
    li.append(b);
    return li;
  }));
}

function showResult() {
  const r = state.result;
  els.work.hidden = true;
  els.stage.hidden = false;
  els.result.hidden = false;
  els.stats.textContent = `${state.fileName} · ${fmtTime(r.duration)} sampled into ${r.samples} slices in ` +
    `${r.seconds.toFixed(1)} s` + (r.crop ? ` · cropped to ${r.crop.sw}×${r.crop.sh}` : '');
  rerender();
}

document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
  state.style = b.dataset.style;
  setStyleButtons();
  savePrefs();
  rerender();
}));
setStyleButtons();
els.smooth.addEventListener('input', rerender);

els.dlPng.addEventListener('click', async () => {
  const blob = await toPngBlob(state.srgb, state.style, Number(els.exportSize.value));
  download(blob, `${baseName()}_${state.style}.png`);
});
els.dlSvg.addEventListener('click', () => {
  const svg = toSvg(state.srgb, state.style, Number(els.exportSize.value));
  download(new Blob([svg], { type: 'image/svg+xml' }), `${baseName()}_${state.style}.svg`);
});
els.dlJson.addEventListener('click', () => {
  const r = state.result;
  const colors = [];
  for (let i = 0; i < state.srgb.length; i += 3) {
    colors.push('#' + [0, 1, 2].map((c) => state.srgb[i + c].toString(16).padStart(2, '0')).join(''));
  }
  const json = {
    source: state.fileName, duration: +r.duration.toFixed(3), start: +r.start.toFixed(3),
    mode: r.mode, crop: r.crop, colors,
    palette: state.palette.map((p) => ({ hex: p.hex, share: +p.share.toFixed(4) })),
  };
  download(new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' }), `${baseName()}_colors.json`);
});
els.again.addEventListener('click', () => { reset(); showError(''); });

// expose for automated tests
window.__cinemaPalette = { state };
