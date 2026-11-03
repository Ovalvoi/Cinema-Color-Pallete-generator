// Draw / export a list of sRGB colours (Uint8Array N*3) as a barcode or a ring.

import { hex } from './color.js';

const INNER = 0.35; // ring inner radius as a fraction of the outer radius

export function colorAt(srgb, i) {
  return `rgb(${srgb[i * 3]},${srgb[i * 3 + 1]},${srgb[i * 3 + 2]})`;
}

/** Draw one slice (used for the live preview while sampling). */
export function drawSlice(ctx, style, i, n, fill) {
  const { width: W, height: H } = ctx.canvas;
  ctx.fillStyle = fill;
  if (style === 'barcode') {
    const x0 = Math.round((i / n) * W), x1 = Math.round(((i + 1) / n) * W);
    ctx.fillRect(x0, 0, Math.max(1, x1 - x0), H);
    return;
  }
  const c = W / 2, r1 = W / 2, r0 = r1 * INNER;
  // a hair of overlap hides anti-aliasing seams between wedges
  const a0 = (i / n) * 2 * Math.PI - Math.PI / 2 - 0.002;
  const a1 = ((i + 1) / n) * 2 * Math.PI - Math.PI / 2 + 0.002;
  ctx.beginPath();
  ctx.arc(c, c, r1, a0, a1);
  ctx.arc(c, c, r0, a1, a0, true);
  ctx.closePath();
  ctx.fill();
}

export function draw(ctx, srgb, style) {
  const n = srgb.length / 3;
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  for (let i = 0; i < n; i++) drawSlice(ctx, style, i, n, colorAt(srgb, i));
}

export function sizeFor(style, base) {
  return style === 'barcode' ? { w: base, h: Math.round(base / 4) } : { w: base, h: base };
}

export function toPngBlob(srgb, style, base) {
  const { w, h } = sizeFor(style, base);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d'), srgb, style);
  return new Promise((res) => canvas.toBlob(res, 'image/png'));
}

export function toSvg(srgb, style, base) {
  const n = srgb.length / 3;
  const { w, h } = sizeFor(style, base);
  const hexes = Array.from({ length: n }, (_, i) => hex(srgb[i * 3], srgb[i * 3 + 1], srgb[i * 3 + 2]));
  const out = [];
  if (style === 'barcode') {
    out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${n} ${h}" preserveAspectRatio="none" shape-rendering="crispEdges">`);
    for (let i = 0; i < n;) {
      let j = i + 1;
      while (j < n && hexes[j] === hexes[i]) j++;
      out.push(`<rect x="${i}" width="${j - i}" height="${h}" fill="${hexes[i]}"/>`);
      i = j;
    }
  } else {
    const c = w / 2, r1 = w / 2, r0 = r1 * INNER, f = (v) => v.toFixed(2);
    out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${w}" viewBox="0 0 ${w} ${w}">`);
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * 2 * Math.PI - Math.PI / 2;
      const a1 = ((i + 1) / n) * 2 * Math.PI - Math.PI / 2 + 0.002;
      const p = (r, a) => `${f(c + r * Math.cos(a))} ${f(c + r * Math.sin(a))}`;
      out.push(`<path fill="${hexes[i]}" d="M${p(r1, a0)}A${f(r1)} ${f(r1)} 0 0 1 ${p(r1, a1)}L${p(r0, a1)}A${f(r0)} ${f(r0)} 0 0 0 ${p(r0, a0)}Z"/>`);
    }
  }
  out.push('</svg>');
  return out.join('\n');
}
