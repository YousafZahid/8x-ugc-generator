import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import { readFile } from "node:fs/promises";

import { isValidId, posterPath, videoStat, videoStream } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serves a rendered mp4 from the ephemeral output directory.
 *
 * Not served from /public: Next only guarantees static serving for files that
 * existed at build time, and these are written at runtime. A route handler
 * reading from disk is unambiguous.
 *
 * Range requests are honoured because Safari and iOS will not play a video
 * from a source that answers 200 to every request - they need a 206.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;

  if (!isValidId(id)) {
    return Response.json({ error: "bad id" }, { status: 400 });
  }

  // Poster frames are small and static - just send the bytes.
  if (new URL(req.url).searchParams.get("poster")) {
    try {
      const jpg = await readFile(posterPath(id));
      return new Response(new Uint8Array(jpg), {
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": "public, max-age=3600",
          "Content-Length": String(jpg.byteLength),
        },
      });
    } catch {
      return Response.json({ error: "no poster" }, { status: 404 });
    }
  }

  const info = await videoStat(id);
  if (!info) {
    // Expected after an idle spin-down wipes the container filesystem.
    return Response.json(
      { error: "video expired", detail: "Renders are ephemeral on this instance. Generate it again." },
      { status: 404 }
    );
  }

  const headers = new Headers({
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=3600",
    "Content-Disposition": `inline; filename="${id}.mp4"`,
  });

  const range = req.headers.get("range");
  const match = range?.match(/^bytes=(\d*)-(\d*)$/);

  if (match) {
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;

    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= info.size) {
      headers.set("Content-Range", `bytes */${info.size}`);
      return new Response(null, { status: 416, headers });
    }

    headers.set("Content-Range", `bytes ${start}-${end}/${info.size}`);
    headers.set("Content-Length", String(end - start + 1));
    const stream = Readable.toWeb(videoStream(id, start, end)) as WebReadableStream<Uint8Array>;
    return new Response(stream as unknown as BodyInit, { status: 206, headers });
  }

  headers.set("Content-Length", String(info.size));
  const stream = Readable.toWeb(videoStream(id)) as WebReadableStream<Uint8Array>;
  return new Response(stream as unknown as BodyInit, { status: 200, headers });
}
