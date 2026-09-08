/**
 * Casts the video: a background clip, a transparent sticker, a backing track.
 *
 * Everything here is a real, pre-existing asset fetched from a stock library.
 * Nothing is generated. Each stage has a hardcoded fallback, so a rate limit,
 * an empty search or a dead CDN produces a less interesting video rather than
 * an error in the chat.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";

import { opaqueFraction } from "./media";
import { pickAudio } from "./audio";
import type { Asset, AssetSet, Brief } from "./types";

const TIMEOUT_MS = Number(process.env.ASSET_TIMEOUT_MS ?? 15_000);
/** Keep downloads bounded: a 4K clip is slower to fetch than it is to encode. */
const MAX_BYTES = Number(process.env.ASSET_MAX_BYTES ?? 40 * 1024 * 1024);

const FIXTURES = path.join(process.cwd(), "fixtures");

export type AssetReport = {
  assets: AssetSet;
  notes: string[];
};

async function download(url: string, dest: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return false;

    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) return false;

    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.byteLength || buf.byteLength > MAX_BYTES) return false;

    await writeFile(dest, buf);
    return true;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------- background

type PexelsVideo = {
  id: number;
  width: number;
  height: number;
  duration: number;
  url: string;
  user?: { name?: string };
  video_files?: { link: string; width: number; height: number; file_type: string; quality: string }[];
};

/**
 * Prefers portrait and a sensible resolution. A 4K file costs download time we
 * do not get back, and everything is cropped to 1080x1920 regardless.
 */
