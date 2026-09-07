import { runSmoke } from "@/lib/smoke";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Runs the full fixture render inside this container and reports timing and
 * memory. Render's free plan has no shell, so this endpoint is the only way to
 * measure encode time and peak RSS on the instance that will actually serve.
 *
 * Serialised: a 512 MB instance will not survive two concurrent 1080x1920
 * filter graphs, and the numbers would be meaningless anyway.
 */
let inFlight: Promise<unknown> | null = null;

export async function GET() {
  if (inFlight) {
    return Response.json(
      { ok: false, error: "a smoke render is already running on this instance" },
      { status: 429 }
    );
  }

  const started = Date.now();
  try {
    const run = runSmoke();
    inFlight = run;
    const report = await run;
    return Response.json({
      ...report,
      totalMs: Date.now() - started,
      memory: {
        ffmpegPeakMb: +(report.render.peakRss / 1024 / 1024).toFixed(1),
        containerPeakMb: +(report.render.containerPeak / 1024 / 1024).toFixed(1),
        nodeRssMb: +(process.memoryUsage().rss / 1024 / 1024).toFixed(1),
      },
    });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  } finally {
    inFlight = null;
  }
}
