/**
 * Scrape any URL through the real pipeline and print what the brief stage
 * would receive.
 *
 *   npm run scrape -- https://calai.app https://linear.app
 *
 * Used for the fresh-URL checks: the deliverable requires a render from a URL
 * that was never tuned against, so this is how a candidate gets vetted before
 * it goes anywhere near a demo.
 */

import { scrape, extractUrl } from "../lib/scrape";

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: npm run scrape -- <url|sentence> [...]");
    process.exit(1);
  }

  for (const arg of args) {
    const url = extractUrl(arg);
    if (!url) {
      console.log(`\n  ${JSON.stringify(arg)}\n    no URL found - this would be treated as chat, not a render request`);
      continue;
    }

    const started = Date.now();
    const p = await scrape(url);
    const ms = Date.now() - started;

    console.log(`\n  ${url}   [via ${p.via}]  ${ms}ms`);
    console.log(`    title : ${p.title.slice(0, 100) || "(none)"}`);
    console.log(`    desc  : ${p.description.slice(0, 120) || "(none)"}`);
    console.log(`    image : ${p.image?.slice(0, 90) ?? "(none)"}`);
    console.log(`    text  : ${p.text.length} chars`);
    if (p.via === "domain") {
      console.log(`    NOTE  : both fetch tiers failed; the brief will run on the name alone`);
    }
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
