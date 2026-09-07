/**
 * End-to-end render check with zero network and zero API keys.
 *
 * Composites the committed fixtures through the real lib/text.ts and
 * lib/render.ts code paths, then probes the output to prove it is a valid,
 * playable, correctly-sized mp4 with both streams present.
 *
 *   npm run smoke
 *   VIDEO_HEIGHT=1280 npm run smoke
 *
 * This is also what runs inside the deployed container (via /api/smoke) to
 * measure encode time and peak RSS on the real instance.
 */

import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { render, renderConfig, type RenderResult } from "../lib/render";
import { textCardPng } from "../lib/text";
import { opaquePixels } from "../lib/media";

const exec = promisify(execFile);

type Box = { x: number; y: number; w: number; h: number };

/** Decodes one frame region to 8-bit greyscale. */
async function grayRegion(file: string, at: number, box: Box, extra: string[] = []): Promise<Buffer> {
  const { stdout } = await exec(
    "ffmpeg",
    [
      "-hide_banner", "-v", "error",
      ...extra,
      "-ss", String(at), "-i", file,
      "-frames:v", "1",
      "-vf", `crop=${box.w}:${box.h}:${box.x}:${box.y}`,
      "-f", "rawvideo", "-pix_fmt", "gray", "-",
    ],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }
  );
  return stdout as unknown as Buffer;
}

function stddev(buf: Buffer): number {
  if (!buf.length) return 0;
  let sum = 0;
  for (const v of buf) sum += v;
  const mean = sum / buf.length;
  let acc = 0;
  for (const v of buf) acc += (v - mean) ** 2;
  return Math.sqrt(acc / buf.length);
}

/**
 * Layer-presence checks.
 *
 * The fixture background is a smooth gradient, so any region containing only
 * background has a luma stddev of roughly 4. Text (white on black stroke) and
 * the sticker (saturated shapes with white outlines) push it far higher. A
 * collapsed reading means that layer never drew.
 *
 * This is fixture-specific by design - it exists because an all-transparent
 * sticker GIF once passed every codec, dimension and duration check while
 * rendering nothing at all.
 */
const FLAT = 12;

export type SmokeReport = {
  ok: boolean;
  render: RenderResult;
  probe: {
    videoCodec: string;
    audioCodec: string;
    width: number;
    height: number;
    duration: number;
  };
  checks: { name: string; pass: boolean; got: string }[];
  platform: string;
  cpus: number;
};

const FIXTURES = path.join(process.cwd(), "fixtures");

