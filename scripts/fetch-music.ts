/**
 * Builds the audio library from real royalty-free music.
 *
 *   npm run music
 *
 * Source is the Openverse API - free, keyless, and it indexes CC-licensed
 * audio from Freesound, Jamendo and Wikimedia. Pixabay Music was the first
 * choice but is not reachable programmatically: their API has no music
 * endpoint (/api/music/ 404s, /api/audio/ 403s) and the music site returns
 * 403 to scripted requests.
 *
 * LICENCE FILTER, deliberately strict. Only cc0 and by are accepted:
 *   - by-nc  excluded: the output of this app is a marketing video
 *   - by-nd  excluded: compositing into a video makes a derivative
 *   - by-sa  excluded: share-alike would propagate to the user's video
 *
 * Every candidate is then earned, not assumed:
 *   1. long enough to cover the video
 *   2. decodes
 *   3. has an audible beat inside the first second - the video is 8s and
 *      starts cold, so a track that fades in wastes a quarter of it
 *   4. normalised two-pass to -14 LUFS / -1 dBTP, because the synthesised
 *      library it replaces measured -34 LUFS and was inaudible on a phone
 */

import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { VIBES, type Vibe } from "../lib/types";

const exec = promisify(execFile);
const AUDIO_DIR = path.join(process.cwd(), "audio");
const TMP = path.join(AUDIO_DIR, ".fetch");

/** Target length. Longer than the video so the render can trim and fade. */
const SECONDS = 20;
const TARGET_LUFS = -14;
const TARGET_TP = -1;
/**
 * Three per vibe, not two.
 *
 * With two, any pair of products landing on the same vibe collides half the
 * time, which is enough to fail the "4 products, 3+ distinct tracks" check on
 * a run where the model only picks two distinct vibes. Three cuts that.
 */
const PER_VIBE = 3;
/** Below this a candidate is a sample or a sound effect, not a piece of music. */
const MIN_SOURCE_SECONDS = 20;

/**
 * Genre queries per vibe. Chosen for what actually plays under short-form
 * video - not corporate/inspirational stock.
 */
const QUERIES: Record<Vibe, string[]> = {
  // Genre words, not descriptive phrases: archive.org's index matches
  // "phonk" and "downtempo" but returns nothing for "bright electronic loop".
  upbeat: ["upbeat", "pop instrumental", "dance pop"],
  chill: ["lofi", "chillout", "downtempo"],
  hype: ["phonk", "trap beat", "hip hop instrumental"],
  playful: ["funk", "playful", "groove"],
  cinematic: ["cinematic", "epic", "orchestral"],
  clean: ["minimal techno", "deep house", "techno"],
};

type Candidate = {
  id: string;
  title: string;
  creator: string;
  license: string;
  licenseVersion: string;
  provider: string;
  url: string;
  foreignLanding: string;
  duration: number;
};

async function search(q: string): Promise<Candidate[]> {
  const url =
    "https://api.openverse.org/v1/audio/?" +
    new URLSearchParams({ q, page_size: "20", license: "cc0,by" }).toString();

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "8x-ugc-generator/1.0" },
      signal: AbortSignal.timeout(40_000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { results?: Record<string, unknown>[] };
    return (body.results ?? [])
      .map((r) => ({
        id: String(r.id ?? ""),
        title: String(r.title ?? "Untitled"),
        creator: String(r.creator ?? "Unknown"),
        license: String(r.license ?? ""),
        licenseVersion: String(r.license_version ?? ""),
        provider: String(r.provider ?? ""),
        url: String(r.url ?? ""),
        foreignLanding: String(r.foreign_landing_url ?? ""),
        duration: Number(r.duration ?? 0),
      }))
      .filter((c) => c.url && (c.license === "cc0" || c.license === "by"));
  } catch {
    return [];
  }
}


/**
 * Second source: archive.org.
 *
 * Needed because Openverse's commercial-safe pool is thin - "phonk" has 232
 * results there but zero under cc0/by, and hype, playful and cinematic came
 * back empty on the first run.
 *
 * Restricted to the netlabels collection and Jamendo mirrors, and to CC-BY or
 * CC0. Open archive.org uploads carry user-supplied licence metadata that is
 * frequently wrong - a search for phonk returns commercial chart music tagged
 * public-domain - so the curated collections are the only trustworthy slice.
 * The "public domain mark" is excluded for the same reason.
 */
