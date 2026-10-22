// What agent scripts get from require("baseline"). Everything is bound to one runner and one run
// by `baseline script`, so a script can't pick another account or skip the guard.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/store";
import { dataDir, sessionPath } from "../config/secrets";
import { openSession } from "./session";
import type { Session } from "./session";

export async function open(): Promise<Session> {
  const runDir = process.env.BASELINE_RUN_DIR;
  const runnerKey = process.env.BASELINE_RUNNER;
  const projectDir = process.env.BASELINE_PROJECT_DIR || process.cwd();
  if (!runDir || !runnerKey) throw new Error("Run this through `baseline script <runner> <file>`.");
  const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as { runId: string; url: string };
  const cfg = loadConfig(projectDir);
  const runner = cfg.runners.find((r) => r.key === runnerKey);
  if (!runner) throw new Error(`No runner "${runnerKey}".`);
  return openSession({ runDir, runId: run.runId, runner, cfg, baseUrl: run.url, storageState: sessionPath(dataDir(), projectDir, runner.key) });
}
