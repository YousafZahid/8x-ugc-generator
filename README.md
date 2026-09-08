# UGC Video Generator

Chat with it about a product, get a short vertical ad back.

Send something like *"I'm building CalAI, a calorie-tracking app: calai.app"* and
it reads the site, works out what the product is, then assembles an 8-second
1080×1920 video from four layers: stock footage, timed text, a transparent
animated sticker, and a music bed.

**Nothing in the video is AI-generated.** Every frame is real, pre-existing
stock media composited with ffmpeg. AI is used only to read the page and decide
what to go looking for — it is the editor, not the camera.

---

## The four layers

| # | Layer | Source |
|---|---|---|
| 1 | Background video | Pexels (Pixabay as a second library) |
| 2 | Text overlays | SVG → PNG, two time-gated cards |
| 3 | Audio | CC0/CC-BY music library, matched to the brief's vibe |
| 4 | Animated sticker | Giphy **stickers** — the hero element, sits on top |

Layer 4 uses Giphy's `/stickers` endpoint rather than `/gifs` because stickers
carry real alpha. A normal GIF composites as an opaque rectangle sitting on the
footage.

## How it works

```
"I'm building CalAI…"
        │
        ├─ lib/intent.ts    chat or render?  (rules first, LLM for the middle)
        │
        ├─ lib/scrape.ts    fetch + cheerio → r.jina.ai → domain name
        ├─ lib/brief.ts     LLM writes the copy and picks search terms
        ├─ lib/assets.ts    Pexels + Giphy + local audio
        ├─ lib/text.ts      SVG text cards → transparent PNG (sharp)
        └─ lib/render.ts    one ffmpeg filter_complex → mp4
                                    │
                            /api/video/<id>
```

Progress streams to the browser over SSE, because a silent ten-second spinner
reads as broken.

## Running it

```bash
npm install
cp .env.example .env.local     # fill in the keys, all free, no card
npm run check-keys             # one live call per service, masked output
npm run dev
```

Requires `ffmpeg` and `ffprobe` on PATH.

Every key is optional. With none set the app still produces a video — the brief
falls back to heuristics and the assets fall back to committed fixtures. Keys
make the output good, not possible.

| Script | What it does |
|---|---|
| `npm run check-keys` | One minimal live request per API, OK/FAIL + HTTP status |
| `npm run generate -- "…"` | Full pipeline from the command line |
| `npm run scrape -- "…"` | Just the scrape, to vet a URL |
| `npm run brief -- "…"` | Scrape + brief, `--fallback` forces the no-LLM path |
| `npm run smoke` | Four-layer render against fixtures, no network or keys |
| `npm run fixtures` | Regenerates `fixtures/` |
| `npm run music` | Rebuilds the audio library from Openverse + archive.org |

## Decisions worth explaining

**Audio is a committed CC0/CC-BY library, not a runtime API call.** "Trending
audio" in the TikTok sense is not legally available through any API. Instead
`npm run music` builds the library once from Openverse and archive.org, keeping
only CC0 and CC-BY (never `nc`, `nd` or `sa` — see [CREDITS.md](CREDITS.md)),
rejecting anything without a beat in the first second, and normalising every
track to **-14 LUFS / -1 dBTP**. Where a vibe has several tracks the choice is
seeded on the product's domain, so the same product is reproducible while
different products differ.

**Text is SVG, not ffmpeg `drawtext`.** Escaping arbitrary product copy into a
`filter_complex` is a footgun, drawtext cannot wrap, and it cannot do the
stroke-plus-shadow treatment that keeps text readable over unpredictable
footage.

**Every stage degrades instead of failing.** Dead scrape, rate-limited LLM,
empty asset search — each has a fallback beneath it, so the worst case is a
less specific video rather than an error in the chat.

**Renders are ephemeral.** They are written to a capped directory inside the
container (12 files / 120 MB, oldest pruned first) and are lost on restart.
A video needs to outlive the chat session that produced it, not the week, so
there is no object store here on purpose.

**The smoke test checks layers, not just codecs.** An early fixture sticker was
100% transparent — ffmpeg's `drawbox` never raises destination alpha — and it
passed every codec, dimension and duration check while rendering nothing at
all. `npm run smoke` now also asserts that the sticker and both text cards move
luma off the background floor in the rendered frame.

## Deploying

Runs as a Docker container; `Dockerfile` installs ffmpeg, fontconfig and DejaVu
(the text cards resolve their font through fontconfig — without a match, sharp
rasterises the copy as nothing).

`railway.json` and `render.yaml` are both present. Note that ffmpeg peaks near
**1.6 GB** on a 1080×1920 render, so a 512 MB free instance will OOM. Output
geometry is env-driven (`VIDEO_HEIGHT`, default 1920) if you need to trade
quality for headroom.

## Attribution

Stock assets carry attribution — see [CREDITS.md](CREDITS.md). The app also
surfaces per-video credits in the chat under "Credits & how it was made".
