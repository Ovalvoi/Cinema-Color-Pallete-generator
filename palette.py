#!/usr/bin/env python3
"""Cinema Color Palette generator.

Turns a movie into a "movie barcode": one colour stripe per moment of the film.

ffmpeg does all the heavy lifting in a single pass (decode -> crop letterbox ->
sample N frames per second -> shrink to a tiny thumbnail) and streams raw RGB
pixels straight into Python, so no intermediate "compressed" copy is needed.

    python palette.py movie.mkv
    python palette.py movie.mkv -o barcode.png -o barcode.svg -o colors.json
    python palette.py movie.mkv --mode dominant --style circle --end 2:05:00

Requires ffmpeg on PATH (ffprobe used if present) and numpy (tqdm optional for a nicer progress bar).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import threading
import zlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

try:
    from tqdm import tqdm
except ImportError:  # tqdm is optional
    tqdm = None

# Every sampled frame is shrunk to this size by ffmpeg (area averaging).
# 64x36 = 2304 pixels: plenty for an average or a 4-cluster k-means.
SAMPLE_W, SAMPLE_H = 64, 36
FRAME_BYTES = SAMPLE_W * SAMPLE_H * 3
BATCH = 128  # frames processed per numpy call


# --------------------------------------------------------------------------
# Colour math (all averaging happens in linear light, not gamma-encoded sRGB,
# otherwise mixed colours come out muddy and too dark)
# --------------------------------------------------------------------------

def _build_lut() -> np.ndarray:
    c = np.arange(256, dtype=np.float64) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4).astype(np.float32)


SRGB_TO_LINEAR = _build_lut()


def linear_to_srgb(lin: np.ndarray) -> np.ndarray:
    lin = np.clip(lin, 0.0, 1.0)
    s = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(lin, 1 / 2.4) - 0.055)
    return np.clip(np.round(s * 255), 0, 255).astype(np.uint8)


def kmeans_batch(px: np.ndarray, k: int, iters: int = 8):
    """Vectorised k-means over a batch of pixel sets.

    px: (n, P, 3) float32 linear RGB. Returns centers (n, k, 3) and counts (n, k).
    Deterministic init: pixels at evenly spaced luminance quantiles.
    """
    n, p, _ = px.shape
    k = max(1, min(k, p))
    lum = px @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    order = np.argsort(lum, axis=1)
    seed_idx = order[:, ((np.arange(k) + 0.5) / k * p).astype(int)]
    centers = np.take_along_axis(px, seed_idx[..., None], axis=1)
    arange_k = np.arange(k)
    counts = np.zeros((n, k), dtype=np.int64)
    for _ in range(iters):
        dist = ((px[:, :, None, :] - centers[:, None, :, :]) ** 2).sum(-1)  # (n, P, k)
        onehot = (dist.argmin(-1)[..., None] == arange_k).astype(np.float32)  # (n, P, k)
        counts = onehot.sum(1).astype(np.int64)
        sums = np.einsum("npk,npc->nkc", onehot, px)
        centers = np.where(counts[..., None] > 0, sums / np.maximum(counts, 1)[..., None], centers)
    return centers, counts


def frame_colors(frames: np.ndarray, mode: str) -> np.ndarray:
    """(n, H, W, 3) uint8 sRGB frames -> (n, 3) float32 linear colours."""
    lin = SRGB_TO_LINEAR[frames]
    if mode == "average":
        return lin.mean(axis=(1, 2))
    # "dominant": biggest of 4 clusters -> the colour you actually *see*,
    # instead of the grey-brown you get by averaging a red coat on a blue sky.
    px = lin.reshape(len(frames), -1, 3)
    centers, counts = kmeans_batch(px, k=4)
    return centers[np.arange(len(frames)), counts.argmax(1)]


def resample(colors: np.ndarray, columns: int) -> np.ndarray:
    """Fit N linear colours into exactly `columns` slices (bin-average or stretch)."""
    n = len(colors)
    if n == 0:
        raise ValueError("no frames were decoded")
    if n >= columns:
        edges = np.floor(np.linspace(0, n, columns + 1)).astype(int)
        sums = np.add.reduceat(colors, edges[:-1], axis=0)
        return sums / np.diff(edges)[:, None]
    idx = np.floor((np.arange(columns) + 0.5) * n / columns).astype(int)
    return colors[idx]


def smooth(colors: np.ndarray, window: int) -> np.ndarray:
    if window <= 1:
        return colors
    pad = window // 2
    padded = np.pad(colors, ((pad, window - 1 - pad), (0, 0)), mode="edge")
    kernel = np.ones(window, dtype=np.float32) / window
    return np.stack([np.convolve(padded[:, c], kernel, mode="valid") for c in range(3)], axis=1)


def film_palette(colors_lin: np.ndarray, k: int):
    """Top-k colours of the whole film, most common first: [(srgb, share), ...]."""
    if k <= 0:
        return []
    centers, counts = kmeans_batch(colors_lin[None].astype(np.float32), k=k, iters=20)
    centers, counts = centers[0], counts[0]
    total = counts.sum()
    merged = []  # [srgb, count]; fold together clusters that look the same
    for i in np.argsort(-counts):
        if counts[i] == 0:
            continue
        rgb = linear_to_srgb(centers[i]).astype(int)
        for m in merged:
            if np.abs(m[0] - rgb).max() <= 10:
                m[1] += counts[i]
                break
        else:
            merged.append([rgb, counts[i]])
    merged.sort(key=lambda m: -m[1])
    return [(m[0].astype(np.uint8), m[1] / total) for m in merged]


def to_hex(rgb) -> str:
    return "#%02x%02x%02x" % tuple(int(v) for v in rgb)


# --------------------------------------------------------------------------
# ffmpeg plumbing
# --------------------------------------------------------------------------

def require_ffmpeg():
    if shutil.which("ffmpeg") is None:
        sys.exit("error: ffmpeg not found on PATH. Install it from https://ffmpeg.org/download.html "
                 "(Windows: `winget install ffmpeg`, macOS: `brew install ffmpeg`, Linux: `apt install ffmpeg`).")


def probe(path: str) -> dict:
    """Video width/height/duration via ffprobe, or by parsing `ffmpeg -i` if ffprobe is absent."""
    if shutil.which("ffprobe"):
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height:format=duration", "-of", "json", path],
            capture_output=True, text=True, errors="replace")
        if out.returncode != 0:
            sys.exit(f"error: ffprobe could not read {path!r}:\n{out.stderr.strip()}")
        info = json.loads(out.stdout or "{}")
        streams = info.get("streams") or []
        if not streams:
            sys.exit(f"error: {path!r} has no video stream")
        width, height = int(streams[0]["width"]), int(streams[0]["height"])
        duration = float(info.get("format", {}).get("duration") or 0)
    else:
        err = subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", "-i", path],
                             capture_output=True, text=True, errors="replace").stderr
        size = re.search(r"Stream #\S+.*?Video:.*?(\d{2,5})x(\d{2,5})", err)
        dur = re.search(r"Duration: (\d+):(\d+):([\d.]+)", err)
        if not size:
            sys.exit(f"error: could not find a video stream in {path!r}")
        width, height = int(size.group(1)), int(size.group(2))
        duration = (int(dur.group(1)) * 3600 + int(dur.group(2)) * 60 + float(dur.group(3))) if dur else 0
    if duration <= 0:
        sys.exit(f"error: could not determine the duration of {path!r}")
    return {"width": width, "height": height, "duration": duration}


_CROP_RE = re.compile(r"crop=(\d+):(\d+):(\d+):(\d+)")


def detect_crop(path: str, info: dict, start: float, end: float, samples: int = 12):
    """Find letterbox / pillarbox bars by running cropdetect at a few points.

    Returns (w, h, x, y) or None. Uses the *union* of all detected boxes, so a
    dark scene can never make us crop away real picture.
    """
    def one(t):
        r = subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostats", "-nostdin", "-ss", f"{t:.3f}", "-i", path,
             "-an", "-sn", "-dn", "-vf", "cropdetect=limit=24:round=2:reset=0",
             "-frames:v", "4", "-f", "null", "-"],
            capture_output=True, text=True, errors="replace")
        found = _CROP_RE.findall(r.stderr)
        return tuple(map(int, found[-1])) if found else None

    span = end - start
    times = [start + span * (i + 0.5) / samples for i in range(samples)]
    with ThreadPoolExecutor(max_workers=min(samples, os.cpu_count() or 4)) as pool:
        boxes = [b for b in pool.map(one, times) if b and b[0] > 0 and b[1] > 0]
    if not boxes:
        return None
    x0 = min(b[2] for b in boxes)
    y0 = min(b[3] for b in boxes)
    x1 = max(b[2] + b[0] for b in boxes)
    y1 = max(b[3] + b[1] for b in boxes)
    w, h = x1 - x0, y1 - y0
    if w >= info["width"] - 2 and h >= info["height"] - 2:
        return None  # no bars
    if w < info["width"] * 0.3 or h < info["height"] * 0.3:
        return None  # implausible (e.g. every sample was a black frame)
    return (w, h, x0, y0)


def read_colors(stream, mode: str, on_frames=None) -> np.ndarray:
    """Consume a raw rgb24 stream of SAMPLE_W x SAMPLE_H frames -> (n, 3) linear colours."""
    chunks = []
    while True:
        buf = stream.read(FRAME_BYTES * BATCH)
        if not buf:
            break
        n = len(buf) // FRAME_BYTES
        if n == 0:
            break  # truncated trailing frame
        frames = np.frombuffer(buf[: n * FRAME_BYTES], np.uint8).reshape(n, SAMPLE_H, SAMPLE_W, 3)
        chunks.append(frame_colors(frames, mode))
        if on_frames:
            on_frames(n)
    return np.concatenate(chunks) if chunks else np.zeros((0, 3), np.float32)


def extract_segment(path, seg_start, seg_end, fps, crop, mode, accurate, hwaccel, on_frames):
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin"]
    if hwaccel:
        cmd += ["-hwaccel", "auto"]
    if not accurate:
        # Only decode keyframes: typically 20-100x less decoding work. Encoders
        # put a keyframe at most scene cuts, so the palette barely changes.
        cmd += ["-skip_frame", "nokey"]
    cmd += ["-ss", f"{seg_start:.3f}", "-to", f"{seg_end:.3f}", "-i", path, "-an", "-sn", "-dn"]
    vf = []
    if crop:
        vf.append("crop=%d:%d:%d:%d" % crop)
    vf += [f"fps={fps}", f"scale={SAMPLE_W}:{SAMPLE_H}:flags=area", "format=rgb24"]
    cmd += ["-vf", ",".join(vf), "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]

    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    err_lines = []
    drain = threading.Thread(target=lambda: err_lines.extend(proc.stderr), daemon=True)
    drain.start()
    try:
        colors = read_colors(proc.stdout, mode, on_frames)
    finally:
        proc.stdout.close()
        proc.wait()
        drain.join()
    if proc.returncode != 0 and len(colors) == 0:
        msg = b"".join(err_lines[-10:]).decode(errors="replace").strip()
        raise RuntimeError(f"ffmpeg failed on segment {seg_start:.0f}-{seg_end:.0f}s:\n{msg}")
    return colors


def extract_colors(path, start, end, fps, crop, mode, accurate, hwaccel, jobs) -> np.ndarray:
    """Run `jobs` ffmpeg processes in parallel, each on a slice of the film."""
    span = end - start
    jobs = max(1, min(jobs, int(span // 30) or 1))  # don't split tiny clips
    bounds = [start + span * i / jobs for i in range(jobs + 1)]
    total = max(1, math.ceil(span * fps))

    lock = threading.Lock()
    if tqdm:
        bar = tqdm(total=total, unit="frame", desc="Sampling", dynamic_ncols=True)
        def on_frames(n):
            with lock:
                bar.update(n)
    else:
        bar, done = None, [0]
        def on_frames(n):
            with lock:
                done[0] += n
                print(f"\rSampling: {min(100, 100 * done[0] // total):3d}%", end="", file=sys.stderr)

    try:
        with ThreadPoolExecutor(max_workers=jobs) as pool:
            parts = list(pool.map(
                lambda i: extract_segment(path, bounds[i], bounds[i + 1], fps, crop, mode,
                                          accurate, hwaccel, on_frames),
                range(jobs)))
    finally:
        if bar:
            bar.close()
        else:
            print(file=sys.stderr)
    return np.concatenate(parts)


# --------------------------------------------------------------------------
# Output writers (no matplotlib / Pillow needed)
# --------------------------------------------------------------------------

def write_png(path: Path, pixels: np.ndarray):
    """Minimal PNG encoder. pixels: (h, w, 3) RGB or (h, w, 4) RGBA uint8."""
    h, w, c = pixels.shape
    raw = np.concatenate([np.zeros((h, 1), np.uint8), pixels.reshape(h, w * c)], axis=1).tobytes()

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    color_type = 6 if c == 4 else 2
    path.write_bytes(b"\x89PNG\r\n\x1a\n"
                     + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, color_type, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw, 9))
                     + chunk(b"IEND", b""))


def circle_geometry(size: int, n: int, inner: float = 0.35):
    """Per-pixel slice index for a ring, clockwise from 12 o'clock (-1 = outside)."""
    c = (size - 1) / 2
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    dx, dy = x - c, y - c
    r = np.hypot(dx, dy) / (size / 2)
    angle = (np.arctan2(dx, -dy) + 2 * np.pi) % (2 * np.pi)
    idx = np.minimum((angle / (2 * np.pi) * n).astype(int), n - 1)
    idx[(r > 1) | (r < inner)] = -1
    return idx


