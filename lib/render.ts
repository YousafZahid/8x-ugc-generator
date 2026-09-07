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
};

export type RenderInput = {
  /** Stock clip (.mp4/.webm) or still photo (.jpg/.png). Both are handled. */
  background: string;
  /** Transparent looping GIF. The most important visual element. */
  sticker: string;
  /** Backing track. Longer than the video is fine, it gets trimmed. */
  audio: string;
  /** Usually two: a hook card and a payoff card. */
  textCards: TextCard[];
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
    /** Sticker occupies this fraction of frame width. It should dominate. */
    stickerScale: Number(process.env.STICKER_SCALE ?? 0.58),
    /** Sticker centre, as a fraction of frame height. Below the text, above the fold. */
    stickerY: Number(process.env.STICKER_Y ?? 0.6),
    ffmpeg: process.env.FFMPEG_PATH ?? "ffmpeg",
    threads: Number(process.env.FFMPEG_THREADS ?? 2),
  };
}

const STILL = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export function buildArgs(input: RenderInput, cfg = renderConfig()): string[] {
  const { width: W, height: H, duration: D, fps, preset, crf } = cfg;
  const stillBg = STILL.has(path.extname(input.background).toLowerCase());

  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error", "-threads", String(cfg.threads)];

  // 0: background. A still gets looped into a clip; a video loops if it is short.
  if (stillBg) args.push("-loop", "1", "-t", String(D), "-i", input.background);
  else args.push("-stream_loop", "-1", "-t", String(D), "-i", input.background);

  // 1: sticker. -ignore_loop 0 makes the GIF repeat for the whole video.
  args.push("-ignore_loop", "0", "-i", input.sticker);

  // 2: audio.
  args.push("-i", input.audio);

  // 3..n: one input per text card.
  for (const card of input.textCards) args.push("-i", card.png);

  const stickerW = Math.round((W * cfg.stickerScale) / 2) * 2;
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

  // Layer 2 - text cards, each gated to its own window. Cards are authored at
  // exactly WxH by lib/text.ts, so no scale filter is inserted.
  let cur = "bg";
  input.textCards.forEach((card, i) => {
    const src = 3 + i;
    const next = `t${i}`;
    chains.push(
      `[${cur}][${src}:v]overlay=0:0:enable='between(t,${card.start},${card.end})'[${next}]`
    );
    cur = next;
  });

  // Layer 4 - the sticker, last so it sits above everything. This one keeps an
  // explicit rgba conversion: it is small, and its alpha is the whole point.
  chains.push(`[1:v]scale=${stickerW}:-2,format=rgba,setpts=PTS-STARTPTS[gif]`);
  chains.push(
    `[${cur}][gif]overlay=x=(W-w)/2:y=${cfg.stickerY}*H-h/2:shortest=0:format=auto[vout]`
  );

  // Layer 3 - audio: trim to length, ease in, duck out before the cut.
  const fadeOut = Math.max(0, D - 0.6);
  chains.push(
    `[2:a]atrim=0:${D},asetpts=PTS-STARTPTS,` +
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
