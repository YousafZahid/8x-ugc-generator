/**
 * Minimal .env.local reader for CLI scripts.
 *
 * Next loads .env.local automatically; plain `tsx scripts/*.ts` does not, and
 * pulling in dotenv for eight lines is not worth a dependency. Existing
 * process.env always wins, so `GROQ_API_KEY= npm run brief` still forces the
 * fallback path.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

export function loadEnvLocal(file = ".env.local"): void {
  try {
    const text = readFileSync(path.join(process.cwd(), file), "utf8");
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      if (!(key in process.env)) process.env[key] = line.slice(eq + 1).trim();
    }
  } catch {
    // Absent .env.local is legitimate - callers degrade to their fallbacks.
  }
}
