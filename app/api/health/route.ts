import { execFile } from "node:child_process";

import { manifest } from "@/lib/audio";
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
      // Surfaced because an empty library is invisible otherwise: every render
      // still succeeds, just with the fixture tone bed under it.
      audioTracks: manifest().length,
      keys: {
        groq: Boolean(process.env.GROQ_API_KEY),
        gemini: Boolean(process.env.GEMINI_API_KEY),
        pexels: Boolean(process.env.PEXELS_API_KEY),
        giphy: Boolean(process.env.GIPHY_API_KEY),
        // Without this the live music tier is off and nothing says so: every
        // render still succeeds, quietly served by the committed library.
        jamendo: Boolean(process.env.JAMENDO_CLIENT_ID),
      },
    },
    { status: ok ? 200 : 503 }
  );
}
