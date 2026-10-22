import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { register, err } from "../cli";
import { loadConfig } from "../config/store";
import { dataDir } from "../config/secrets";

/** The plugin root: dist/cli.cjs lives in <root>/dist. */
function pluginRoot(): string {
  return typeof __dirname !== "undefined" ? resolve(__dirname, "..") : process.cwd();
}

export function activeRunDir(projectDir: string, flag?: string): string | undefined {
  if (flag) return resolve(flag);
  if (process.env.BASELINE_RUN_DIR) return process.env.BASELINE_RUN_DIR;
  const p = join(projectDir, ".baseline", "active-run");
  return existsSync(p) ? readFileSync(p, "utf8").trim() : undefined;
}

/** A tiny node_modules/baseline that points at the bundled API, so scripts can require("baseline"). */
function shimDir(root: string): string {
  const dir = join(dataDir(), "shim", "node_modules", "baseline");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.js"), `module.exports = require(${JSON.stringify(join(root, "dist", "api.cjs"))});\n`);
  return dirname(dir);
}

register("script", "run an agent's browser script as a runner: script <runner> <file.cjs> [--run <dir>]", (args) => {
  const runIdx = args.indexOf("--run");
  const runFlag = runIdx >= 0 ? args[runIdx + 1] : undefined;
  const [runnerKey, file] = args.filter((_, i) => i !== runIdx && i !== runIdx + 1);
  const projectDir = process.cwd();
  const cfg = loadConfig(projectDir);
  if (!runnerKey || !file || !cfg.runners.some((r) => r.key === runnerKey)) {
    err(`usage: baseline script <runner> <file.cjs> [--run <dir>]. Runners: ${cfg.runners.map((r) => r.key).join(", ") || "none"}`);
    return 2;
  }
  const runDir = activeRunDir(projectDir, runFlag);
  if (!runDir || !existsSync(join(runDir, "run.json"))) { err("no active run. Start one with /baseline:run."); return 2; }
  const root = pluginRoot();
  const nodePath = [shimDir(root), join(dataDir(), "node_modules"), join(root, "node_modules"), process.env.NODE_PATH]
    .filter(Boolean).join(delimiter);
  const r = spawnSync(process.execPath, [resolve(file)], {
    cwd: projectDir,
    stdio: "inherit",
    env: { ...process.env, NODE_PATH: nodePath, BASELINE_RUN_DIR: runDir, BASELINE_RUNNER: runnerKey, BASELINE_PROJECT_DIR: projectDir, BASELINE_DATA: dataDir() },
  });
  return r.status ?? 1;
});
