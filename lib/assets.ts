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
import { jamendoTrack } from "./music";
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

/**
 * Pexels puts a description in the URL slug:
 *   /video/person-using-a-laptop-while-holding-a-card-1234567/
 * That is the only relevance signal the API gives us, and it is a good one.
 */
function pexelsSlugWords(url: string): string {
  return url
    .replace(/^https?:\/\/www\.pexels\.com\/video\//, "")
    .replace(/-?\d+\/?$/, "")
    .replace(/-/g, " ");
}

/**
 * How well a clip matches what the brief asked to film.
 *
 * The background layer had no relevance check at all: it took the first of the
 * top four results that downloaded. Searching "person reviewing property map
 * on laptop" for a property marketplace returned "person using a laptop while
 * holding a card" at rank 0 and "world map on a laptop screen" at rank 4, and
 * the card one won for being first. Pexels keyword-matches loosely enough that
 * rank is close to meaningless.
 */
export function backgroundScore(video: { url?: string }, query: string, brief: Brief): number {
  const hay = new Set(words(pexelsSlugWords(video.url ?? "")));
  if (!hay.size) return 0;

  let score = 0;
  for (const w of words(query)) if (hay.has(w)) score += 3;
  for (const w of words(brief.category)) if (hay.has(w)) score += 2;
  return score;
}

async function pexelsBackground(
  queries: string[],
  brief: Brief,
  workDir: string,
  notes: string[]
): Promise<Asset | null> {
  const key = process.env.PEXELS_API_KEY;
  if (!key) {
    notes.push("no Pexels key - using the fixture background");
    return null;
  }

  try {
    // Every query is searched, and the winner is the best clip across all of
    // them rather than the best clip from whichever ran first.
    const pages = await Promise.all(
      queries.map(async (query) => {
        const url =
          `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}` +
          `&per_page=20&orientation=portrait&size=medium`;
        const res = await fetch(url, {
          headers: { Authorization: key },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) {
          notes.push(`Pexels HTTP ${res.status}`);
          return [];
        }
        const body = (await res.json()) as { videos?: PexelsVideo[] };
        return (body.videos ?? []).map((video, rank) => ({
          video,
          rank,
          score: backgroundScore(video, query, brief),
        }));
      })
    );

    const all = pages.flat();
    if (!all.length) {
      notes.push(`Pexels had nothing for ${queries.map((q) => `"${q}"`).join(" / ")}`);
      return null;
    }

    const ranked = all.sort((a, b) => b.score - a.score || a.rank - b.rank);
    const relevant = ranked.filter((r) => r.score > 0);
    const pool = relevant.length ? relevant : ranked;
    if (!relevant.length) {
      notes.push("no Pexels clip described itself in the brief's terms - used the closest match");
    }
    const videos = all;

    for (const { video, score } of pool.slice(0, 5)) {
      const link = bestFile(video);
      if (!link) continue;
      const dest = path.join(workDir, "background.mp4");
      if (await download(link, dest)) {
        notes.push(`footage scored ${score} of ${videos.length} candidates`);
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
/** Candidates whose alpha we actually download and measure, across all queries. */
const ALPHA_BUDGET = 8;

const STOPWORDS = new Set([
  "the","a","an","and","or","for","with","your","you","that","this","its","it",
  "of","to","in","on","from","by","app","apps","get","gets","give","gives",
  "make","makes","so","without","into","every","all","one","more","less","is",
  "are","be","can","when","what","how","who","their","them","use","using",
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/** Giphy's slug carries the uploader's tags: "TELUS-owl-owls-telus-<id>". */
function slugWords(slug: string): string {
  return slug.split("-").slice(0, -1).join(" ");
}

/**
 * How well a candidate matches the product.
 *
 * Alpha validity is not relevance, and taking the first alpha-valid result was
 * the whole bug: measured across five products, Giphy's rank 0 was usually a
 * branded promo whose only tag was the uploader's name or the literal word
 * "transparent", while a genuine match sat several places down. Duolingo
 * rendered with a head-shaking eagle this way.
 *
 * The query terms carry the most weight, then what the product is; the value
 * proposition is a weak signal and is scored as such.
 */
export function relevanceScore(
  candidate: { title?: string; slug?: string; alt_text?: string },
  queries: string[],
  brief: Brief
): number {
  return scoreParts(candidate, queries, brief).total;
}

/**
 * Split out so the caller can require a strong signal, not just any signal.
 *
 * Duolingo picked a "Game Sticker" on a total of 1, earned entirely from the
 * word "game" appearing in its value proposition, while nothing matched the
 * actual queries. A value-proposition match is corroboration; on its own it is
 * close to noise.
 */
export function scoreParts(
  candidate: { title?: string; slug?: string; alt_text?: string },
  queries: string[],
  brief: Brief
): { total: number; strong: number } {
  const haystack = new Set(
    words(
      `${candidate.title ?? ""} ${slugWords(candidate.slug ?? "")} ${candidate.alt_text ?? ""}`
    )
  );
  if (!haystack.size) return { total: 0, strong: 0 };

  let strong = 0;
  let weak = 0;
  for (const q of queries) {
    // Averaged over the query's own words. Summing them made a two-word term
    // worth double a one-word term for no better reason than its length -
    // which is how the derived "game controller" outscored "chat bubble".
    const qw = words(q);
    if (qw.length) {
      const hits = qw.filter((w) => haystack.has(w)).length;
      strong += (hits / qw.length) * 4;
    }
  }
  for (const w of words(brief.category)) if (haystack.has(w)) strong += 2;
  for (const w of words(brief.valueProp)) if (haystack.has(w)) weak += 1;

  return { total: strong + weak, strong };
}

type ScoredCandidate = { item: GiphyItem; score: number; strong: number; query: string; rank: number };

/** Fetches one page of stickers and scores every result against the brief. */
async function giphyCandidates(
  query: string,
  brief: Brief,
  notes: string[]
): Promise<ScoredCandidate[]> {
  const key = process.env.GIPHY_API_KEY;
  if (!key) return [];

  try {
    const url =
      `https://api.giphy.com/v1/stickers/search?api_key=${key}` +
      `&q=${encodeURIComponent(query)}&limit=15&rating=pg&bundle=messaging_non_clips`;
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      notes.push(`Giphy HTTP ${res.status}`);
      return [];
    }
    const body = (await res.json()) as { data?: GiphyItem[] };
    return (body.data ?? []).map((item, rank) => {
      const { total, strong } = scoreParts(item, [query], brief);
      return { item, rank, query, score: total, strong };
    });
  } catch (e) {
    notes.push(`Giphy error: ${e instanceof Error ? e.message : e}`);
    return [];
  }
}

/**
 * Picks the best sticker across every candidate query.
 *
 * Relevance is now a filter in its own right: a score of zero means nothing in
 * the title or the uploader's tags relates to the product, and those are
 * rejected outright rather than accepted for having valid alpha. Alpha remains
 * a hard filter on top.
 *
 * Candidates are tried highest-score-first rather than in Giphy's order, and
 * only a budget of them are downloaded, since measuring alpha costs a fetch.
 */
async function pickSticker(
  queries: string[],
  brief: Brief,
  workDir: string,
  notes: string[]
): Promise<Asset | null> {
  const pages = await Promise.all(queries.map((q) => giphyCandidates(q, brief, notes)));
  // Requires a query or category hit. Without that a candidate is only
  // related to the product by a stray word in its value proposition.
  const relevant = pages.flat().filter((c) => c.strong > 0);

  if (!relevant.length) {
    notes.push(`no Giphy sticker matched ${queries.map((q) => `"${q}"`).join(" / ")}`);
    return null;
  }

  // Best match first; Giphy's own ranking only breaks ties.
  relevant.sort((a, b) => b.score - a.score || a.rank - b.rank);

  let rejectedAlpha = 0;
  for (const c of relevant.slice(0, ALPHA_BUDGET)) {
    const img =
      c.item.images?.original ?? c.item.images?.downsized_medium ?? c.item.images?.fixed_height;
    if (!img?.url) continue;

    const dest = path.join(workDir, "sticker.gif");
    if (!(await download(img.url, dest))) continue;

    const fraction = await opaqueFraction(dest);
    if (fraction >= OPAQUE_BOX || fraction <= EMPTY) {
      rejectedAlpha++;
      continue;
    }

    if (rejectedAlpha) notes.push(`skipped ${rejectedAlpha} sticker(s) with unusable alpha`);
    // Why this one won, in the notes the chat already surfaces. Without it a
    // bad pick is unexplainable from the outside - which is how a "Game"
    // sticker kept beating a chat bubble with no way to see the reason.
    notes.push(
      `sticker scored ${c.score} (strong ${c.strong}) on "${c.query}", ` +
        `beating ${relevant.length - 1} other candidate(s)`
    );
    // Giphy titles usually read "Heart Heartbeat Sticker by Hands-Only CPR",
    // so appending the username again produced "... by X by X".
    const rawTitle = (c.item.title ?? "").trim();
    const named = / by .+$/i.test(rawTitle);
    const title = rawTitle.replace(/\s*Sticker\s*( by )/i, "$1").replace(/\s*Sticker\s*$/i, "").trim();
    const credit =
      (title || "Sticker") +
      (!named && c.item.username ? ` by ${c.item.username}` : "") +
      " via GIPHY";

    return { path: dest, source: "giphy", credit, link: c.item.url ?? null };
  }

  notes.push("every relevant Giphy candidate had unusable alpha");
  return null;
}

/**
 * Filler terms. A model that returns one of these has not really chosen - it
 * has reached for decoration - and left alone it makes every product converge
 * on the same sticker.
 */
const GENERIC_STICKER = /^(sparkles?|stars?|magic|shine|glitter|wow|cool|nice|fun|awesome)$/i;

/**
 * Retry term derived from what the product actually is, so a failed niche
 * query does not land every product on the same generic sticker.
 */
export function fallbackStickerTerm(brief: Brief): string {
  // Category and audience only. valueProp used to be in here, and it is a
  // description of HOW a product works, not what it is: Duolingo's "short
  // game-like lessons" classified a language app as gaming.
  const haystack = `${brief.category} ${brief.audience}`.toLowerCase();
  const table: [RegExp, string][] = [
    // Ordered. The first match wins, so specific categories precede the
    // generic ones they might otherwise be swallowed by.
    [/language|translat|vocabulary|fluency/, "chat bubble"],
    [/calorie|nutrition|meal|food|recipe|diet|restaurant/, "food"],
    [/fitness|workout|gym|training|running|wearable|recovery/, "muscle"],
    [/sleep|calm|meditat|wellness|mental|mindful/, "sleep"],
    [/finance|money|invest|bank|budget|payment|crypto|trading/, "money"],
    [/travel|flight|hotel|trip|booking/, "airplane"],
    [/music|audio|podcast|sound|listening/, "music"],
    [/photo|camera|video|design|creative|editing/, "camera"],
    [/study|learn|course|education|school|tutor/, "books"],
    [/video game|gaming|esports|game studio/, "game controller"],
    [/shop|store|ecommerce|retail|fashion|clothing/, "shopping"],
    [/code|developer|programming|api|terminal|launcher|dev tool/, "computer"],
    [/calendar|schedul|meeting|productivity|task|note/, "clock"],
    [/chat|message|social|community|network/, "chat bubble"],
    [/pet|dog|cat|animal/, "dog"],
    [/car|drive|vehicle|delivery|logistics/, "car"],
    [/security|privacy|password|vpn|encrypt/, "lock"],
    [/search|answer|research|knowledge|ai assistant/, "lightbulb"],
    [/browser|web|internet|website/, "globe"],
    [/app|mobile|phone|ios|android/, "phone"],
  ];
  for (const [re, term] of table) if (re.test(haystack)) return term;
  return "sparkles";
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
  seed = "",
  /** Seconds the track must cover: video length plus room to start mid-track. */
  minAudioSeconds = 20
): Promise<AssetReport> {
  const notes: string[] = [];

  // All three lookups are independent - run them together. Audio was
  // sequential after the other two, which put the whole Jamendo round trip on
  // the critical path instead of hiding it behind the Pexels download.
  const [background, sticker, live] = await Promise.all([
    (async () =>
      (await pexelsBackground(brief.backgroundQueries, brief, workDir, notes)) ??
      (await pixabayBackground(brief.backgroundQueries[0] ?? "", workDir, notes)) ??
      fixtureBackground())(),
    (async () => {
      // Drop filler terms, add the derived one, then score across all of them
      // together and take the best overall match.
      const queries = brief.stickerQueries.filter((q) => !GENERIC_STICKER.test(q.trim()));
      if (queries.length < brief.stickerQueries.length) {
        notes.push("dropped a filler sticker term from the brief");
      }

      // The model's own ranked terms, on their own, first.
      //
      // The derived term used to be appended here as a peer and could beat
      // them: for Duolingo it injected "game controller", which won and put a
      // games console on a language-learning ad. It is a fallback, so it now
      // behaves like one.
      const best = queries.length
        ? await pickSticker(queries, brief, workDir, notes)
        : null;
      if (best) return best;

      const derivedTerm = fallbackStickerTerm(brief);
      const derived = await pickSticker([derivedTerm], brief, workDir, notes);
      if (derived) {
        notes.push(`fell back to a "${derivedTerm}" sticker`);
        return derived;
      }

      // Nothing relevant anywhere: a generic sticker still beats the fixture.
      return (await pickSticker(["sparkles"], brief, workDir, notes)) ?? fixtureSticker();
    })(),
    jamendoTrack(brief.vibe, seed, brief.musicTags, minAudioSeconds, workDir, notes),
  ]);

  // Audio is tiered like every other layer: live search, then the committed
  // library, then the fixture. The library is the guaranteed floor - it is
  // pre-normalised and always present, so a slow or empty Jamendo never costs
  // more than freshness.
  const audio = live ?? pickAudio(brief.vibe, seed);

  return { assets: { background, sticker, audio }, notes };
}
