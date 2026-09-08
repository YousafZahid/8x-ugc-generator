/**
 * Live music search against Jamendo.
 *
 * The other three asset layers are live API searches with fallbacks beneath
 * them; audio was the only one reading from a folder. This closes that gap.
 * It is the same catalogue either way - the committed library was fetched from
 * Jamendo through the archive.org mirror - so this is a freshness and
 * consistency change, not a change of source material.
 *
 * LICENCE FILTER, matching the committed library exactly. Jamendo's catalogue
 * is mostly by-nc / by-sa / by-nd, none of which we can use:
 *   ccnc=false  the output is a marketing video, a commercial use
 *   ccnd=false  compositing music into a video makes a derivative
 *   ccsa=false  share-alike would propagate to the user's finished video
 * That leaves CC-BY, which needs attribution - captured and surfaced in chat.
 */

import { execFile } from "node:child_process";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { Asset, Vibe } from "./types";

const exec = promisify(execFile);

const API = "https://api.jamendo.com/v3.0/tracks/";
const TIMEOUT_MS = Number(process.env.MUSIC_TIMEOUT_MS ?? 12_000);
const MAX_BYTES = Number(process.env.MUSIC_MAX_BYTES ?? 25 * 1024 * 1024);

/**
 * Jamendo's own tag vocabulary, which is not our vibe vocabulary. Several
 * plausible tags return nothing once the licence clauses are excluded
 * ("lounge", "funk" and "soundtrack" all came back empty), so each vibe has a
 * ladder and the first tag with results wins.
 */
const TAGS: Record<Vibe, string[]> = {
  upbeat: ["pop", "dance", "pop+happy"],
  chill: ["chillout", "ambient", "lounge"],
  hype: ["hiphop", "electronic+energetic", "drumnbass"],
  playful: ["funk+groove", "jazz", "funk"],
  cinematic: ["soundtrack+epic", "classical", "soundtrack"],
  clean: ["techno", "minimal", "electronic+techno"],
};

type JamendoTrack = {
  id?: string;
  name?: string;
  artist_name?: string;
  duration?: number;
  audio?: string;
  shareurl?: string;
  license_ccurl?: string;
  musicinfo?: { tags?: { genres?: string[]; instruments?: string[]; vartags?: string[] } };
};

/**
 * How well a track fits the brief.
 *
 * Selection used to be `hash(domain) % results.length` and nothing else - a
 * seeded coin flip across forty tracks, with no notion of whether any of them
 * suited the product. That is why the audio kept landing on full vocal songs
 * like "A Love Song" under a language-learning ad.
 */
/**
 * Tags that make a track wrong for a product ad regardless of its genre.
 *
 * Jamendo's tags are uploader-supplied and loose: a track tagged "minimal" can
 * be a children's song, and one of these landed under a property marketplace.
 * Genre overlap alone cannot catch that, so these are excluded outright.
 */
const UNSUITABLE = new Set([
  "children", "kids", "kid", "childrens", "child", "nursery", "lullaby",
  "christmas", "xmas", "halloween", "religious", "gospel", "worship", "hymn",
  "metal", "deathmetal", "blackmetal", "hardcore", "punk", "noise", "scream",
  "horror", "creepy", "sad", "funeral", "spokenword", "speech", "podcast",
]);

function scoreTrack(track: JamendoTrack, wanted: string[]): number {
  const genres = track.musicinfo?.tags?.genres ?? [];
  const vartags = track.musicinfo?.tags?.vartags ?? [];
  const hay = new Set([...genres, ...vartags].map((t) => t.toLowerCase()));
  const name = (track.name ?? "").toLowerCase();

  // Disqualified outright rather than ranked down: no amount of genre match
  // makes a nursery rhyme right under a property ad.
  for (const t of hay) if (UNSUITABLE.has(t)) return -1;
  for (const w of ["children", "kids", "lullaby", "christmas"]) {
    if (name.includes(w)) return -1;
  }

  let score = 0;
  for (const w of wanted) {
    const t = w.toLowerCase().trim();
    if (hay.has(t)) score += 3;
  }
  // An explicit instrumental version is the ideal bed.
  if (/instrumental/.test(name)) score += 2;
  return score;
}

/** FNV-1a, matching the other seeded choices so a domain is stable everywhere. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function licenceName(url: string | undefined): string {
  const m = /licenses\/([a-z-]+)\/([\d.]+)/i.exec(url ?? "");
  return m ? `CC ${m[1].toUpperCase()} ${m[2]}` : "CC BY";
}

async function search(
  tag: string,
  minDuration: number,
  instrumentalOnly: boolean
): Promise<JamendoTrack[]> {
  const clientId = process.env.JAMENDO_CLIENT_ID;
  if (!clientId) return [];

  const params = new URLSearchParams({
    client_id: clientId,
    format: "json",
    limit: "40",
    fuzzytags: tag,
    audioformat: "mp31",
    // Floor well above the video length so a 12-second clip can never win, and
    // there is room left to start mid-track.
    durationbetween: `${Math.max(30, Math.ceil(minDuration))}_600`,
    ccnc: "false",
    ccnd: "false",
    ccsa: "false",
    boost: "popularity_month",
    include: "licenses musicinfo",
    // Instrumental first. A track with a lead vocal competes with the
    // on-screen copy for attention across eight seconds; ad beds are
    // instrumental for a reason. Retried without this when it returns nothing.
    ...(instrumentalOnly ? { vocalinstrumental: "instrumental" } : {}),
  });

  try {
    const res = await fetch(`${API}?${params}`, {
      headers: { "User-Agent": "8x-ugc-generator/1.0" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { headers?: { status?: string }; results?: JamendoTrack[] };
    if (body.headers?.status !== "success") return [];
    return (body.results ?? []).filter(
      (t) => t.audio && typeof t.duration === "number" && t.duration >= minDuration
    );
  } catch {
    // Timeout, DNS, rate limit - the caller falls through to the library.
    return [];
  }
}

async function download(url: string, dest: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "8x-ugc-generator/1.0" },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS + 8_000),
    });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    // A few KB means an error page, not a track.
    if (buf.byteLength < 50_000 || buf.byteLength > MAX_BYTES) return false;
    await writeFile(dest, buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Brings a downloaded track to the same level as the committed library.
 *
 * Runs here rather than in the render chain: in the chain it cost ~1.3s of
 * encode on every render including the already-normalised library files,
 * where here it touches only live downloads and sits inside the asset stage
 * that is waiting on the network anyway.
 *
 * Non-fatal. An un-normalised track is quieter than ideal, not broken.
 */
