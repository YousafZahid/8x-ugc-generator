/**
 * Four-layer video compositor.
 *
 *   1. background   stock video or photo, scaled to cover and centre-cropped 9:16
 *   2. text cards   transparent full-frame PNGs, time-gated to a window each
 *   3. audio        trimmed to length, faded in and out
 *   4. sticker      transparent looping GIF, the hero element, sits on top
 *
 * Nothing here is AI-generated - ffmpeg composites assets that already exist.
 *
 * Framework-free on purpose: no Next imports, so the whole stage is runnable
 * from scripts/render-smoke.ts without booting a server.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** One time-gated text card. Times are seconds from the start of the video. */
export type TextCard = {
  png: string;
  start: number;
  end: number;
  /** Y offset of the block within the frame. Cards are block-sized, not full-frame. */
  y: number;
};

/**
 * Where the text block and the sticker sit. Picked per vibe so four videos do
 * not read as four fills of one template. Values are fractions of the frame.
 */
export type Layout = {
  name: string;
  /** Top of the text block. */
  textTop: number;
  /** Sticker centre. */
  stickerCx: number;
  stickerCy: number;
  /** Sticker width as a fraction of frame width. */
  stickerScale: number;
};

/**
 * Three presets, deliberately not more. Each keeps the sticker clear of the
 * text block vertically, and inside a safe margin horizontally.
 *
 *   centre-low  text high, sticker large and centred below it
 *   corner-high sticker small in the upper right, text sitting under it
 *   offset-low  text high, sticker left of centre and low
 */
export const LAYOUTS: Layout[] = [
  { name: "centre-low", textTop: 0.15, stickerCx: 0.5, stickerCy: 0.63, stickerScale: 0.56 },
  { name: "corner-high", textTop: 0.34, stickerCx: 0.7, stickerCy: 0.15, stickerScale: 0.34 },
  { name: "offset-low", textTop: 0.13, stickerCx: 0.35, stickerCy: 0.74, stickerScale: 0.46 },
];

/**
 * Vibe sets the starting preset; the domain rotates from there.
 *
 * Vibe alone was not enough. The model frequently assigns the same vibe to
 * several products - three of four fresh URLs came back "clean" - which put
 * three of four videos on an identical layout, which is the "four fills of one
 * template" problem this is meant to solve. Rotating by domain keeps the vibe
 * association while guaranteeing same-vibe products differ.
 */
export function layoutFor(vibe: string, seed = ""): Layout {
  const byVibe: Record<string, number> = {
    chill: 0, clean: 0,
    upbeat: 1, playful: 1,
    hype: 2, cinematic: 2,
  };
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const base = byVibe[vibe] ?? 0;
  return LAYOUTS[(base + (h >>> 0)) % LAYOUTS.length];
}

export type RenderInput = {
  /** Stock clip (.mp4/.webm) or still photo (.jpg/.png). Both are handled. */
  background: string;
  /** Transparent looping GIF. The most important visual element. */
  sticker: string;
  /** Backing track. Longer than the video is fine, it gets trimmed. */
  audio: string;
  /** Usually two: a hook card and a payoff card. */
  textCards: TextCard[];
  /**
   * Seconds into the track to start.
   *
   * Every video used to open at 0:00, which on most tracks is the intro -
   * no beat, no groove. Starting mid-track opens on an established rhythm.
   */
  audioOffset?: number;
  /** Defaults to the first preset. */
  layout?: Layout;
  /** Absolute path to write the .mp4 to. */
  out: string;
};

export type RenderResult = {
  out: string;
  /** Wall-clock ffmpeg time, milliseconds. */
  ms: number;
  /** Peak resident set size of the ffmpeg process, bytes. 0 if unmeasurable. */
  peakRss: number;
  /** Peak memory of the whole container cgroup, bytes. 0 outside Linux/cgroup v2. */
  containerPeak: number;
  width: number;
  height: number;
  duration: number;
  preset: string;
  bytes: number;
  /** The exact argv, so a failed render can be replayed by hand. */
  argv: string[];
};

