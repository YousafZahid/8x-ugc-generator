import { getJob } from "@/lib/jobs";
import type { Progress } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-sent progress for one job.
 *
 * A render takes ten-plus seconds on this hardware, and a silent spinner for
 * that long reads as broken. Streaming "reading the site -> picking footage ->
 * compositing" is the cheapest thing that makes the wait legible.
 *
 * Buffered events replay on connect, so a client that subscribes just after
 * the job starts still sees the whole story.
 */
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "missing id" }, { status: 400 });

  const job = getJob(id);
  if (!job) return Response.json({ error: "unknown job" }, { status: 404 });

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      // Declared before close() uses it. As a `const` further down it sat in
      // the temporal dead zone on the already-finished path: settle() ->
      // close() threw a ReferenceError, Next tore the stream down, and the
      // client got an empty body and hung on "rendering" forever.
      let keepAlive: ReturnType<typeof setInterval> | undefined;

      const close = () => {
        if (closed) return;
        closed = true;
        job.listeners.delete(onProgress);
        if (keepAlive) clearInterval(keepAlive);
        try {
          controller.close();
        } catch {
          // Already torn down by the client disconnecting.
        }
      };

      const settle = () => {
        if (job.error) send("error", { message: job.error });
        else if (job.result) {
          send("done", {
            videoUrl: job.result.videoUrl,
            brief: job.result.brief,
            credits: job.result.credits,
            notes: job.result.notes,
            ms: job.result.ms,
          });
        }
        close();
      };

      const onProgress = (p: Progress) => {
        if (p.step === "done" || p.step === "error") settle();
        else send("progress", p);
      };

      // Replay what already happened before this client connected.
      for (const p of job.events) {
        if (p.step !== "done" && p.step !== "error") send("progress", p);
      }

      if (job.done) {
        settle();
        return;
      }

      job.listeners.add(onProgress);

      // Proxies drop idle connections; a ping every 15s keeps it open.
      keepAlive = setInterval(() => send("ping", { t: Date.now() }), 15_000);

      req.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx-style proxies buffer SSE without this.
      "X-Accel-Buffering": "no",
    },
  });
}
