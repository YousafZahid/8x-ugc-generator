/**
 * One minimal live call per service. Run before trusting any of them.
 *
 *   npm run check-keys
 *
 * Prints OK/FAIL and the HTTP status. Never prints a key - only a masked
 * prefix, so the output is safe to paste into a chat or an issue.
 *
 * Every request is the cheapest read each API offers, so this costs nothing
 * against the free-tier quotas that the whole project depends on.
 */

import { loadEnvLocal } from "../lib/env";

type Check = {
  name: string;
  env: string;
  /** Builds the request from the key. */
  request: (key: string) => { url: string; init?: RequestInit };
  /** Pulls a short proof-of-life detail out of a successful body. */
  detail?: (body: unknown) => string;
};

const CHECKS: Check[] = [
  {
    name: "Groq",
    env: "GROQ_API_KEY",
    request: (k) => ({
      url: "https://api.groq.com/openai/v1/models",
      init: { headers: { Authorization: `Bearer ${k}` } },
    }),
    detail: (b) => {
      const models = (b as { data?: { id: string }[] }).data ?? [];
      return `${models.length} models`;
    },
  },
  {
    name: "Gemini",
    env: "GEMINI_API_KEY",
    request: (k) => ({
      url: `https://generativelanguage.googleapis.com/v1beta/models?key=${k}`,
    }),
    detail: (b) => {
      const models = (b as { models?: { name: string }[] }).models ?? [];
      return `${models.length} models`;
    },
  },
  {
    name: "Pexels",
    env: "PEXELS_API_KEY",
    request: (k) => ({
      url: "https://api.pexels.com/videos/search?query=kitchen&per_page=1&orientation=portrait",
      init: { headers: { Authorization: k } },
    }),
    detail: (b) => {
      const v = (b as { videos?: unknown[]; total_results?: number });
      return `${v.total_results ?? 0} results`;
    },
  },
  {
    name: "Giphy",
    env: "GIPHY_API_KEY",
    // Stickers, not gifs - transparency is the whole reason we use Giphy.
    request: (k) => ({
      url: `https://api.giphy.com/v1/stickers/search?api_key=${k}&q=food&limit=1&rating=pg`,
    }),
    detail: (b) => {
      const d = (b as { data?: unknown[] }).data ?? [];
      return `${d.length} stickers`;
    },
  },
  {
    name: "Pixabay",
    env: "PIXABAY_API_KEY",
    request: (k) => ({
      url: `https://pixabay.com/api/?key=${k}&q=kitchen&per_page=3`,
    }),
    detail: (b) => `${(b as { totalHits?: number }).totalHits ?? 0} hits`,
  },
  {
    name: "Render",
    env: "RENDER_API_KEY",
    request: (k) => ({
      url: "https://api.render.com/v1/owners?limit=1",
      init: { headers: { Authorization: `Bearer ${k}`, Accept: "application/json" } },
    }),
    detail: (b) => {
      const owners = (b as { owner?: { name?: string } }[]) ?? [];
      const first = Array.isArray(owners) ? owners[0]?.owner?.name : undefined;
      return first ? `owner ${first}` : "authenticated";
    },
  },
];

function mask(key: string): string {
  if (key.length <= 10) return `${key.slice(0, 2)}...(${key.length} chars)`;
  return `${key.slice(0, 6)}...${key.slice(-2)} (${key.length} chars)`;
}

async function run(check: Check): Promise<boolean> {
  const key = process.env[check.env];
  if (!key) {
    console.log(`  FAIL  ${check.name.padEnd(8)} ${check.env} not set`);
    return false;
  }

  const { url, init } = check.request(key);
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();

    let detail = "";
    if (res.ok && check.detail) {
      try {
        detail = ` - ${check.detail(JSON.parse(text))}`;
      } catch {
        detail = " - unparseable body";
      }
    }
    if (!res.ok) {
      // Trim: some providers return a full HTML error page.
      const snippet = text.replace(/\s+/g, " ").slice(0, 160);
      console.log(`  FAIL  ${check.name.padEnd(8)} HTTP ${res.status}  ${mask(key)}`);
      console.log(`        ${snippet}`);
      return false;
    }

    console.log(`  OK    ${check.name.padEnd(8)} HTTP ${res.status}  ${mask(key)}${detail}`);
    return true;
  } catch (e) {
    console.log(
      `  FAIL  ${check.name.padEnd(8)} network  ${mask(key)}  ${e instanceof Error ? e.message : e}`
    );
    return false;
  }
}

async function main() {
  loadEnvLocal();
  console.log("\n  Live key check - one minimal request per service\n");

  const results: { name: string; ok: boolean }[] = [];
  for (const check of CHECKS) {
    results.push({ name: check.name, ok: await run(check) });
  }

  const failed = results.filter((r) => !r.ok);
  console.log("");
  if (failed.length === 0) {
    console.log(`  All ${results.length} services reachable.\n`);
  } else {
    console.log(`  ${failed.length} of ${results.length} failed: ${failed.map((f) => f.name).join(", ")}\n`);
  }
  process.exit(failed.length ? 1 : 0);
}

main();
