# Cinema Color Palette Generator

Turn a movie into a **colour barcode**: one stripe for each moment of the film, plus the film's overall palette.

**Try it in your browser:** https://ovalvoi.github.io/Cinema-Color-Pallete-generator/

There are two ways to use it:

| | Web app (`docs/`) | Command line (`palette.py`) |
|---|---|---|
| Install | nothing | Python + ffmpeg |
| Formats | whatever your browser can play (MP4/H.264, WebM, MOV; MKV in Chrome, Edge and Firefox) | anything ffmpeg can read |
| Speed | ~30–60 s for 800 slices, whatever the film's length | ~10–60 s for a 2-hour film (keyframe mode) |
| Output | PNG, SVG, JSON | PNG, SVG, JSON |

## Web app

Drop a video file onto the page. **The file is never uploaded.** It's opened locally as a `blob:` URL and processed in your browser. Several hidden `<video>` elements seek through different parts of the film in parallel, and the browser's hardware decoder does the work. Each sampled frame is drawn onto a 64×36 canvas and reduced to one colour. This means:

- no upload wait, no server costs, and it works with multi-GB files
- nobody else can see your movie, because it stays on your device
- it can be hosted for free on GitHub Pages (static files only)

Features: letterbox-bar removal, average or dominant colour, trimming the intro and credits, barcode or ring layout, smoothing, the film's top-8 palette (click a colour to copy it), and PNG/SVG/JSON export.

### Deploying on GitHub Pages

1. Push this repo to GitHub.
2. Go to **Settings → Pages → Build and deployment**, choose *Deploy from a branch*, set the branch to `main` and the folder to `/docs`, and save.
3. After about a minute the site is live at `https://<user>.github.io/<repo>/`.

To run it locally, serve the `docs/` folder with any static server, for example `python -m http.server -d docs 8000`. ES modules don't load from `file://`.

## Command line

```bash
pip install -r requirements.txt     # numpy (+ optional tqdm)
# plus ffmpeg on PATH: winget install ffmpeg | brew install ffmpeg | apt install ffmpeg

python palette.py movie.mkv                          # -> movie_palette.png
python palette.py movie.mkv -o bar.svg -o bar.png -o colors.json
python palette.py movie.mkv --mode dominant --style circle --width 2000
python palette.py movie.mkv --start 1:30 --end 2:05:00 --smooth 5
```

| Option | Default | Meaning |
|---|---|---|
| `-o FILE` | `<input>_palette.png` | `.png`, `.svg` or `.json`; repeat for several |
| `--mode` | `average` | `average` (true mean, in linear light) or `dominant` (largest k-means cluster, more vivid) |
| `--style` | `barcode` | `barcode` or `circle` (ring) |
| `--width / --height` | 1200 / 300 | number of slices = image width |
| `--fps` | auto | frames sampled per second (auto ≈ 2 samples per slice) |
| `--accurate` | off | decode every frame instead of keyframes only (much slower, rarely visible) |
| `--no-crop` | off | keep letterbox bars |
| `--hwaccel` | off | GPU decoding |
| `-j N` | 4 | parallel ffmpeg processes, each working on one part of the film |
| `--start / --end` | whole film | e.g. `--end 2:05:00` to skip the credits |
| `--smooth N` | 0 | moving average over N slices |
| `--palette N` | 8 | the film's top N colours (printed, and included in the JSON) |

### Why it's fast

- **One pass, no temporary file.** ffmpeg decodes, crops, samples and shrinks frames to 64×36, then streams raw pixels into numpy. The old approach re-encoded the whole movie to H.265 first, which was slower than everything else combined.
- **Keyframes only by default** (`-skip_frame nokey`). This cuts decoding work by 20–100×, and encoders put keyframes at most scene cuts anyway.
- **Parallel segments.** The film is split across several ffmpeg processes.
- **Vectorised colour maths.** Frames are processed 128 at a time in numpy.

### Why it looks better

- Colours are averaged in **linear light**, not gamma-encoded sRGB, so mixed colours don't come out muddy.
- **Letterbox bars are detected and cropped automatically**, so they don't darken every stripe.
- **Dominant mode** shows the colour you actually see in a shot, not the grey-brown average of a red coat against a blue sky.