/** Renders are tuned by env so a slow instance is a config change, not a code change. */
export function renderConfig() {
  const height = Number(process.env.VIDEO_HEIGHT ?? 1920);
  // 9:16, forced even - x264 rejects odd dimensions with yuv420p.
  const width = Math.round((height * 9) / 16 / 2) * 2;
  return {
    width,
    height,
    duration: Number(process.env.VIDEO_DURATION ?? 8),
    preset: process.env.VIDEO_PRESET ?? "veryfast",
    fps: Number(process.env.VIDEO_FPS ?? 30),
    crf: Number(process.env.VIDEO_CRF ?? 23),
    /** Alpha fade on each text card, seconds in and out. */
    textFade: Number(process.env.TEXT_FADE ?? 0.22),
    ffmpeg: process.env.FFMPEG_PATH ?? "ffmpeg",
    threads: Number(process.env.FFMPEG_THREADS ?? 2),
  };
}

const STILL = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export function buildArgs(input: RenderInput, cfg = renderConfig()): string[] {
  const { width: W, height: H, duration: D, fps, preset, crf } = cfg;
  const stillBg = STILL.has(path.extname(input.background).toLowerCase());
  const layout = input.layout ?? LAYOUTS[0];
  const fade = cfg.textFade;

  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error", "-threads", String(cfg.threads)];

  // 0: background. A still gets looped into a clip; a video loops if it is short.
  if (stillBg) args.push("-loop", "1", "-t", String(D), "-i", input.background);
  else args.push("-stream_loop", "-1", "-t", String(D), "-i", input.background);

  // 1: sticker. -ignore_loop 0 makes the GIF repeat for the whole video.
  args.push("-ignore_loop", "0", "-i", input.sticker);

  // 2: audio.
  args.push("-i", input.audio);

  // 3..n: text cards. Each is looped for exactly its own window, so the fade
  // filter has a timeline to work against - a single still frame has none.
  for (const card of input.textCards) {
    args.push("-loop", "1", "-t", String(Math.max(0.1, card.end - card.start)), "-i", card.png);
  }

  const stickerW = Math.round((W * layout.stickerScale) / 2) * 2;
  const chains: string[] = [];

  // Layer 1 - cover-crop the background to exactly WxH, normalise timing.
  //
  // Deliberately NOT converted to rgba here. Forcing the full-frame background
  // through RGBA costs ~2.9x wall clock at 1080x1920 (4.90s vs 1.68s measured)
  // and buys nothing: overlay negotiates its own formats, and the alpha that
  // matters belongs to the overlay inputs, not the base.
  chains.push(
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,` +
      `crop=${W}:${H},fps=${fps},setsar=1,setpts=PTS-STARTPTS[bg]`
  );

  // Layer 2 - text cards. Alpha-faded in and out rather than hard-cut: a
  // straight enable= switch reads as a slideshow, not as UGC.
  let cur = "bg";
  input.textCards.forEach((card, i) => {
    const src = 3 + i;
    const next = `t${i}`;
    const window = Math.max(0.1, card.end - card.start);
    const outAt = Math.max(0, window - fade);

    chains.push(
      `[${src}:v]format=rgba,fps=${fps},` +
        `fade=t=in:st=0:d=${fade}:alpha=1,` +
        `fade=t=out:st=${outAt.toFixed(2)}:d=${fade}:alpha=1,` +
        // Shift the faded clip to where it belongs on the timeline.
        `setpts=PTS-STARTPTS+${card.start}/TB[txt${i}]`
    );
    chains.push(
      `[${cur}][txt${i}]overlay=0:${card.y}:enable='between(t,${card.start},${card.end})':eof_action=pass[${next}]`
    );
    cur = next;
  });

  // Layer 4 - the sticker, last so it sits above everything. This one keeps an
  // explicit rgba conversion: it is small, and its alpha is the whole point.
  chains.push(`[1:v]scale=${stickerW}:-2,format=rgba,setpts=PTS-STARTPTS[gif]`);
  chains.push(
    `[${cur}][gif]overlay=x=${layout.stickerCx}*W-w/2:y=${layout.stickerCy}*H-h/2:` +
      `shortest=0:format=auto[vout]`
  );

  // Layer 3 - audio: start mid-track, trim to length, ease in, duck out.
  const offset = Math.max(0, input.audioOffset ?? 0);
  const fadeOut = Math.max(0, D - 0.6);
  // No loudnorm here. In the chain it cost ~1.3s of encode (3.29s vs 1.94s
  // median), and it would run on the committed library too, which is already
  // normalised. Live downloads are normalised once in lib/music.ts instead -
  // off the render path, and only where it is actually needed.
  chains.push(
    `[2:a]atrim=${offset.toFixed(2)}:${(offset + D).toFixed(2)},asetpts=PTS-STARTPTS,` +
      `afade=t=in:st=0:d=0.3,afade=t=out:st=${fadeOut}:d=0.6,` +
      `aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[aout]`
  );

  args.push(
    "-filter_complex", chains.join(";"),
    "-map", "[vout]",
    "-map", "[aout]",
    "-t", String(D),
    "-r", String(fps),
    "-c:v", "libx264",
    "-preset", preset,
    "-crf", String(crf),
    "-pix_fmt", "yuv420p",
    "-profile:v", "main",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
    "-movflags", "+faststart",
    input.out
  );

  return args;
}

/** Peak RSS of a live pid. Linux exposes a true high-water mark; elsewhere we poll. */
function sampleRss(pid: number): number {
  try {
    if (process.platform === "linux") {
      const status = readFileSync(/* turbopackIgnore: true */ `/proc/${pid}/status`, "utf8");
      const m = status.match(/VmHWM:\s+(\d+)\s+kB/);
      if (m) return Number(m[1]) * 1024;
    }
  } catch {
    // process exited between the check and the read - expected, not an error
  }
  return 0;
}

function containerPeakRss(): number {
  for (const f of ["/sys/fs/cgroup/memory.peak", "/sys/fs/cgroup/memory/memory.max_usage_in_bytes"]) {
    try {
      if (existsSync(f)) {
        const v = Number(readFileSync(/* turbopackIgnore: true */ f, "utf8").trim());
        if (Number.isFinite(v) && v > 0) return v;
      }
    } catch {
      // cgroup file unreadable on this host - not fatal, we just report 0
    }
  }
  return 0;
}

export async function render(input: RenderInput, cfg = renderConfig()): Promise<RenderResult> {
  const argv = buildArgs(input, cfg);
  const started = Date.now();

  const result = await new Promise<{ code: number; stderr: string; peakRss: number }>((resolve) => {
    const proc = spawn(cfg.ffmpeg, argv, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let peakRss = 0;

    proc.stderr.on("data", (d) => {
      // Keep only the tail; a broken filter graph can emit a lot.
      stderr = (stderr + d.toString()).slice(-4000);
    });

    const poll = setInterval(() => {
      if (proc.pid) peakRss = Math.max(peakRss, sampleRss(proc.pid));
    }, 120);

    proc.on("error", (e) => {
      clearInterval(poll);
      resolve({ code: -1, stderr: `${stderr}\nspawn failed: ${e.message}`, peakRss });
    });
    proc.on("close", (code) => {
      clearInterval(poll);
      resolve({ code: code ?? -1, stderr, peakRss });
    });
  });

  if (result.code !== 0) {
    throw new Error(
      `ffmpeg exited ${result.code}\n${result.stderr}\n\nreplay:\n  ffmpeg ${argv.join(" ")}`
    );
  }

  const bytes = (await readFile(input.out)).byteLength;

  return {
    out: input.out,
    ms: Date.now() - started,
    peakRss: result.peakRss,
    containerPeak: containerPeakRss(),
    width: cfg.width,
    height: cfg.height,
    duration: cfg.duration,
    preset: cfg.preset,
    bytes,
    argv,
  };
}

/**
 * Grabs one frame as a JPEG poster. Cheap - a single frame decode - and it is
 * what stops the player showing a grey box before the video buffers.
 * Failure is non-fatal: the video is already rendered and playable.
 */
export async function posterFrame(
  video: string,
  out: string,
  atSeconds = 1,
  cfg = renderConfig()
): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(cfg.ffmpeg, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-ss", String(atSeconds), "-i", video,
      "-frames:v", "1", "-q:v", "4",
      out,
    ], { stdio: "ignore" });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}