async function searchArchive(q: string): Promise<Candidate[]> {
  const lic = "(licenseurl:*licenses\\/by\\/* OR licenseurl:*publicdomain\\/zero*)";
  const src = "(collection:netlabels OR identifier:jamendo-*)";
  const query = `(${q}) AND mediatype:audio AND ${src} AND ${lic}`;
  const url =
    "https://archive.org/advancedsearch.php?" +
    new URLSearchParams({ q: query, rows: "8", output: "json" }).toString() +
    "&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=licenseurl";

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "8x-ugc-generator/1.0" },
      signal: AbortSignal.timeout(40_000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as {
      response?: { docs?: { identifier?: string; title?: string; creator?: string; licenseurl?: string }[] };
    };

    // Metadata is one request per item; sequentially that is a minute per
    // query. Fetched in parallel instead.
    const docs = (body.response?.docs ?? []).filter((d) => d.identifier);
    const resolved = await Promise.all(
      docs.map(async (doc) => {
        const id = doc.identifier as string;
        try {
          const meta = await fetch(`https://archive.org/metadata/${id}`, {
            headers: { "User-Agent": "8x-ugc-generator/1.0" },
            signal: AbortSignal.timeout(20_000),
          });
          if (!meta.ok) return null;
          const m = (await meta.json()) as { files?: { name?: string }[] };
          const audio = (m.files ?? []).find(
            (f) => f.name && /\.(mp3|ogg)$/i.test(f.name) && !/_sample|_spectrogram/i.test(f.name)
          );
          if (!audio?.name) return null;

          const licenseUrl = String(doc.licenseurl ?? "");
          return {
            id: `archive:${id}`,
            title: String(doc.title ?? id),
            creator: String(doc.creator ?? "Unknown"),
            license: /publicdomain\/zero/.test(licenseUrl) ? "cc0" : "by",
            licenseVersion: licenseUrl.match(/\/(\d\.\d)\//)?.[1] ?? "",
            provider: "archive.org",
            url: `https://archive.org/download/${id}/${encodeURIComponent(audio.name)}`,
            foreignLanding: `https://archive.org/details/${id}`,
            duration: 0,
          } as Candidate;
        } catch {
          return null;
        }
      })
    );
    const out = resolved.filter((c): c is Candidate => c !== null);
    return out;
  } catch {
    return [];
  }
}

async function download(url: string, dest: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "8x-ugc-generator/1.0" },
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength < 20_000) return false;
    await writeFile(dest, buf);
    return true;
  } catch {
    return false;
  }
}

