import { routeIntent } from "@/lib/intent";
import { createJob, emit, fail, finish, getJob } from "@/lib/jobs";
import { generate, newId } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The only entry point the chat UI posts to.
 *
 * Returns a reply for conversation, or a jobId for a render. The pipeline runs
 * detached and reports through the job registry, so this responds immediately
 * and the client watches /api/generate for progress.
 */

/** One render at a time. ffmpeg peaks near 1.6 GB and two would fight. */
let renderInFlight = 0;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_RENDERS ?? 1);

export async function POST(req: Request) {
  let message = "";
  try {
    const body = (await req.json()) as { message?: unknown };
    message = typeof body.message === "string" ? body.message.trim() : "";
  } catch {
    return Response.json({ error: "expected JSON with a message field" }, { status: 400 });
  }

  if (!message) return Response.json({ error: "say something first" }, { status: 400 });
  if (message.length > 2000) message = message.slice(0, 2000);

  let intent;
  try {
    intent = await routeIntent(message);
  } catch {
    // routeIntent already falls back internally; this is the last net.
    return Response.json({
      action: "chat",
      reply: "Something went wrong reading that. Try sending the product link again?",
    });
  }

  if (intent.action !== "generate" || !intent.url) {
    return Response.json({ action: "chat", reply: intent.reply });
  }

  if (renderInFlight >= MAX_CONCURRENT) {
    return Response.json({
      action: "chat",
      reply: "I'm already rendering a video — give me a few seconds and send that again.",
    });
  }

  const id = newId();
  const job = createJob(id);
  renderInFlight++;

  // Detached on purpose: the HTTP response returns now, progress arrives over
  // SSE. Nothing here is awaited, so every path must handle its own errors.
  void (async () => {
    try {
      const result = await generate(message, (p) => emit(job, p));
      finish(job, result);
    } catch (e) {
      // Never surface a stack trace to the chat.
      console.error("[generate]", e);
      fail(job, "I couldn't finish that video. Try again, or send a different link.");
    } finally {
      renderInFlight--;
    }
  })();

  return Response.json({ action: "generate", reply: intent.reply, jobId: id });
}

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "missing id" }, { status: 400 });
  const job = getJob(id);
  if (!job) return Response.json({ error: "unknown job" }, { status: 404 });
  return Response.json({
    id: job.id,
    status: job.status,
    events: job.events,
    videoUrl: job.result?.videoUrl,
    error: job.error,
  });
}
