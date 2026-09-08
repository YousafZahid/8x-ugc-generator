/**
 * Generates the audio library.
 *
 *   npm run audio
 *
 * Why synthesise instead of downloading: "trending audio" in the TikTok sense
 * is not legally or technically available through any API, and anything
 * claiming otherwise is scraping that will break mid-demo. A committed library
 * never 404s, needs no key, adds no latency, and - because these are written
 * here rather than sourced - the licensing is unambiguous.
 *
 * These are beds, not bangers. To use real music instead, drop mp3s into
 * audio/ and add them to audio/manifest.json with a matching vibe; lib/audio.ts
 * reads the manifest and never hardcodes filenames.
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { VIBES, type Vibe } from "../lib/types";

const SR = 44100;
const SECONDS = 16;
const AUDIO_DIR = path.join(process.cwd(), "audio");

const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

type Osc = "sine" | "saw" | "tri" | "square";

function osc(kind: Osc, phase: number): number {
  const t = phase % 1;
  switch (kind) {
    case "sine":
      return Math.sin(2 * Math.PI * t);
    case "saw":
      return 2 * t - 1;
    case "tri":
      return 4 * Math.abs(t - 0.5) - 1;
    case "square":
      return t < 0.5 ? 1 : -1;
  }
}

type Voice = {
  osc: Osc;
  gain: number;
  attack: number;
  decay: number;
  /** Slight detune in cents, for width. */
  detune?: number;
};

/** Adds one note into the buffer with a percussive AD envelope. */
function note(
  buf: Float32Array,
  startSec: number,
  durSec: number,
  freq: number,
  v: Voice
): void {
  const start = Math.floor(startSec * SR);
  const len = Math.floor(durSec * SR);
  const detune = v.detune ? Math.pow(2, v.detune / 1200) : 1;

  for (let i = 0; i < len; i++) {
    const idx = start + i;
    if (idx < 0 || idx >= buf.length) continue;

    const t = i / SR;
    const attack = Math.min(1, t / Math.max(0.001, v.attack));
    const decay = Math.exp(-t / Math.max(0.001, v.decay));
    const env = attack * decay;

    buf[idx] += osc(v.osc, t * freq * detune) * v.gain * env;
  }
}

/** Short filtered-noise burst. Stands in for a hat or snare. */
function noiseHit(buf: Float32Array, startSec: number, durSec: number, gain: number): void {
  const start = Math.floor(startSec * SR);
  const len = Math.floor(durSec * SR);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const idx = start + i;
    if (idx < 0 || idx >= buf.length) continue;
    const white = Math.random() * 2 - 1;
    // One-pole high-pass, so it reads as a hat rather than a rumble.
    last = 0.6 * (last + white - (i > 0 ? white : 0));
    const env = Math.exp(-(i / SR) / Math.max(0.001, durSec * 0.35));
    buf[idx] += (white - last) * gain * env;
  }
}

/** Sine kick with a fast downward pitch sweep. */
function kick(buf: Float32Array, startSec: number, gain: number): void {
  const start = Math.floor(startSec * SR);
  const len = Math.floor(0.16 * SR);
  for (let i = 0; i < len; i++) {
    const idx = start + i;
    if (idx < 0 || idx >= buf.length) continue;
    const t = i / SR;
    const freq = 110 * Math.exp(-t * 28) + 45;
    buf[idx] += Math.sin(2 * Math.PI * freq * t) * gain * Math.exp(-t / 0.09);
  }
}

type TrackSpec = {
  vibe: Vibe;
  title: string;
  bpm: number;
  /** Chord roots as MIDI note numbers, one per bar. */
  progression: number[];
  /** Semitone offsets forming each chord. */
  chord: number[];
  pad: Voice;
  lead: Voice;
  bass: Voice;
  /** Sixteenth-note positions in the bar that get an arpeggio note. */
  arp: number[];
  drums: "four" | "half" | "none";
  hats: boolean;
};