function bestFile(video: PexelsVideo): string | null {
  const files = (video.video_files ?? []).filter((f) => f.file_type === "video/mp4" && f.link);
  if (!files.length) return null;

  const scored = files
    .map((f) => {
      const portrait = f.height > f.width ? 2 : 0;
      // 1080-1920px tall is the sweet spot; punish anything enormous.
      const size = f.height >= 1000 && f.height <= 2200 ? 2 : f.height > 2200 ? -1 : 0;
      return { f, score: portrait + size };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0]?.f.link ?? null;
}

async function pexelsBackground(query: string, workDir: string, notes: string[]): Promise<Asset | null> {
  const key = process.env.PEXELS_API_KEY;
  if (!key) {
    notes.push("no Pexels key - using the fixture background");
    return null;
  }

  try {
    const url =
      `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}` +
      `&per_page=12&orientation=portrait&size=medium`;
    const res = await fetch(url, {
      headers: { Authorization: key },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      notes.push(`Pexels HTTP ${res.status}`);
      return null;
    }

    const body = (await res.json()) as { videos?: PexelsVideo[] };
    const videos = body.videos ?? [];
    if (!videos.length) {
      notes.push(`Pexels had nothing for "${query}"`);
      return null;
    }

    // Try candidates in order - a single dead CDN link should not sink it.
    for (const video of videos.slice(0, 4)) {
      const link = bestFile(video);
      if (!link) continue;
      const dest = path.join(workDir, "background.mp4");
      if (await download(link, dest)) {
        return {
          path: dest,
          source: "pexels",
          credit: `Video by ${video.user?.name ?? "Pexels contributor"} on Pexels`,
          link: video.url,
        };
      }
    }
    notes.push("every Pexels candidate failed to download");
    return null;
  } catch (e) {
    notes.push(`Pexels error: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** Pixabay backs up Pexels. Different library, different coverage, also free. */
async function pixabayBackground(query: string, workDir: string, notes: string[]): Promise<Asset | null> {
  const key = process.env.PIXABAY_API_KEY;
  if (!key) return null;

  try {
    const url = `https://pixabay.com/api/videos/?key=${key}&q=${encodeURIComponent(query)}&per_page=10`;
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      notes.push(`Pixabay HTTP ${res.status}`);
      return null;
    }

    const body = (await res.json()) as {
      hits?: { pageURL: string; user: string; videos?: Record<string, { url: string; width: number; height: number }> }[];
    };
    for (const hit of body.hits?.slice(0, 4) ?? []) {
      const file = hit.videos?.large ?? hit.videos?.medium ?? hit.videos?.small;
      if (!file?.url) continue;
      const dest = path.join(workDir, "background.mp4");
      if (await download(file.url, dest)) {
        notes.push("background came from Pixabay (Pexels had nothing)");
        return {
          path: dest,
          source: "pexels",
          credit: `Video by ${hit.user} on Pixabay`,
          link: hit.pageURL,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ sticker

type GiphyItem = {
  id: string;
  title?: string;
  url?: string;
  username?: string;
  images?: Record<string, { url?: string; width?: string; height?: string; size?: string }>;
};

/**
 * A "sticker" is only useful if it actually has alpha. Giphy's sticker
 * endpoint mostly returns transparent art, but not always - some entries are
 * ordinary GIFs on a solid rectangle, which composite as an opaque box sitting
 * on the video and ruin the shot.
 *
 * So every candidate is downloaded and measured before it is accepted:
 * near-fully-opaque means it is a boxed GIF, near-fully-transparent means it
 * is empty. Both are rejected and the next candidate is tried.
 */
const OPAQUE_BOX = 0.92;
const EMPTY = 0.02;

async function giphySticker(query: string, workDir: string, notes: string[]): Promise<Asset | null> {
  const key = process.env.GIPHY_API_KEY;
  if (!key) {
    notes.push("no Giphy key - using the fixture sticker");
    return null;
  }

  try {
    const url =
      `https://api.giphy.com/v1/stickers/search?api_key=${key}` +
      `&q=${encodeURIComponent(query)}&limit=15&rating=pg&bundle=messaging_non_clips`;
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      notes.push(`Giphy HTTP ${res.status}`);
      return null;
    }

    const body = (await res.json()) as { data?: GiphyItem[] };
    const items = body.data ?? [];
    if (!items.length) {
      notes.push(`Giphy had no stickers for "${query}"`);
      return null;
    }

    let rejected = 0;
    for (const item of items.slice(0, 6)) {
      const img =
        item.images?.original ??
        item.images?.downsized_medium ??
        item.images?.fixed_height;
      if (!img?.url) continue;

      const dest = path.join(workDir, "sticker.gif");
      if (!(await download(img.url, dest))) continue;

      const fraction = await opaqueFraction(dest);
      if (fraction >= OPAQUE_BOX || fraction <= EMPTY) {
        rejected++;
        continue;
      }

      if (rejected) notes.push(`skipped ${rejected} sticker(s) with unusable alpha`);
      return {
        path: dest,
        source: "giphy",
        credit: `Sticker${item.username ? ` by ${item.username}` : ""} via GIPHY`,
        link: item.url ?? null,
      };
    }

    notes.push(`all Giphy candidates for "${query}" had unusable alpha`);
    return null;
  } catch (e) {
    notes.push(`Giphy error: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

// ---------------------------------------------------------------- selection

const fixtureBackground = (): Asset => ({
  path: path.join(FIXTURES, "bg.mp4"),
  source: "fixture",
  credit: "fixture gradient",
  link: null,
});

const fixtureSticker = (): Asset => ({
  path: path.join(FIXTURES, "sticker.gif"),
  source: "fixture",
  credit: "fixture sticker",
  link: null,
});

export async function selectAssets(
  brief: Brief,
  workDir: string,
  /** Product domain - seeds the track choice so it is stable per product. */
  seed = ""
): Promise<AssetReport> {
  const notes: string[] = [];

  // Background and sticker are independent lookups - run them together.
  const [background, sticker] = await Promise.all([
    (async () =>
      (await pexelsBackground(brief.backgroundQuery, workDir, notes)) ??
      (await pixabayBackground(brief.backgroundQuery, workDir, notes)) ??
      fixtureBackground())(),
    (async () =>
      (await giphySticker(brief.stickerQuery, workDir, notes)) ??
      // One retry on a generic term: a niche query returning nothing usable is
      // common, and a generic sticker still beats the fixture.
      (await giphySticker("sparkles", workDir, notes)) ??
      fixtureSticker())(),
  ]);

  const audio = pickAudio(brief.vibe, seed);

  return { assets: { background, sticker, audio }, notes };
}
