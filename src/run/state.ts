import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { activePointer, projectStateDir, readActivePointer, trustedFiles } from "../core/paths";
import { writeJsonAtomic } from "../core/json";

const pad = (n: number) => String(n).padStart(2, "0");

/** A run that was started and not finished (its folder still exists). */
const isUnfinished = (runDir: string) => existsSync(join(runDir, "run.json")) && !existsSync(trustedFiles.finished(runDir));

export function newRun(projectDir: string, sessionId: string | undefined, meta: { url: string; label: string; permissions?: { runner: string; can: string[]; cannot: string[]; notes?: string[] }[]; live?: boolean }) {
  const d = new Date();
  const base = `r-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const root = projectStateDir(projectDir);
  let runId = base;
  const sessionKey = sessionId && /^[A-Za-z0-9_-]+$/.test(sessionId) ? sessionId : undefined;
  let sessionDir = join(root, "sessions", sessionKey ?? runId);
  for (let i = 2; existsSync(join(sessionDir, "runs", runId)) || (!sessionKey && existsSync(sessionDir)); i++) {
    runId = `${base}-${i}`;
    if (!sessionKey) sessionDir = join(root, "sessions", runId);
  }
  const runDir = join(sessionDir, "runs", runId);
  const previous = readActivePointer(projectDir);
  if (previous && resolve(previous) !== resolve(runDir) && isUnfinished(previous)) {
    process.stderr.write(`warning: another run is still in progress in this project (${previous}). Both can run; its browsers stay open until it finishes.\n`);
  }
  mkdirSync(runDir, { recursive: true });
  const startedAt = d.toISOString();
  const live = meta.live === true;
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ schemaVersion: 1, runId, url: meta.url, label: meta.label, startedAt, permissions: meta.permissions ?? [], live }, null, 2));
  // The guard's own copy of what this run is, and the config it started with, out of agents' reach.
  writeJsonAtomic(trustedFiles.run(runDir), { runDir: resolve(runDir), projectDir: resolve(projectDir), runId, url: meta.url, live, startedAt }, 0o600);
  const cfg = join(root, "config.json");
  if (existsSync(cfg)) copyFileSync(cfg, trustedFiles.config(runDir));
  writeFileSync(activePointer(projectDir), runDir);
  return { runId, runDir, sessionDir };
}

/**
 * Finish a run (the active one by default): mark it finished and clear the pointer if it names it.
 * Returns the finished run folder. Hosts close when they see the marker; the `run finish` command
 * also stops them right away, so run state never depends on browser internals.
 */
export function finishRun(projectDir: string, runDir = readActivePointer(projectDir)): string | undefined {
  const pointer = readActivePointer(projectDir);
  if (!runDir || (pointer && resolve(pointer) === resolve(runDir))) rmSync(activePointer(projectDir), { force: true });
  if (!runDir) return undefined;
  writeFileSync(trustedFiles.finished(runDir), new Date().toISOString(), { mode: 0o600 });
  return runDir;
}
