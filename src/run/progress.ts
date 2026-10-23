import { closeSync, openSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { emptyCounts } from "../findings/counts";
import { readJsonFile, writeJsonAtomic } from "../core/json";
import { estimatePct } from "./estimate";
import { parse, progressFileSchema } from "./schemas";

export const PHASES = ["gather", "read-code", "explore", "verdicts", "refute", "clean-up"] as const;
export type Phase = (typeof PHASES)[number];
export type Progress = z.infer<typeof progressFileSchema>;
export type PhaseState = Progress["phases"][number];
export type ProgressPatch = Partial<Pick<Progress, "runId" | "label" | "size" | "agents" | "counts" | "startedAt" | "finishedAt">> & {
  phase?: PhaseState; agent?: { persona: string; doing: string }; agentDone?: string;
};

const file = (runDir: string) => join(runDir, "progress.json");

export function readProgress(runDir: string): Progress | undefined {
  return readJsonFile<Progress | undefined>(file(runDir), parse(progressFileSchema), undefined);
}

const LOCK_WAIT_MS = 2000, LOCK_STALE_MS = 5000;
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Parallel agents report at once: a lock file makes each read-modify-write whole, so none is lost.
 *  A lock left by a killed process goes stale; after waiting LOCK_WAIT_MS we go ahead anyway. */
function withLock<T>(path: string, fn: () => T): T {
  const lock = path + ".lock";
  const until = Date.now() + LOCK_WAIT_MS;
  let fd: number | undefined;
  while (fd === undefined) {
    try { fd = openSync(lock, "wx"); } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { rmSync(lock, { force: true }); continue; } } catch { continue; }
      if (Date.now() > until) break;
      sleep(10);
    }
  }
  try { return fn(); } finally {
    if (fd !== undefined) { closeSync(fd); rmSync(lock, { force: true }); }
  }
}

/** Locked, and atomic (temp file and rename), so the live pane never reads half a file. */
export function updateProgress(runDir: string, patch: ProgressPatch): Progress {
  return withLock(file(runDir), () => {
    const p: Progress = readProgress(runDir) ?? {
      runId: "", label: "", size: "quick", agents: 0, startedAt: new Date().toISOString(),
      phases: PHASES.map((name) => ({ name, status: "pending" as const })), active: [], counts: emptyCounts(),
    };
    const { phase, agent, agentDone, ...rest } = patch;
    Object.assign(p, rest);
    if (phase) p.phases = p.phases.map((x) => (x.name === phase.name ? nextPhase(x, phase, p.size) : x));
    if (agent) p.active = [...p.active.filter((a) => a.persona !== agent.persona), agent];
    if (agentDone) p.active = p.active.filter((a) => a.persona !== agentDone);
    writeJsonAtomic(file(runDir), p);
    return p;
  });
}

/** Keep when an active phase started and never let its bar go backwards: a reported pct counts
 *  only if it is ahead of what the band is already showing. */
function nextPhase(prev: PhaseState, next: PhaseState, size: string): PhaseState {
  if (next.status !== "active") return { name: next.name, status: next.status, ...(next.note ? { note: next.note } : {}) };
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const wasActive = prev.status === "active";
  const out: PhaseState = { name: next.name, status: "active", since: wasActive && prev.since ? prev.since : now };
  const shown = wasActive ? estimatePct(prev, size, nowMs) : 0;
  if (next.pct !== undefined) { out.pct = Math.max(next.pct, shown); out.pctAt = now; }
  else if (wasActive && prev.pct !== undefined) { out.pct = prev.pct; if (prev.pctAt) out.pctAt = prev.pctAt; }
  const note = next.note ?? (wasActive ? prev.note : undefined);
  if (note) out.note = note;
  return out;
}
