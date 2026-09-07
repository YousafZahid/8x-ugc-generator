import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const exec = promisify(execFile);

/**
 * Liveness plus the one dependency that cannot be assumed: ffmpeg. Render's
 * health check hits this, so a container that built but cannot encode is
 * reported unhealthy rather than quietly failing at first render.
 */
export async function GET() {
  let ffmpeg = "missing";
  try {
    const { stdout } = await exec("ffmpeg", ["-version"]);
    ffmpeg = stdout.split("\n")[0] ?? "unknown";
  } catch {
    // reported as missing below
  }

  const ok = ffmpeg !== "missing";
  return Response.json(
    {
      ok,
      ffmpeg,
      node: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      config: {
        height: process.env.VIDEO_HEIGHT ?? "1920",
        duration: process.env.VIDEO_DURATION ?? "8",
        preset: process.env.VIDEO_PRESET ?? "veryfast",
      },
      keys: {
        groq: Boolean(process.env.GROQ_API_KEY),
        gemini: Boolean(process.env.GEMINI_API_KEY),
        pexels: Boolean(process.env.PEXELS_API_KEY),
        giphy: Boolean(process.env.GIPHY_API_KEY),
      },
    },
    { status: ok ? 200 : 503 }
  );
}
