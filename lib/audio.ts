/**
 * Picks a backing track for a vibe.
 *
 * Reads audio/manifest.json rather than hardcoding filenames, so swapping the
 * library is a data change, not a code change.
 *
 * Where a vibe has several tracks, the choice is seeded on the product's
 * domain: the same product always gets the same track (so a re-render is
 * reproducible and a demo is repeatable), while different products differ.
 * Random selection would break reproducibility; index 0 would make the extra
 * tracks decorative.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { Asset, Vibe } from "./types";

export type AudioEntry = {
  file: string;
  vibe: Vibe;
  title: string;
  creator: string;
  license: string;
  source: string;
  provider: string;
  lufs: number;
  seconds: number;
};

const AUDIO_DIR = path.join(process.cwd(), "audio");

let cache: AudioEntry[] | null = null;

export function manifest(): AudioEntry[] {
  if (cache) return cache;
  try {
    const raw = readFileSync(path.join(AUDIO_DIR, "manifest.json"), "utf8");
    const entries = JSON.parse(raw) as AudioEntry[];
    cache = entries.filter((e) => e.file && existsSync(path.join(AUDIO_DIR, e.file)));
  } catch {
    cache = [];
  }
  return cache;
}

/** The vibes the library can actually satisfy. The brief is constrained to these. */
export function availableVibes(): Vibe[] {
  return [...new Set(manifest().map((e) => e.vibe))];
}

/** FNV-1a. Small, dependency-free, and stable across processes and restarts. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function toAsset(entry: AudioEntry): Asset {
  return {
    path: path.join(AUDIO_DIR, entry.file),
    source: "local",
    credit: `"${entry.title}" by ${entry.creator} (${entry.license}, via ${entry.provider})`,
    link: entry.source || null,
  };
}

/**
 * @param vibe  what the brief asked for
 * @param seed  the product's domain, so the pick is stable per product
 */
export function pickAudio(vibe: Vibe, seed = ""): Asset {
  const entries = manifest();
  const matching = entries.filter((e) => e.vibe === vibe);

  // Exact vibe match, seeded across however many tracks carry that vibe.
  if (matching.length) {
    return toAsset(matching[hash(seed) % matching.length]);
  }

  // The manifest has no track for this vibe. Rather than always handing back
  // the first entry - which is what makes a library look hardcoded - spread
  // across everything available, still seeded.
  if (entries.length) {
    return toAsset(entries[hash(seed) % entries.length]);
  }

  return {
    path: path.join(process.cwd(), "fixtures", "audio.mp3"),
    source: "fixture",
    credit: "fixture tone bed",
    link: null,
  };
}