async function trimAndNormalise(
  file: string,
  startAt: number,
  seconds: number
): Promise<boolean> {
  const target = Number(process.env.LOUDNESS_TARGET ?? -14);
  const peak = Number(process.env.LOUDNESS_PEAK ?? -1);
  const tmp = `${file}.norm.mp3`;
  try {
    await exec("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      // Seek before -i so ffmpeg skips rather than decodes the lead-in.
      "-ss", startAt.toFixed(2), "-t", seconds.toFixed(2), "-i", file,
      "-af", `loudnorm=I=${target}:TP=${peak}:LRA=11`,
      "-c:a", "libmp3lame", "-b:a", "160k", "-ar", "44100", "-ac", "2", tmp,
    ], { maxBuffer: 16 * 1024 * 1024, timeout: 25_000 });
    await rename(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns a downloaded CC-BY track for the vibe, or null to fall through.
 *
 * @param minDuration seconds the track must cover: the video plus offset room
 * @param seed        product domain, so the same product gets the same track
 */
export async function jamendoTrack(
  vibe: Vibe,
  seed: string,
  /** Genre tags the brief chose for this product, tried before the vibe ladder. */
  briefTags: string[],
  minDuration: number,
  workDir: string,
  notes: string[] = [],
  /** Length of the window kept from the track. */
  windowSeconds = 12
): Promise<Asset | null> {
  if (!process.env.JAMENDO_CLIENT_ID) return null;

  // The brief's own genre tags come first: they are chosen from the product's
  // niche, where the vibe ladder is one of six coarse buckets shared by every
  // product that happens to land in it. The ladder stays as the fallback.
  const ladder = [...briefTags.map((t) => t.toLowerCase().trim()).filter(Boolean),
                  ...(TAGS[vibe] ?? TAGS.upbeat)];

  for (const tag of ladder) {
    // Jamendo's filtered pages are sparse and vary between calls, so an empty
    // instrumental page does not mean the tag is unusable.
    let results = await search(tag, minDuration, true);
    if (!results.length) results = await search(tag, minDuration, false);
    if (!results.length) continue;

    // Rank by fit, then seed within the strongest handful. Ranking alone would
    // give every product in a genre the same track; seeding alone was what
    // produced a random pick out of forty.
    const ranked = results
      .map((t, rank) => ({ t, rank, score: scoreTrack(t, [tag, ...briefTags]) }))
      .filter((r) => r.score >= 0)
      // Jamendo's own popularity order breaks ties. Without it the top eight
      // were frequently all on the same score and the seeded pick was
      // arbitrary among them.
      .sort((a, b) => b.score - a.score || a.rank - b.rank);

    if (!ranked.length) continue;
    // Nothing actually matched the genre asked for; the next tag will do
    // better than an arbitrary track from this one.
    if (ranked[0].score === 0 && ladder.indexOf(tag) < ladder.length - 1) continue;

    const pool = ranked.slice(0, Math.min(8, ranked.length)).map((r) => r.t);

    const start = hash(seed) % pool.length;
    for (let i = 0; i < Math.min(3, pool.length); i++) {
      const track = pool[(start + i) % pool.length];
      const dest = path.join(workDir, "music.mp3");
      if (!(await download(track.audio as string, dest))) continue;

      // Pick the mid-track window here, then trim to it before normalising.
      // Normalising a whole four-minute track to use eight seconds of it was
      // most of the ~20s this tier was adding to a render.
      const duration = track.duration as number;
      const latestStart = Math.max(0, duration - windowSeconds - 0.5);
      const startOffset = +Math.min(6 + (hash(seed) % 7), latestStart).toFixed(2);
      const trimmed = await trimAndNormalise(dest, startOffset, windowSeconds);

      return {
        path: dest,
        source: "jamendo",
        credit:
          `"${track.name ?? "Untitled"}" by ${track.artist_name ?? "Unknown"} ` +
          `(${licenceName(track.license_ccurl)}, via Jamendo)`,
        link: track.shareurl ?? null,
        durationSeconds: trimmed ? windowSeconds : duration,
        preTrimmed: trimmed,
        startOffset: trimmed ? startOffset : undefined,
      };
    }
  }

  notes.push("Jamendo had nothing usable - using the committed library");
  return null;
}
