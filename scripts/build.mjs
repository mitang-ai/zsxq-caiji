import { build } from "esbuild";
import { build as viteBuild } from "vite";
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
mkdirSync("dist/server", { recursive: true });
await build({
  entryPoints: ["server/index.ts"],
  outfile: "dist/server/index.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  packages: "bundle",
  external: ["playwright", "pdfjs-dist/*", "node:*"],
  banner: {
    js: "import {createRequire as __createRequire} from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
await build({
  entryPoints: ["server/attachment-worker.ts"],
  outfile: "dist/server/attachment-worker.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["pdfjs-dist/*", "node:*"],
  banner: {
    js: "import {createRequire as __createRequire} from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
await build({
  entryPoints: ["server/admin.ts"],
  outfile: "dist/server/admin.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  banner: {
    js: "import {createRequire as __createRequire} from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
await viteBuild({ configFile: "web/vite.config.ts" });
await import("../extension/build.mjs");
writeFileSync(
  "dist/package.json",
  JSON.stringify(
    {
      name: "xingjian-release",
      version: "1.0.0",
      private: true,
      type: "module",
      engines: { node: ">=24.14.0" },
      scripts: { start: "node server/index.mjs" },
      dependencies: {
        playwright: require("playwright/package.json").version,
        "pdfjs-dist": require("pdfjs-dist/package.json").version,
      },
    },
    null,
    2,
  ),
);
console.log(
  "Built server, web and Chrome/Edge extensions locally. No remote writes.",
);
