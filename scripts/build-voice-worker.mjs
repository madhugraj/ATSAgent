/**
 * Bundle the voice worker (src/server/voice/worker.ts) for the production
 * image: one ESM file at .output/voice-worker/index.mjs that runs on Node 22
 * beside the web server (`node .output/voice-worker/index.mjs`). Runs after
 * `vite build`, which empties .output first.
 */
const out = await Bun.build({
  entrypoints: ["src/server/voice/worker.ts"],
  outdir: ".output/voice-worker",
  naming: "index.mjs",
  target: "node",
  format: "esm",
  sourcemap: "linked",
  minify: false,
  // Virtual modules of the web build, reached only through TanStack Start's HTTP
  // handler (server-function modules the worker shares); never loaded here.
  external: ["#tanstack-*", "tanstack-start-*"],
});
if (!out.success) {
  for (const m of out.logs) console.error(m);
  process.exit(1);
}
console.log(`voice worker: ${out.outputs.map((o) => o.path).join(", ")}`);
