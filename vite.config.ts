import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

import { fileURLToPath } from "node:url";

/** three / three-spritetext / react-force-graph-3d read `window.THREE` while they
 *  are being evaluated. They are only ever rendered in the browser (lazy import in
 *  src/routes/brain.tsx), but the server bundler still pulled them in and merged
 *  them with modules the server imports, which crashed every server-rendered page
 *  with "window is not defined". Resolve them to an inert stub on the server only. */
const BROWSER_ONLY_3D = new Set(["three", "three-spritetext", "react-force-graph-3d"]);
const BROWSER_3D_STUB = fileURLToPath(new URL("./src/stubs/browser-3d-stub.ts", import.meta.url));

export default defineConfig(({ command }) => ({
  css: { transformer: "lightningcss" },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    dedupe: [
      "react",
      "react-dom",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "@tanstack/react-query",
      "@tanstack/query-core",
    ],
  },
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
    ],
  },
  server: { host: "::", port: 8080 },
  plugins: [
    {
      name: "atsiq-stub-browser-3d-on-server",
      enforce: "pre" as const,
      resolveId(
        source: string,
        _importer: string | undefined,
        options: { ssr?: boolean | undefined },
      ) {
        if (options?.ssr && BROWSER_ONLY_3D.has(source)) return BROWSER_3D_STUB;
        return null;
      },
    },
    tailwindcss(),
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tanstackStart({
      // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
      // nitro/vite builds from this
      server: { entry: "server" },
      // *.functions.ts import src/server/* at module scope; mock those node-only
      // modules in the client bundle — the mocks are never invoked client-side
      // because handlers and middleware .server() bodies only run on the server.
      // Auth middleware (src/lib/auth.middleware.ts) stays real so the server-fn
      // compiler can introspect .middleware([...]) arrays without hitting a mock.
      importProtection: {
        // build:"mock" too — the production client bundle keeps server-fn/middleware
        // module-graph references, and without it `vite build` errors exactly like
        // dev did.
        behavior: { dev: "mock", build: "mock" },
        client: { files: ["**/server/**"], specifiers: ["server-only"] },
      },
    }),
    // Self-hosted deploys (Docker/GKE/Cloud Run) run a Node server:
    // `vite build` produces .output/server/index.mjs.
    ...(command === "build" ? [nitro({ preset: "node-server" })] : []),
    viteReact(),
  ],
}));
