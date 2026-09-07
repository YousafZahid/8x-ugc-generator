/**
 * CLI wrapper around lib/smoke.ts.
 *
 *   npm run smoke
 *   VIDEO_HEIGHT=1280 npm run smoke
 *
 * The same report is served by GET /api/smoke inside the deployed container,
 * which is how the Render free instance gets benchmarked - that plan has no
 * shell access.
 */

import { runSmoke } from "../lib/smoke";

const mb = (n: number) => (n / 1024 / 1024).toFixed(1);

runSmoke()
  .then((r) => {
    console.log("");
    console.log(`  output      ${r.render.out}`);
    console.log(
      `  size        ${r.render.width}x${r.render.height}  ${r.render.duration}s  preset=${r.render.preset}`
    );
    console.log(`  encode      ${(r.render.ms / 1000).toFixed(2)}s wall clock`);
    console.log(`  peak RSS    ${r.render.peakRss ? `${mb(r.render.peakRss)} MB` : "n/a (non-Linux)"}`);
    console.log(
      `  container   ${r.render.containerPeak ? `${mb(r.render.containerPeak)} MB peak` : "n/a (no cgroup)"}`
    );
    console.log(`  file        ${mb(r.render.bytes)} MB`);
    console.log(`  host        ${r.platform}, ${r.cpus} cpu`);
    console.log("");
    for (const c of r.checks) console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}  (${c.got})`);
    console.log("");
    if (!r.ok) process.exit(1);
  })
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