def render_png(srgb: np.ndarray, style: str, width: int, height: int) -> np.ndarray:
    if style == "barcode":
        return np.broadcast_to(srgb[None, :, :], (height, len(srgb), 3)).copy()
    idx = circle_geometry(width, len(srgb))
    out = np.zeros((width, width, 4), np.uint8)
    mask = idx >= 0
    out[mask, :3] = srgb[idx[mask]]
    out[mask, 3] = 255
    return out


def render_svg(srgb: np.ndarray, style: str, width: int, height: int) -> str:
    n = len(srgb)
    hexes = [to_hex(c) for c in srgb]
    parts = []
    if style == "barcode":
        parts.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
                     f'viewBox="0 0 {n} {height}" preserveAspectRatio="none" shape-rendering="crispEdges">')
        i = 0
        while i < n:  # merge runs of identical colour
            j = i + 1
            while j < n and hexes[j] == hexes[i]:
                j += 1
            parts.append(f'<rect x="{i}" width="{j - i}" height="{height}" fill="{hexes[i]}"/>')
            i = j
    else:
        size, c, r1 = width, width / 2, width / 2
        r0 = r1 * 0.35
        parts.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}">')
        for i, col in enumerate(hexes):
            # tiny overlap hides anti-aliasing seams between wedges
            a0 = 2 * math.pi * i / n - math.pi / 2
            a1 = 2 * math.pi * (i + 1) / n - math.pi / 2 + 0.002
            pts = [(c + r * math.cos(a), c + r * math.sin(a)) for r, a in ((r1, a0), (r1, a1), (r0, a1), (r0, a0))]
            (x0, y0), (x1, y1), (x2, y2), (x3, y3) = pts
            parts.append(f'<path fill="{col}" d="M{x0:.2f} {y0:.2f}A{r1:.2f} {r1:.2f} 0 0 1 {x1:.2f} {y1:.2f}'
                         f'L{x2:.2f} {y2:.2f}A{r0:.2f} {r0:.2f} 0 0 0 {x3:.2f} {y3:.2f}Z"/>')
    parts.append("</svg>")
    return "\n".join(parts)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def parse_time(value: str) -> float:
    """'5400', '90:00' or '1:30:00' -> seconds."""
    try:
        secs = 0.0
        for part in value.split(":"):
            secs = secs * 60 + float(part)
        return secs
    except ValueError:
        raise argparse.ArgumentTypeError(f"invalid time {value!r} (use seconds, MM:SS or H:MM:SS)")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Generate a colour palette / movie barcode from a video file.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    p.add_argument("input", help="video file (anything ffmpeg can read: mkv, mp4, mov, avi, ...)")
    p.add_argument("-o", "--output", action="append",
                   help="output file(s): .svg, .png or .json; repeat for several "
                        "(default: <input>_palette.png)")
    p.add_argument("--mode", choices=["average", "dominant"], default="average",
                   help="average colour of each moment, or its most dominant colour (more vivid)")
    p.add_argument("--style", choices=["barcode", "circle"], default="barcode")
    p.add_argument("--width", type=int, default=1200,
                   help="number of colour slices = image width (circle: image is width x width)")
    p.add_argument("--height", type=int, default=300, help="image height (barcode style)")
    p.add_argument("--fps", type=float, default=None,
                   help="frames sampled per second (default: auto, ~2 samples per slice)")
    p.add_argument("--accurate", action="store_true",
                   help="decode every frame instead of keyframes only (much slower, rarely visible)")
    p.add_argument("--no-crop", action="store_true", help="don't auto-remove letterbox bars")
    p.add_argument("--hwaccel", action="store_true", help="use GPU video decoding if available")
    p.add_argument("-j", "--jobs", type=int, default=min(4, os.cpu_count() or 1),
                   help="parallel ffmpeg processes")
    p.add_argument("--start", type=parse_time, default=0.0, help="skip intro, e.g. 1:30")
    p.add_argument("--end", type=parse_time, default=None, help="stop before end credits, e.g. 2:05:00")
    p.add_argument("--smooth", type=int, default=0, help="moving-average window in slices (0 = off)")
    p.add_argument("--palette", type=int, default=8, help="also report the film's top N colours")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    if not Path(args.input).is_file():
        sys.exit(f"error: file not found: {args.input}")
    require_ffmpeg()

    outputs = [Path(o) for o in (args.output or [Path(args.input).stem + "_palette.png"])]
    for o in outputs:
        if o.suffix.lower() not in (".svg", ".png", ".json"):
            sys.exit(f"error: unsupported output type {o.suffix!r} (use .svg, .png or .json)")

    info = probe(args.input)
    start = max(0.0, args.start)
    end = min(info["duration"], args.end) if args.end else info["duration"]
    if end <= start:
        sys.exit("error: --end must be after --start")
    fps = args.fps or min(10.0, max(0.25, 2 * args.width / (end - start)))

    print(f"{Path(args.input).name}: {info['width']}x{info['height']}, "
          f"{(end - start) / 60:.1f} min, sampling {fps:.2f} fps", file=sys.stderr)

    crop = None
    if not args.no_crop:
        crop = detect_crop(args.input, info, start, end)
        print(f"Letterbox crop: {'%dx%d+%d+%d' % crop if crop else 'none'}", file=sys.stderr)

    colors = extract_colors(args.input, start, end, fps, crop, args.mode,
                            args.accurate, args.hwaccel, args.jobs)
    slices = smooth(resample(colors, args.width), args.smooth)
    srgb = linear_to_srgb(slices)
    palette = film_palette(slices, args.palette)

    for o in outputs:
        ext = o.suffix.lower()
        if ext == ".png":
            write_png(o, render_png(srgb, args.style, args.width, args.height))
        elif ext == ".svg":
            o.write_text(render_svg(srgb, args.style, args.width, args.height), encoding="utf-8")
        else:
            o.write_text(json.dumps({
                "source": Path(args.input).name,
                "duration": round(end - start, 3),
                "start": round(start, 3),
                "fps": round(fps, 4),
                "mode": args.mode,
                "crop": crop,
                "frames_sampled": int(len(colors)),
                "colors": [to_hex(c) for c in srgb],
                "palette": [{"hex": to_hex(c), "share": round(float(s), 4)} for c, s in palette],
            }, indent=2), encoding="utf-8")
        print(f"Wrote {o}", file=sys.stderr)

    if palette:
        print("Film palette: " + "  ".join(f"{to_hex(c)} ({s:.0%})" for c, s in palette))


if __name__ == "__main__":
    main()
