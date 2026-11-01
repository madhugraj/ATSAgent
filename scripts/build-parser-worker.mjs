/**
 * Bundle the sandboxed document parser (src/server/parser/worker.ts) for the
 * production image: one ESM file at .output/parser-worker/index.mjs, run as its
 * own Cloud Run service (`node .output/parser-worker/index.mjs`).
 * docs/guardrails.md P2-1. Runs after `vite build`, which empties .output first.
 */
const out = await Bun.build({
  entrypoints: ["src/server/parser/worker.ts"],
  outdir: ".output/parser-worker",
  naming: "index.mjs",
  target: "node",
  format: "esm",
  sourcemap: "linked",
  minify: false,
  // Everything is bundled (pdf.js included): the runtime image carries only
  // .output, so the worker must be self-contained.
});
if (!out.success) {
  for (const m of out.logs) console.error(m);
  process.exit(1);
}
console.log(`parser worker: ${out.outputs.map((o) => o.path).join(", ")}`);
