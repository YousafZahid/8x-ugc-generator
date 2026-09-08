/**
 * message -> URL -> page -> brief -> assets -> four-layer mp4.
 *
 * The whole product in one function. Each stage reports progress, and each has
 * a fallback beneath it, so the pipeline has no failure mode that reaches the
 * user as an error - only a less specific video.
 */

import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { selectAssets } from "./assets";
import { buildBrief } from "./brief";
import { posterFrame, render, renderConfig } from "./render";
import { scrape, extractUrl } from "./scrape";
import { ensureOutDir, posterPath, posterUrl, prune, videoPath, videoUrl } from "./storage";
import { textCardPng } from "./text";
import type { AssetSet, Brief, Product, Progress } from "./types";

export type GenerateResult = {
  id: string;
  videoUrl: string;
  /** Still frame for the player, so the payoff is not a grey box. */
  posterUrl: string | null;
  product: Product;
  brief: Brief;
  assets: AssetSet;
  /** Attribution owed for the stock assets used. */
  credits: string[];
  ms: { scrape: number; brief: number; assets: number; render: number; total: number };
  notes: string[];
};

export function newId(): string {
  return randomBytes(8).toString("hex");
}

export type OnProgress = (p: Progress) => void;

export async function generate(
  message: string,
  onProgress: OnProgress = () => {}
): Promise<GenerateResult> {
  const started = Date.now();
  const cfg = renderConfig();
  const id = newId();
  const notes: string[] = [];

  const url = extractUrl(message);
  if (!url) {
    // Callers route on intent before getting here; this is a guard, not a path.
    throw new Error("no product URL in the message");
  }

  const work = await mkdtemp(path.join(tmpdir(), `ugc-${id}-`));

  try {
    // 1. Read the site.
    onProgress({ step: "read", detail: `Reading ${new URL(url).hostname}` });
    const t0 = Date.now();
    const product = await scrape(url);
    const scrapeMs = Date.now() - t0;
    if (product.via === "domain") {
      notes.push("the site could not be read, so the brief works from the name alone");
    }

    // 2. Decide the creative.
    onProgress({ step: "understand", detail: "Working out what it is" });
    const t1 = Date.now();
    const { brief, provider, errors } = await buildBrief(product, message);
    const briefMs = Date.now() - t1;

    // Show the user we understood them before the slow part starts.
    onProgress({
      step: "understand",
      detail: `Understood: ${brief.name}${brief.category ? ` — ${brief.category}` : ""}`,
      meta: { product: brief.name, hook: brief.hook },
    });
    if (brief.source === "fallback") {
      notes.push(`wrote the copy without an LLM (${errors[0] ?? "no provider available"})`);
    }

    // 3. Cast it.
    onProgress({
      step: "assets",
      detail: `Finding "${brief.backgroundQuery}" footage and a ${brief.stickerQuery} sticker`,
    });
    const t2 = Date.now();
    const { assets, notes: assetNotes } = await selectAssets(brief, work, product.host);
    notes.push(...assetNotes);
    const assetsMs = Date.now() - t2;

    // 4. Draw the text, then composite.
    onProgress({ step: "compose", detail: "Compositing four layers with ffmpeg" });
    const t3 = Date.now();

    const half = cfg.duration / 2;
    const hookPng = await textCardPng({
      text: brief.hook,
      kicker: brief.name,
      variant: "hook",
      width: cfg.width,
      height: cfg.height,
      out: path.join(work, "card-hook.png"),
    });
    const payoffPng = await textCardPng({
      text: brief.payoff,
      variant: "payoff",
      width: cfg.width,
      height: cfg.height,
      out: path.join(work, "card-payoff.png"),
    });

    await ensureOutDir();
    const out = videoPath(id);

    await render(
      {
        background: assets.background.path,
        sticker: assets.sticker.path,
        audio: assets.audio.path,
        textCards: [
          { png: hookPng, start: 0, end: half },
          { png: payoffPng, start: half, end: cfg.duration },
        ],
        out,
      },
      cfg
    );
    const renderMs = Date.now() - t3;

    // Non-fatal: a missing poster costs polish, not the video.
    const hasPoster = await posterFrame(out, posterPath(id), Math.min(1.5, cfg.duration / 4), cfg);

    // Keep the ephemeral directory under its cap.
    const pruned = await prune();
    if (pruned.deleted.length) {
      notes.push(`pruned ${pruned.deleted.length} older render(s) to stay under the disk cap`);
    }

    const credits = [assets.background, assets.sticker, assets.audio]
      .filter((a) => a.source !== "fixture")
      .map((a) => (a.link ? `${a.credit} (${a.link})` : a.credit));

    // Deliberately does NOT emit step:"done". Completion is announced by
    // jobs.finish() once the result is actually attached to the job. Emitting
    // it here raced the assignment: an SSE subscriber saw "done", looked for
    // job.result, found nothing, sent no event and closed the stream - so the
    // browser sat on a spinner forever while the video sat finished on disk.
    return {
      id,
      videoUrl: videoUrl(id),
      posterUrl: hasPoster ? posterUrl(id) : null,
      product,
      brief: { ...brief, source: provider ? "llm" : brief.source },
      assets,
      credits,
      notes,
      ms: {
        scrape: scrapeMs,
        brief: briefMs,
        assets: assetsMs,
        render: renderMs,
        total: Date.now() - started,
      },
    };
  } finally {
    // Downloaded source material is large and single-use.
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
