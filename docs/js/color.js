// Colour math shared by the analyzer and the renderers.
// Everything is averaged in *linear light*: averaging gamma-encoded sRGB values
// makes mixed colours come out muddy and too dark.

export const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb8(l) {
  l = Math.min(1, Math.max(0, l));
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

export const hex = (r, g, b) =>
  '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

/**
 * Vectorised-ish k-means on linear RGB points.
 * points: Float32Array of length P*3. Deterministic init at luminance quantiles.
 */
export function kmeans(points, k, iters = 8) {
  const p = points.length / 3;
  k = Math.max(1, Math.min(k, p));
  const lum = new Float32Array(p);
  for (let i = 0; i < p; i++) {
    lum[i] = 0.2126 * points[i * 3] + 0.7152 * points[i * 3 + 1] + 0.0722 * points[i * 3 + 2];
  }
  const order = Array.from({ length: p }, (_, i) => i).sort((a, b) => lum[a] - lum[b]);
  const centers = new Float32Array(k * 3);
  for (let j = 0; j < k; j++) {
    const src = order[Math.floor(((j + 0.5) / k) * p)] * 3;
    centers.set(points.subarray(src, src + 3), j * 3);
  }
  const counts = new Uint32Array(k);
  const sums = new Float64Array(k * 3);
  for (let it = 0; it < iters; it++) {
    counts.fill(0);
    sums.fill(0);
    for (let i = 0; i < p; i++) {
      const r = points[i * 3], g = points[i * 3 + 1], b = points[i * 3 + 2];
      let best = 0, bestD = Infinity;
      for (let j = 0; j < k; j++) {
        const dr = r - centers[j * 3], dg = g - centers[j * 3 + 1], db = b - centers[j * 3 + 2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) { bestD = d; best = j; }
      }
      counts[best]++;
      sums[best * 3] += r; sums[best * 3 + 1] += g; sums[best * 3 + 2] += b;
    }
    for (let j = 0; j < k; j++) {
      if (counts[j]) for (let c = 0; c < 3; c++) centers[j * 3 + c] = sums[j * 3 + c] / counts[j];
    }
  }
  return { centers, counts };
}

/** RGBA pixel data -> linear [r, g, b] for one frame. */
export function frameColor(data, mode) {
  const p = data.length / 4;
  if (mode === 'dominant') {
    // Biggest of 4 clusters: the colour you actually *see* in the shot.
    const pts = new Float32Array(p * 3);
    for (let i = 0; i < p; i++) {
      pts[i * 3] = SRGB_TO_LINEAR[data[i * 4]];
      pts[i * 3 + 1] = SRGB_TO_LINEAR[data[i * 4 + 1]];
      pts[i * 3 + 2] = SRGB_TO_LINEAR[data[i * 4 + 2]];
    }
    const { centers, counts } = kmeans(pts, 4);
    let best = 0;
    for (let j = 1; j < counts.length; j++) if (counts[j] > counts[best]) best = j;
    return [centers[best * 3], centers[best * 3 + 1], centers[best * 3 + 2]];
  }
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < data.length; i += 4) {
    r += SRGB_TO_LINEAR[data[i]];
    g += SRGB_TO_LINEAR[data[i + 1]];
    b += SRGB_TO_LINEAR[data[i + 2]];
  }
  return [r / p, g / p, b / p];
}

/** Moving average over `window` slices (linear Float32Array N*3). */
export function smooth(lin, window) {
  const n = lin.length / 3;
  if (window <= 1 || n < 2) return lin;
  const out = new Float32Array(lin.length);
  const half = Math.floor(window / 2);
  for (let i = 0; i < n; i++) {
    let r = 0, g = 0, b = 0;
    for (let d = -half; d < window - half; d++) {
      const j = Math.min(n - 1, Math.max(0, i + d)) * 3;
      r += lin[j]; g += lin[j + 1]; b += lin[j + 2];
    }
    out[i * 3] = r / window; out[i * 3 + 1] = g / window; out[i * 3 + 2] = b / window;
  }
  return out;
}

export function toSrgb(lin) {
  const out = new Uint8Array(lin.length);
  for (let i = 0; i < lin.length; i++) out[i] = linearToSrgb8(lin[i]);
  return out;
}

/** The film's top-k colours, most common first: [{rgb:[r,g,b], hex, share}] */
export function filmPalette(lin, k = 8) {
  const { centers, counts } = kmeans(lin, k, 20);
  const total = counts.reduce((a, b) => a + b, 0);
  const merged = [];
  [...counts.keys()].sort((a, b) => counts[b] - counts[a]).forEach((j) => {
    if (!counts[j]) return;
    const rgb = [0, 1, 2].map((c) => linearToSrgb8(centers[j * 3 + c]));
    const same = merged.find((m) => m.rgb.every((v, c) => Math.abs(v - rgb[c]) <= 10));
    if (same) same.count += counts[j];
    else merged.push({ rgb, count: counts[j] });
  });
  return merged
    .sort((a, b) => b.count - a.count)
    .map((m) => ({ rgb: m.rgb, hex: hex(...m.rgb), share: m.count / total }));
}
