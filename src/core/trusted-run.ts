// A run folder Baseline itself started. Agents can write run folders and the project's .baseline/,
// so a run folder is only accepted when the data folder (out of agents' reach) has the record
// `run new` wrote for it. Kept free of heavy imports: the hook bundle uses it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, isInside, realPath, trustedRunPath } from "./paths";

export type TrustedRun = { runDir: string; projectDir: string; runId: string; url: string; live: boolean; startedAt: string; finished: boolean };

/** The record `run new` wrote for this run folder, or undefined. Never creates anything. */
export function readTrustedRun(runDir: string, dataRoot?: string): TrustedRun | undefined {
  let dir: string;
  try { dir = trustedRunPath(runDir, dataRoot ?? dataDir()); } catch { return undefined; }
  let r: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    r = v as Record<string, unknown>;
  } catch { return undefined; }
  if (typeof r.url !== "string" || typeof r.runDir !== "string" || typeof r.projectDir !== "string") return undefined;
  // The record names its own folder: a copied record doesn't vouch for another folder.
  if (realPath(r.runDir) !== realPath(runDir)) return undefined;
  return {
    runDir: realPath(r.runDir), projectDir: realPath(r.projectDir), runId: typeof r.runId === "string" ? r.runId : "",
    url: r.url, live: r.live === true, startedAt: typeof r.startedAt === "string" ? r.startedAt : "",
    finished: existsSync(join(dir, "finished")),
  };
}

export type RunCheck = { ok: true; run: TrustedRun } | { ok: false; reason: string };

/**
 * May a command open a browser, or hand a script sandbox access, for this run folder? Only for a
 * folder inside <project>/.baseline/sessions/ that `run new` recorded for this project, and that
 * has nothing to do with Baseline's data folder.
 */
export function checkRunDir(projectDir: string, runDir: string): RunCheck {
  const start = "Start a new run with /baseline:run.";
  if (!existsSync(runDir)) return { ok: false, reason: `no run folder at ${runDir}. ${start}` };
  const rd = realPath(runDir);
  const sessions = realPath(join(projectDir, ".baseline", "sessions"));
  if (!isInside(sessions, rd) || rd === sessions) return { ok: false, reason: `${runDir} is not a run folder of this project (.baseline/sessions/). ${start}` };
  let data: string;
  try { data = realPath(dataDir(projectDir)); } catch (e) { return { ok: false, reason: e instanceof Error ? e.message : String(e) }; }
  if (isInside(rd, data) || isInside(data, rd)) return { ok: false, reason: "refusing: a run folder can't overlap Baseline's data folder." };
  const run = readTrustedRun(rd);
  if (!run) return { ok: false, reason: `Baseline has no record of starting the run in ${runDir}. ${start}` };
  if (run.projectDir !== realPath(projectDir)) return { ok: false, reason: `that run belongs to another project. ${start}` };
  return { ok: true, run };
}
