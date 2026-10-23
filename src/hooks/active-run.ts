// Which run is active, from state agents can't write. `run new` records the run in the data
// folder (core/paths trustedFiles.run); `run finish` leaves a `finished` marker next to it.
// The project's active-run pointer and run.json are only hints: deleting or editing them can't
// switch the guards off. Kept free of heavy imports: the hook bundle uses it.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { dataDir, readActivePointer, runKey } from "../core/paths";

const STALE_MS = 24 * 3600 * 1000;

export type ActiveRun = {
  runDir: string; url: string; live: boolean;
  /** Every unfinished run in this project, newest first (runDir is the newest). */
  runDirs?: string[] | undefined;
  /** Every unfinished run's URL: guards apply to all of them. */
  urls?: string[] | undefined;
};

const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };

type TrustedRecord = { runDir?: unknown; projectDir?: unknown; url?: unknown; live?: unknown; startedAt?: unknown };

/** A trusted run record for this project that is still going, or undefined. */
function readTrusted(dir: string, project: string): (ActiveRun & { started: number }) | undefined {
  if (existsSync(join(dir, "finished"))) return undefined;
  let r: TrustedRecord;
  try { r = JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as TrustedRecord; } catch { return undefined; }
  if (typeof r.url !== "string" || typeof r.runDir !== "string" || typeof r.projectDir !== "string") return undefined;
  const started = Date.parse(typeof r.startedAt === "string" ? r.startedAt : "");
  if (!started || Date.now() - started > STALE_MS) return undefined;
  if (real(r.projectDir) !== project) return undefined;
  return { runDir: r.runDir, url: r.url, live: r.live === true, started };
}

/**
 * The active run from trusted state. When several are going, none is hidden behind a newer one:
 * the result names the newest, lists every run and URL, and is `live` only if all of them are.
 */
export function trustedActiveRun(projectDir: string): ActiveRun | undefined {
  let root: string;
  try { root = join(dataDir(projectDir), "runs"); } catch { return undefined; }
  if (!existsSync(root)) return undefined;
  const project = real(projectDir);
  const found = new Map<string, ActiveRun & { started: number }>();
  // The pointer names the likely run; the scan below still finds every other one.
  const hint = readActivePointer(projectDir);
  if (hint) {
    const t = readTrusted(join(root, runKey(hint)), project);
    if (t) found.set(real(t.runDir), t);
  }
  let names: string[] = [];
  try { names = readdirSync(root); } catch { names = []; }
  for (const n of names) {
    const dir = join(root, n);
    try { if (Date.now() - statSync(dir).mtimeMs > STALE_MS) continue; } catch { continue; }
    const t = readTrusted(dir, project);
    if (t) found.set(real(t.runDir), t);
  }
  const runs = [...found.values()].sort((a, b) => b.started - a.started);
  const newest = runs[0];
  if (!newest) return undefined;
  return { runDir: newest.runDir, url: newest.url, live: runs.every((r) => r.live), runDirs: runs.map((r) => r.runDir), urls: [...new Set(runs.map((r) => r.url))] };
}

/**
 * Runs from before trusted state existed: the project pointer and run.json. Only used when the
 * data folder has no record for this project, so it can only turn guards on, never off.
 */
function legacyActiveRun(projectDir: string): ActiveRun | undefined {
  const hint = readActivePointer(projectDir);
  if (!hint) return undefined;
  let runDir: string, root: string;
  try {
    runDir = realpathSync(hint);
    root = realpathSync(join(projectDir, ".baseline", "sessions"));
  } catch { return undefined; }
  if (!runDir.startsWith(root + sep)) return undefined;
  try {
    const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as { url?: unknown; startedAt?: unknown; live?: unknown };
    const started = Date.parse(typeof run.startedAt === "string" ? run.startedAt : "");
    if (!started || Date.now() - started > STALE_MS || typeof run.url !== "string") return undefined;
    return { runDir, url: run.url, live: run.live === true };
  } catch { return undefined; }
}

/** This project's active run, if one is going (and not abandoned a day ago). */
export function activeRun(projectDir: string): ActiveRun | undefined {
  return trustedActiveRun(projectDir) ?? legacyActiveRun(projectDir);
}
