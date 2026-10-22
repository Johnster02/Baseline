import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { register, out, err } from "../cli";
import { dataDir } from "../config/secrets";

/** Pinned so every install drives the same browser the guard was tested with. */
export const PLAYWRIGHT_VERSION = "1.64.1";

register("install-browser", "install Playwright and Chromium into the plugin's data folder", () => {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  // Run from the data folder (so a project's .npmrc can't redirect the registry), with no install scripts.
  const a = spawnSync(npm, ["install", "--prefix", dir, "--ignore-scripts", "--no-audit", "--no-fund", `playwright@${PLAYWRIGHT_VERSION}`], { stdio: "inherit", cwd: dir });
  if (a.status !== 0) { err("could not install Playwright with npm"); return 1; }
  const b = spawnSync(process.execPath, [join(dir, "node_modules", "playwright", "cli.js"), "install", "chromium"], {
    stdio: "inherit", cwd: dir, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(dir, "browsers") },
  });
  if (b.status !== 0) { err("could not install Chromium"); return 1; }
  out(`browser ready in ${dir}`);
  return 0;
});