const TRACKS: TrackSpec[] = [
  {
    vibe: "upbeat",
    title: "Bright Steps",
    bpm: 122,
    progression: [57, 64, 60, 55], // Am - E - C - G
    chord: [0, 4, 7, 11],
    pad: { osc: "tri", gain: 0.1, attack: 0.08, decay: 1.6, detune: 6 },
    lead: { osc: "sine", gain: 0.16, attack: 0.005, decay: 0.28 },
    bass: { osc: "saw", gain: 0.11, attack: 0.01, decay: 0.5 },
    arp: [0, 2, 4, 6, 8, 10, 12, 14],
    drums: "four",
    hats: true,
  },
  {
    vibe: "chill",
    title: "Slow Light",
    bpm: 84,
    progression: [53, 57, 60, 55],
    chord: [0, 4, 7, 14],
    pad: { osc: "tri", gain: 0.14, attack: 0.5, decay: 2.6, detune: 8 },
    lead: { osc: "sine", gain: 0.09, attack: 0.06, decay: 0.9 },
    bass: { osc: "sine", gain: 0.12, attack: 0.02, decay: 0.9 },
    arp: [0, 6, 10],
    drums: "half",
    hats: false,
  },
  {
    vibe: "hype",
    title: "Push",
    bpm: 140,
    progression: [45, 45, 48, 43],
    chord: [0, 3, 7, 10],
    pad: { osc: "saw", gain: 0.07, attack: 0.03, decay: 1.1, detune: 10 },
    lead: { osc: "square", gain: 0.1, attack: 0.004, decay: 0.16 },
    bass: { osc: "saw", gain: 0.15, attack: 0.005, decay: 0.32 },
    arp: [0, 2, 3, 6, 8, 10, 11, 14],
    drums: "four",
    hats: true,
  },
  {
    vibe: "playful",
    title: "Bounce",
    bpm: 128,
    progression: [60, 65, 62, 67],
    chord: [0, 4, 7, 12],
    pad: { osc: "tri", gain: 0.08, attack: 0.04, decay: 0.9 },
    lead: { osc: "tri", gain: 0.17, attack: 0.004, decay: 0.2 },
    bass: { osc: "square", gain: 0.09, attack: 0.01, decay: 0.28 },
    arp: [0, 3, 6, 8, 11, 14],
    drums: "four",
    hats: true,
  },
  {
    vibe: "cinematic",
    title: "Wide Open",
    bpm: 70,
    progression: [41, 48, 45, 43],
    chord: [0, 7, 12, 19],
    pad: { osc: "saw", gain: 0.09, attack: 0.9, decay: 3.4, detune: 12 },
    lead: { osc: "sine", gain: 0.07, attack: 0.4, decay: 2.2 },
    bass: { osc: "sine", gain: 0.16, attack: 0.05, decay: 2.4 },
    arp: [0, 8],
    drums: "half",
    hats: false,
  },
  {
    vibe: "clean",
    title: "Plain Air",
    bpm: 104,
    progression: [62, 57, 60, 55],
    chord: [0, 7, 12],
    pad: { osc: "sine", gain: 0.1, attack: 0.25, decay: 1.8 },
    lead: { osc: "sine", gain: 0.12, attack: 0.01, decay: 0.5 },
    bass: { osc: "sine", gain: 0.1, attack: 0.02, decay: 0.7 },
    arp: [0, 4, 8, 12],
    drums: "half",
    hats: false,
  },
];

function renderTrack(spec: TrackSpec): Float32Array {
  const buf = new Float32Array(SECONDS * SR);
  const beat = 60 / spec.bpm;
  const bar = beat * 4;
  const sixteenth = beat / 4;
  const bars = Math.ceil(SECONDS / bar);

  for (let b = 0; b < bars; b++) {
    const barStart = b * bar;
    if (barStart >= SECONDS) break;
    const root = spec.progression[b % spec.progression.length];

    // Pad: the whole chord, held across the bar.
    for (const interval of spec.chord) {
      note(buf, barStart, bar * 1.05, midi(root + interval), spec.pad);
      if (spec.pad.detune) {
        note(buf, barStart, bar * 1.05, midi(root + interval), {
          ...spec.pad,
          detune: -spec.pad.detune,
        });
      }
    }

    // Bass on the root, an octave down, on beats 1 and 3.
    note(buf, barStart, beat * 1.6, midi(root - 12), spec.bass);
    note(buf, barStart + beat * 2, beat * 1.6, midi(root - 12), spec.bass);

    // Arpeggio through the chord.
    spec.arp.forEach((step, i) => {
      const interval = spec.chord[i % spec.chord.length];
      const octave = i >= spec.chord.length ? 12 : 0;
      note(buf, barStart + step * sixteenth, beat * 0.9, midi(root + interval + octave + 12), spec.lead);
    });

    // Drums.
    if (spec.drums === "four") {
      for (let k = 0; k < 4; k++) kick(buf, barStart + k * beat, 0.5);
    } else if (spec.drums === "half") {
      kick(buf, barStart, 0.42);
      kick(buf, barStart + beat * 2, 0.42);
    }
    if (spec.hats) {
      for (let k = 0; k < 8; k++) noiseHit(buf, barStart + k * (beat / 2) + beat / 4, 0.06, 0.16);
    }
  }

  // Normalise to a consistent ceiling, then fade the tail so a loop point is
  // never a click. The renderer fades again, but a clean source matters.
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  const scale = peak > 0 ? 0.82 / peak : 1;
  const fade = Math.floor(0.4 * SR);
  for (let i = 0; i < buf.length; i++) {
    let g = scale;
    if (i < fade) g *= i / fade;
    if (i > buf.length - fade) g *= (buf.length - i) / fade;
    // Soft clip, so the arpeggio stacking never crackles.
    buf[i] = Math.tanh(buf[i] * g * 1.1);
  }
  return buf;
}

function encodeMp3(pcm: Float32Array, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "f32le", "-ar", String(SR), "-ac", "1", "-i", "pipe:0",
      "-c:a", "libmp3lame", "-b:a", "128k", "-ar", "44100",
      out,
    ]);
    ff.on("error", reject);
    ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`))));
    ff.stdin.write(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    ff.stdin.end();
  });
}

async function main() {
  await mkdir(AUDIO_DIR, { recursive: true });

  const manifest: { file: string; vibe: Vibe; title: string; bpm: number; seconds: number; source: string }[] = [];

  for (const spec of TRACKS) {
    const file = `${spec.vibe}.mp3`;
    await encodeMp3(renderTrack(spec), path.join(AUDIO_DIR, file));
    manifest.push({
      file,
      vibe: spec.vibe,
      title: spec.title,
      bpm: spec.bpm,
      seconds: SECONDS,
      source: "synthesised by scripts/make-audio.ts",
    });
    console.log(`  ${file.padEnd(16)} ${spec.title.padEnd(14)} ${spec.bpm} bpm`);
  }

  await writeFile(path.join(AUDIO_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  const missing = VIBES.filter((v) => !manifest.some((m) => m.vibe === v));
  if (missing.length) {
    console.error(`\n  FAIL: no track for vibe(s): ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log(`\n  ${manifest.length} tracks, one per vibe. manifest.json written.\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
