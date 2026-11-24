/**
 * Bundle the voice worker (src/server/voice/worker.ts) for the production
 * image: one ESM file at .output/voice-worker/index.mjs that runs on Node 22
 * beside the web server (`node .output/voice-worker/index.mjs`). Runs after
 * `vite build`, which empties .output first.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUTDIR = ".output/voice-worker";

/**
 * The runtime image copies only .output (no node_modules), and Node links
 * static imports even when the code is never called. The bundle keeps static
 * imports of "#tanstack-*" virtual modules from the (dead) server-function
 * machinery, so the worker failed at start with ERR_PACKAGE_IMPORT_NOT_DEFINED.
 * Emit a package.json whose "imports" map points each such specifier at a stub
 * that throws loudly if it is ever actually called.
 */
function emitHashImportStubs() {
  const text = readFileSync(join(OUTDIR, "index.mjs"), "utf8");
  const names = new Map();
  for (const [, bindings, spec] of text.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*["'](#[^"']+)["']/g,
  )) {
    const list = names.get(spec) ?? new Set();
    for (const b of bindings.split(",")) {
      const n = b
        .trim()
        .split(/\s+as\s+/)[0]
        .trim();
      if (n) list.add(n);
    }
    names.set(spec, list);
  }
  for (const [spec] of text.matchAll(/import\s*["'](#[^"']+)["']/g))
    if (!names.has(spec)) names.set(spec, new Set());
  if (!names.size) return;
  const all = new Set([...names.values()].flatMap((s) => [...s]));
  const stub = [...all]
    .map(
      (n) =>
        `export const ${n} = () => {\n  throw new Error("${n}: server functions are not available in the voice worker");\n};`,
    )
    .join("\n");
  writeFileSync(join(OUTDIR, "tanstack-hash-stubs.mjs"), (stub || "export {};") + "\n");
  writeFileSync(
    join(OUTDIR, "package.json"),
    JSON.stringify({
      type: "module",
      imports: Object.fromEntries([...names.keys()].map((s) => [s, "./tanstack-hash-stubs.mjs"])),
    }) + "\n",
  );
  console.log(`voice worker: stubbed ${names.size} "#" import(s): ${[...names.keys()].join(", ")}`);
}

const out = await Bun.build({
  entrypoints: ["src/server/voice/worker.ts"],
  outdir: OUTDIR,
  naming: "index.mjs",
  target: "node",
  format: "esm",
  sourcemap: "linked",
  minify: false,
  // Virtual modules of the web build, reached only through TanStack Start's HTTP
  // handler (server-function modules the worker shares); never loaded here.
  // playwright runs from node_modules at runtime (the website reader's
  // renderer); bundling it pulls in chromium-bidi paths that cannot resolve.
  external: ["#tanstack-*", "tanstack-start-*", "playwright", "playwright-core", "chromium-bidi"],
});
if (!out.success) {
  for (const m of out.logs) console.error(m);
  process.exit(1);
}
emitHashImportStubs();
console.log(`voice worker: ${out.outputs.map((o) => o.path).join(", ")}`);
