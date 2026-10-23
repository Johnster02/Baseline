// Bundles the engine into committed files so installing the plugin needs no npm install.
// Playwright is external: setup installs it into ${CLAUDE_PLUGIN_DATA}.
import { build } from "esbuild";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const verify = process.argv.includes("--verify");
const outRoot = verify ? mkdtempSync(join(tmpdir(), "baseline-build-")) : ".";
const targets = [
  { entry: "src/entry.ts", out: "dist/cli.cjs", format: "cjs", minify: true },
  { entry: "src/browser/client.ts", out: "dist/client.cjs", format: "cjs" },
  // The guard hooks run on every tool call: their own small bundle, no zod, no command registry.
  { entry: "src/hooks/entry.ts", out: "dist/hook.cjs", format: "cjs", minify: true },
];
if (existsSync("src/mod/pane.ts")) targets.push({ entry: "src/mod/pane.ts", out: "mod/pane.js", format: "esm" });

// `import css from "./x.css?raw"` bundles the file as a string (vitest does the same natively).
const raw = { name: "raw", setup(b) {
  b.onResolve({ filter: /\?raw$/ }, (a) => ({ path: join(a.resolveDir, a.path.replace(/\?raw$/, "")), namespace: "raw" }));
  b.onLoad({ filter: /.*/, namespace: "raw" }, (a) => ({ contents: readFileSync(a.path, "utf8"), loader: "text" }));
} };

for (const t of targets) {
  await build({ plugins: [raw],
    entryPoints: [t.entry], bundle: true, platform: "node", target: "node20", format: t.format,
    outfile: join(outRoot, t.out), minify: t.minify === true, external: ["playwright", "playwright-core"], legalComments: "none", logLevel: "error",
    banner: t.format === "cjs" ? { js: "/* Baseline engine. Built from src/ by scripts/build.mjs. Do not edit. */" } : undefined,
  });
}

if (verify) {
  const stale = targets.filter((t) => !existsSync(t.out) || readFileSync(t.out, "utf8") !== readFileSync(join(outRoot, t.out), "utf8"));
  if (stale.length) {
    console.error("dist is out of date, run pnpm build: " + stale.map((t) => t.out).join(", "));
    process.exit(1);
  }
  console.log("dist is up to date");
}
