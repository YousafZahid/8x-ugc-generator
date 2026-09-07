/**
 * End-to-end render check with zero network and zero API keys.
 *
 * Composites the committed fixtures through the real lib/text.ts and
 * lib/render.ts paths, then verifies the result two ways: that the container
 * is valid (codecs, geometry, duration), and that every layer actually drew.
 *
 * Lives in lib/ because it runs in two places - `npm run smoke` locally, and
 * GET /api/smoke inside the deployed container, which is the only way to
 * benchmark Render's free instance since that plan has no shell access.
 */

import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { cpus } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { render, renderConfig, type RenderResult } from "./render";
import { textCardPng } from "./text";
import { opaquePixels } from "./media";

const exec = promisify(execFile);

type Box = { x: number; y: number; w: number; h: number };

/** Decodes one frame region to 8-bit greyscale. */
async function grayRegion(file: string, at: number, box: Box): Promise<Buffer> {
  const { stdout } = await exec(
    "ffmpeg",
    [
      "-hide_banner", "-v", "error",
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
 * Luma stddev floor for "this layer drew something".
 *
 * The fixture background is a smooth gradient, so a region containing only
 * background reads around 4. Text (white with a black stroke) and the sticker
 * (saturated shapes, white outlines) push it far past 12. A collapsed reading
 * means the layer is missing.
 *
 * Fixture-specific by design. It exists because an all-transparent sticker GIF
 * once passed every codec, dimension and duration check while rendering
 * nothing at all - the checks were green and the video had three layers.
 */
const FLAT = 12;

export type SmokeCheck = { name: string; pass: boolean; got: string };

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
  checks: SmokeCheck[];
  platform: string;
  cpus: number;
};

const FIXTURES = path.join(process.cwd(), "fixtures");

export async function runSmoke(outDir?: string): Promise<SmokeReport> {
  const cfg = renderConfig();
  const work = outDir ?? (await mkdtemp(path.join(tmpdir(), "smoke-")));
  await mkdir(work, { recursive: true });

  // Real cards through the real generator, so a broken font stack in the
  // container fails here rather than silently shipping blank text.
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

  // Asset-level. Unlike the frame checks below, this generalises to real
  // Giphy stickers, which are not guaranteed to carry usable alpha.
  const stickerOpaque = await opaquePixels(path.join(FIXTURES, "sticker.gif"));

  const box = Math.round(cfg.width * 0.28);
  const stickerBox: Box = {
    x: Math.round((cfg.width - box) / 2),
    y: Math.round(cfg.height * 0.6 - box / 2),
    w: box,
    h: box,
  };
  const textBox: Box = {
    x: 0,
    y: Math.round(cfg.height * 0.15),
    w: cfg.width,
    h: Math.round(cfg.height * 0.22),
  };

  const stickerSd = stddev(await grayRegion(result.out, cfg.duration / 2, stickerBox));
  const hookSd = stddev(await grayRegion(result.out, 1, textBox));
  const payoffSd = stddev(await grayRegion(result.out, cfg.duration - 1, textBox));

  const checks: SmokeCheck[] = [
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
    { name: "layer 2: hook card visible at t=1s", pass: hookSd > FLAT, got: `luma sd ${hookSd.toFixed(1)}` },
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
    cpus: cpus().length,
  };
}
