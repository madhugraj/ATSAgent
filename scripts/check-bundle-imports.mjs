#!/usr/bin/env node
/**
 * Fails when a built bundle imports a package it cannot find at runtime.
 *
 *   node --experimental-import-meta-resolve scripts/check-bundle-imports.mjs \
 *     .output/server .output/voice-worker .output/parser-worker
 *
 * Run it in the runtime image, where only .output exists: a package the build
 * left external (and did not copy into .output/server/node_modules) would
 * otherwise only fail when a request reaches the module that imports it.
 * Resolves each static import without executing any module.
 *
 * There is deliberately no per-package list: every package in the graph is
 * covered by the same rule. A package nitro inlines (e.g. docx, which lands
 * in .output/server/_libs/docx.mjs with no bare imports left) cannot go
 * missing at runtime by construction — and if it stops resolving at all,
 * `vite build` fails first because app code imports it statically.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Loaded on demand from node_modules at runtime; never shipped in the image
// (vite.config.ts keeps them external on purpose).
const OPTIONAL = [/^playwright(-core)?($|\/)/, /^chromium-bidi($|\/)/];

const builtins = new Set(builtinModules);
const STATIC_IMPORT =
  /^\s*(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "node_modules") yield* files(path);
    } else if (/\.m?js$/.test(name)) yield path;
  }
}

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error("Usage: check-bundle-imports.mjs <dir> [<dir>…]");
  process.exit(2);
}

const missing = [];
let checked = 0;
for (const root of roots) {
  for (const file of files(resolve(root))) {
    const parent = pathToFileURL(file).href;
    for (const m of readFileSync(file, "utf8").matchAll(STATIC_IMPORT)) {
      const spec = m[1] ?? m[2];
      if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("#")) continue;
      if (spec.startsWith("node:") || builtins.has(spec) || builtins.has(spec.split("/")[0]))
        continue;
      if (OPTIONAL.some((re) => re.test(spec))) continue;
      checked++;
      try {
        import.meta.resolve(spec, parent);
      } catch {
        missing.push(`${spec}  (imported by ${file})`);
      }
    }
  }
}

if (missing.length) {
  console.error(`Bundle imports packages that are not in the image:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}
console.log(`Bundle imports OK (${checked} package imports resolved).`);