export async function runSmoke(outDir?: string): Promise<SmokeReport> {
  const cfg = renderConfig();
  const work = outDir ?? (await mkdtemp(path.join(tmpdir(), "smoke-")));
  await mkdir(work, { recursive: true });

  // Real text cards through the real generator - not the PNG fixture, so a
  // broken font stack or SVG regression fails here rather than in production.
  const hook = await textCardPng({
    text: "Stop guessing what you ate",
    kicker: "CalAI",
    variant: "hook",
    width: cfg.width,
    height: cfg.height,
    out: path.join(work, "card-hook.png"),
  });
  const payoff = await textCardPng({
    text: "Snap a photo. Get the macros.",
    variant: "payoff",
    width: cfg.width,
    height: cfg.height,
    out: path.join(work, "card-payoff.png"),
  });

  const half = cfg.duration / 2;
  const result = await render(
    {
      background: path.join(FIXTURES, "bg.mp4"),
      sticker: path.join(FIXTURES, "sticker.gif"),
      audio: path.join(FIXTURES, "audio.mp3"),
      textCards: [
        { png: hook, start: 0, end: half },
        { png: payoff, start: half, end: cfg.duration },
      ],
      out: path.join(work, "smoke.mp4"),
    },
    cfg
  );

  const { stdout } = await exec("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name,width,height",
    "-show_entries", "format=duration",
    "-of", "json",
    result.out,
  ]);
  const probed = JSON.parse(stdout) as {
    streams: { codec_type: string; codec_name: string; width?: number; height?: number }[];
    format: { duration: string };
  };

  const v = probed.streams.find((s) => s.codec_type === "video");
  const a = probed.streams.find((s) => s.codec_type === "audio");
  const duration = Number(probed.format.duration);

  const probe = {
    videoCodec: v?.codec_name ?? "none",
    audioCodec: a?.codec_name ?? "none",
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    duration,
  };

  // --- layer presence, not just container validity ---

  // The sticker asset itself must carry visible pixels. Generalises to real
  // Giphy stickers, unlike the frame checks below.
  const stickerOpaque = await opaquePixels(path.join(FIXTURES, "sticker.gif"));

  const box = Math.round(cfg.width * 0.28);
  const stickerBox = {
    x: Math.round((cfg.width - box) / 2),
    y: Math.round(cfg.height * 0.6 - box / 2),
    w: box,
    h: box,
  };
  const textBox = {
    x: 0,
    y: Math.round(cfg.height * 0.15),
    w: cfg.width,
    h: Math.round(cfg.height * 0.22),
  };

  const stickerSd = stddev(await grayRegion(result.out, cfg.duration / 2, stickerBox));
  const hookSd = stddev(await grayRegion(result.out, 1, textBox));
  const payoffSd = stddev(await grayRegion(result.out, cfg.duration - 1, textBox));

  const checks = [
    { name: "video stream is h264", pass: probe.videoCodec === "h264", got: probe.videoCodec },
    { name: "audio stream is aac", pass: probe.audioCodec === "aac", got: probe.audioCodec },
    { name: `width is ${cfg.width}`, pass: probe.width === cfg.width, got: String(probe.width) },
    { name: `height is ${cfg.height}`, pass: probe.height === cfg.height, got: String(probe.height) },
    {
      name: `duration within 0.4s of ${cfg.duration}`,
      pass: Math.abs(duration - cfg.duration) < 0.4,
      got: `${duration.toFixed(2)}s`,
    },
    { name: "file is non-trivial", pass: result.bytes > 50_000, got: `${result.bytes} bytes` },
    {
      name: "layer 4: sticker asset has opaque pixels",
      pass: stickerOpaque > 1000,
      got: `${stickerOpaque} px`,
    },
    {
      name: "layer 4: sticker composited into frame",
      pass: stickerSd > FLAT,
      got: `luma sd ${stickerSd.toFixed(1)}`,
    },
    {
      name: "layer 2: hook card visible at t=1s",
      pass: hookSd > FLAT,
      got: `luma sd ${hookSd.toFixed(1)}`,
    },
    {
      name: `layer 2: payoff card visible at t=${cfg.duration - 1}s`,
      pass: payoffSd > FLAT,
      got: `luma sd ${payoffSd.toFixed(1)}`,
    },
  ];

  return {
    ok: checks.every((c) => c.pass),
    render: result,
    probe,
    checks,
    platform: `${process.platform}/${process.arch}`,
    cpus: (await import("node:os")).cpus().length,
  };
}

const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

// Run directly: `npm run smoke`
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  runSmoke()
    .then((r) => {
      console.log("");
      console.log(`  output      ${r.render.out}`);
      console.log(`  size        ${r.render.width}x${r.render.height}  ${r.render.duration}s  preset=${r.render.preset}`);
      console.log(`  encode      ${(r.render.ms / 1000).toFixed(2)}s wall clock`);
      console.log(`  peak RSS    ${r.render.peakRss ? `${mb(r.render.peakRss)} MB` : "n/a (non-Linux)"}`);
      console.log(`  container   ${r.render.containerPeak ? `${mb(r.render.containerPeak)} MB peak` : "n/a (no cgroup)"}`);
      console.log(`  file        ${mb(r.render.bytes)} MB`);
      console.log(`  host        ${r.platform}, ${r.cpus} cpu`);
      console.log("");
      for (const c of r.checks) console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}  (${c.got})`);
      console.log("");
      if (!r.ok) process.exit(1);
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
