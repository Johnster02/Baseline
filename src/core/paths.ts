// Every place Baseline keeps state, in one module.
//   project: <project>/.baseline/            config, the active-run pointer, run folders (agents can write)
//   data:    dataDir()                       secrets, saved sessions, hosts, trusted run state (agents can't)
//   trusted: dataDir()/runs/<runKey>/       per-run state the guard relies on: learned page-load
//                                           requests, the run's URL and config as of `run new`,
//                                           the blocked log the report reads
// Kept free of heavy imports: the hook bundle uses it.
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

const pointerFile = (home: string) => join(home, ".config", "baseline", "plugin-data");

/**
 * Hooks see CLAUDE_PLUGIN_DATA but plain Bash calls don't: the SessionStart hook leaves a pointer.
 * The folder is created first, because readPointer refuses a pointer that names nothing — without
 * this, hook-context calls used the plugin folder while CLI-context calls fell back to
 * ~/.config/baseline, and a login saved by one was invisible to the other.
 */
export function recordPluginData(dir: string, home = homedir()): void {
  mkdirSync(resolve(dir), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, ".config", "baseline"), { recursive: true, mode: 0o700 });
  writeFileSync(pointerFile(home), dir + "\n", { mode: 0o600 });
}

/** Where Claude Code keeps plugin data: ~/.claude/plugins/data, or under CLAUDE_CONFIG_DIR. */
export function pluginDataRoots(home: string): string[] {
  const roots = [join(home, ".claude", "plugins", "data")];
  if (process.env.CLAUDE_CONFIG_DIR) roots.push(join(resolve(process.env.CLAUDE_CONFIG_DIR), "plugins", "data"));
  return roots;
}

const ownedByMe = (p: string) => typeof process.getuid !== "function" || statSync(p).uid === process.getuid();

/**
 * The pointer is trusted only if it is ours and names an existing folder of ours inside Claude
 * Code's plugin data folder, so rewriting it can't move Baseline's data somewhere an agent chose.
 */
function readPointer(home: string): string | undefined {
  try {
    const f = pointerFile(home);
    if (!ownedByMe(f)) return undefined;
    const p = resolve(readFileSync(f, "utf8").trim());
    if (!pluginDataRoots(home).some((r) => p.startsWith(r + sep))) return undefined;
    if (!statSync(p).isDirectory() || !ownedByMe(p)) return undefined;
    return p;
  } catch { return undefined; }
}

/**
 * Durable per-user data dir: env first, then the pointer the plugin's hook wrote, then a default.
 * Never inside the project, so credentials can't end up in a repository.
 */
export function dataDir(projectDir = process.cwd()): string {
  const home = process.env.HOME || homedir();
  const dir = resolve(process.env.BASELINE_DATA || process.env.CLAUDE_PLUGIN_DATA || readPointer(home) || join(home, ".config", "baseline"));
  const proj = resolve(projectDir);
  if (dir === proj || dir.startsWith(proj + sep)) throw new Error(`Refusing a Baseline data folder inside the project (${dir}).`);
  return dir;
}

/** Every folder Baseline's data can live in, for guards that keep agents out of it. */
export function dataDirCandidates(): string[] {
  const home = process.env.HOME || homedir();
  const all = [process.env.BASELINE_DATA, process.env.CLAUDE_PLUGIN_DATA, readPointer(home), join(home, ".config", "baseline")];
  return [...new Set(all.filter((d): d is string => !!d).map((d) => resolve(d)))];
}

export const projectStateDir = (projectDir: string) => join(projectDir, ".baseline");
export const activePointer = (projectDir: string) => join(projectStateDir(projectDir), "active-run");

/** The run folder the active-run pointer names, or undefined. */
export function readActivePointer(projectDir: string): string | undefined {
  try { return readFileSync(activePointer(projectDir), "utf8").trim() || undefined; } catch { return undefined; }
}

/** `--run <dir>` (relative to where the caller ran the command), then BASELINE_RUN_DIR, then the pointer. */
export function activeRunDir(projectDir: string, runFlag?: string, origCwd = process.cwd()): string | undefined {
  if (runFlag) return resolve(origCwd, runFlag);
  if (process.env.BASELINE_RUN_DIR) return process.env.BASELINE_RUN_DIR;
  return readActivePointer(projectDir);
}

/** True when `child` is `parent` or inside it. Plain `startsWith` lets `/r-1-evil` pass for `/r-1`. */
export function isInside(parent: string, child: string): boolean {
  const p = resolve(parent), c = resolve(child);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** A path with symlinks resolved when it exists (/var vs /private/var on macOS), else just resolved. */
export function realPath(p: string): string {
  try { return realpathSync.native(p); } catch { return resolve(p); }
}

/** One key per run folder, however its path is spelled. */
export const runKey = (runDir: string) => createHash("sha256").update(realPath(runDir)).digest("hex").slice(0, 16);

/** The trusted run folder's path, without creating it (for readers such as the hooks). */
export const trustedRunPath = (runDir: string, dataRoot = dataDir()) => join(dataRoot, "runs", runKey(runDir));

/** Per-run state agents and scripts can't write. Created on first use. */
export function trustedRunDir(runDir: string): string {
  const d = trustedRunPath(runDir);
  if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

/** Named files in the trusted run folder. */
export const trustedFiles = {
  /** { url, live, startedAt } as of `run new`: the guard's idea of the site, not run.json's. */
  run: (runDir: string) => join(trustedRunDir(runDir), "run.json"),
  /** The project config as of `run new`: a mid-run config edit doesn't widen what runners may do. */
  config: (runDir: string) => join(trustedRunDir(runDir), "config.json"),
  /** Requests a runner's page loads sent: the look-only allow-list. */
  learned: (runDir: string, runner: string) => join(trustedRunDir(runDir), `learned-${runner}.json`),
  /** Every request the guard blocked (JSONL). The report reads this one. */
  blocked: (runDir: string) => join(trustedRunDir(runDir), "blocked.jsonl"),
  /** Marker written by `run finish`: hosts for this run close when they see it. */
  finished: (runDir: string) => join(trustedRunDir(runDir), "finished"),
};
