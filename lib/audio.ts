/**
 * Picks a backing track for a vibe.
 *
 * Reads audio/manifest.json rather than hardcoding filenames, so swapping the
 * synthesised beds for real licensed music is a matter of dropping mp3s in and
 * editing the manifest - no code change.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { Asset, Vibe } from "./types";

export type AudioEntry = {
  file: string;
  vibe: Vibe;
  title: string;
  bpm: number;
  seconds: number;
  source: string;
};

const AUDIO_DIR = path.join(process.cwd(), "audio");

function manifest(): AudioEntry[] {
  try {
    const raw = readFileSync(path.join(AUDIO_DIR, "manifest.json"), "utf8");
    const entries = JSON.parse(raw) as AudioEntry[];
    return entries.filter((e) => e.file && existsSync(path.join(AUDIO_DIR, e.file)));
  } catch {
    return [];
  }
}

/**
 * Best match for the vibe, else anything in the library, else the fixture.
 * The fixture is a tone bed - audible, correct length, obviously a fallback.
 */
export function pickAudio(vibe: Vibe): Asset {
  const entries = manifest();
  const match = entries.find((e) => e.vibe === vibe) ?? entries[0];

  if (match) {
    return {
      path: path.join(AUDIO_DIR, match.file),
      source: "local",
      credit: `${match.title} (${match.bpm} bpm) - ${match.source}`,
      link: null,
    };
  }

  return {
    path: path.join(process.cwd(), "fixtures", "audio.mp3"),
    source: "fixture",
    credit: "fixture tone bed",
    link: null,
  };
}