async function durationOf(file: string): Promise<number> {
  try {
    const { stdout } = await exec("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file,
    ]);
    return Number(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

/** Mean volume over a window, in dBFS. */
async function meanVolume(file: string, start: number, dur: number): Promise<number> {
  try {
    const { stderr } = await exec("ffmpeg", [
      "-hide_banner", "-ss", String(start), "-t", String(dur),
      "-i", file, "-af", "volumedetect", "-f", "null", "-",
    ]);
    const m = stderr.match(/mean_volume:\s*(-?[\d.]+) dB/);
    return m ? Number(m[1]) : -99;
  } catch {
    return -99;
  }
}

/**
 * Does the track hit inside the first second?
 *
 * Compares the opening 0.9s against a mid-track reference. A track that fades
 * in reads much quieter at the start and is rejected: the video is 8 seconds
 * and starts cold, so a slow intro burns a quarter of it in silence.
 */
async function hasEarlyBeat(file: string, duration: number): Promise<{ ok: boolean; delta: number }> {
  const head = await meanVolume(file, 0, 0.9);
  const body = await meanVolume(file, Math.min(4, duration / 3), 4);
  const delta = head - body;
  return { ok: head > -45 && delta > -9, delta };
}

/** Two-pass loudnorm. One pass guesses; two measures then corrects. */
async function normalise(input: string, output: string): Promise<boolean> {
  let measured: Record<string, string>;
  try {
    const { stderr } = await exec("ffmpeg", [
      "-hide_banner", "-i", input,
      "-af", `loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TP}:LRA=11:print_format=json`,
      "-f", "null", "-",
    ], { maxBuffer: 16 * 1024 * 1024 });
    const json = stderr.slice(stderr.lastIndexOf("{"), stderr.lastIndexOf("}") + 1);
    measured = JSON.parse(json) as Record<string, string>;
  } catch {
    return false;
  }

  const filter =
    `loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TP}:LRA=11:` +
    `measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:` +
    `measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:` +
    `offset=${measured.target_offset}:linear=true:print_format=summary`;

  try {
    await exec("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      // Loop short sources up to length rather than discarding them - a good
      // 10-second loop is exactly what an 8-second video wants.
      "-stream_loop", "-1", "-i", input,
      "-t", String(SECONDS),
      "-af", `${filter},afade=t=out:st=${SECONDS - 1}:d=1`,
      "-c:a", "libmp3lame", "-b:a", "160k", "-ar", "44100", "-ac", "2",
      output,
    ], { maxBuffer: 16 * 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

/** Applies a fixed gain in place, with a limiter so the peak stays legal. */
async function applyGain(file: string, db: number): Promise<boolean> {
  const tmp = `${file}.gain.mp3`;
  try {
    await exec("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error", "-i", file,
      "-af", `volume=${db.toFixed(2)}dB,alimiter=limit=${Math.pow(10, TARGET_TP / 20).toFixed(4)}`,
      "-c:a", "libmp3lame", "-b:a", "160k", "-ar", "44100", "-ac", "2", tmp,
    ], { maxBuffer: 16 * 1024 * 1024 });
    await exec("mv", [tmp, file]);
    return true;
  } catch {
    await exec("rm", ["-f", tmp]).catch(() => {});
    return false;
  }
}

async function integratedLoudness(file: string): Promise<number> {
  try {
    const { stderr } = await exec("ffmpeg", [
      "-hide_banner", "-i", file, "-af", "ebur128=framelog=quiet", "-f", "null", "-",
    ], { maxBuffer: 16 * 1024 * 1024 });
    const m = stderr.match(/I:\s*(-?[\d.]+) LUFS/);
    return m ? Number(m[1]) : -99;
  } catch {
    return -99;
  }
}

export type Track = {
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

async function main() {
  await mkdir(AUDIO_DIR, { recursive: true });
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });

  const tracks: Track[] = [];
  const seenIds = new Set<string>();

  for (const vibe of VIBES) {
    console.log(`\n  ${vibe}`);
    let kept = 0;

    for (const q of QUERIES[vibe]) {
      if (kept >= PER_VIBE) break;
      // archive.org first. Openverse indexes Freesound heavily, which is a
      // sample library: "playful" there returns modular bleeps and vocal
      // utterances, not music. The Jamendo mirrors on archive.org are actual
      // released tracks, which is what has to play under a video.
      const fromArchive = await searchArchive(q);
      const fromOpenverse = await search(q);
      const candidates = [...fromArchive, ...fromOpenverse];
      console.log(
        `    "${q}" -> ${fromArchive.length} archive.org + ${fromOpenverse.length} openverse candidates`
      );

      for (const c of candidates) {
        if (kept >= PER_VIBE) break;
        if (seenIds.has(c.id)) continue;

        const raw = path.join(TMP, `${c.id}.raw`);
        if (!(await download(c.url, raw))) continue;

        const dur = await durationOf(raw);
        // 20s minimum. Short entries are one-shots and foley, not music -
        // looping a 2-second bleep for 8 seconds is not a backing track.
        if (dur < MIN_SOURCE_SECONDS) {
          console.log(`      skip ${c.title.slice(0, 34)} - only ${dur.toFixed(1)}s, not a track`);
          continue;
        }

        const beat = await hasEarlyBeat(raw, dur);
        if (!beat.ok) {
          console.log(`      skip ${c.title.slice(0, 30)} - no beat in first second (${beat.delta.toFixed(1)} dB)`);
          continue;
        }

        const out = path.join(AUDIO_DIR, `${vibe}-${kept + 1}.mp3`);
        if (!(await normalise(raw, out))) {
          console.log(`      skip ${c.title.slice(0, 30)} - loudnorm failed`);
          continue;
        }

        let lufs = await integratedLoudness(out);

        // loudnorm's linear mode silently gives up when a source needs more
        // gain than its headroom allows, leaving the track far below target -
        // one came out at -25.8 LUFS, which is the exact failure this whole
        // change exists to fix. Correct it with a measured gain, then verify.
        if (Math.abs(lufs - TARGET_LUFS) > 2.5) {
          const corrected = await applyGain(out, TARGET_LUFS - lufs);
          if (corrected) lufs = await integratedLoudness(out);
        }
        if (Math.abs(lufs - TARGET_LUFS) > 2.5) {
          console.log(`      skip ${c.title.slice(0, 34)} - stuck at ${lufs.toFixed(1)} LUFS`);
          continue;
        }

        seenIds.add(c.id);
        kept++;
        tracks.push({
          file: path.basename(out),
          vibe,
          title: c.title,
          creator: c.creator,
          license: `CC ${c.license.toUpperCase()}${c.licenseVersion ? ` ${c.licenseVersion}` : ""}`,
          source: c.foreignLanding || c.url,
          provider: c.provider,
          lufs: Number(lufs.toFixed(1)),
          seconds: SECONDS,
        });
        console.log(`      KEEP ${path.basename(out).padEnd(14)} ${c.title.slice(0, 34).padEnd(36)} ${lufs.toFixed(1)} LUFS  ${c.license}`);
      }
    }

    if (kept === 0) console.log(`    WARNING: nothing usable for ${vibe}`);
  }

  await rm(TMP, { recursive: true, force: true });
  await writeFile(path.join(AUDIO_DIR, "manifest.json"), JSON.stringify(tracks, null, 2) + "\n");

  const missing = VIBES.filter((v) => !tracks.some((t) => t.vibe === v));
  console.log(`\n  ${tracks.length} tracks across ${new Set(tracks.map((t) => t.vibe)).size} vibes`);
  if (missing.length) {
    console.error(`  FAIL: no track for ${missing.join(", ")}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
