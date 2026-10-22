import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Counts } from "../findings/counts";
import { emptyCounts } from "../findings/counts";
import { estimatePct } from "./estimate";
import type { RunSize } from "./sizing";

export const PHASES = ["gather", "read-code", "explore", "verdicts", "refute", "clean-up"] as const;
export type Phase = (typeof PHASES)[number];
export type PhaseState = { name: Phase; status: "pending" | "active" | "done" | "skipped"; pct?: number; note?: string; since?: string; pctAt?: string };
export type Progress = {
  runId: string; label: string; size: RunSize; agents: number; startedAt: string;
  phases: PhaseState[]; active: { persona: string; doing: string }[]; counts: Counts; finishedAt?: string;
};
export type ProgressPatch = Partial<Pick<Progress, "runId" | "label" | "size" | "agents" | "counts" | "startedAt" | "finishedAt">> & {
  phase?: PhaseState; agent?: { persona: string; doing: string }; agentDone?: string;
};

const file = (runDir: string) => join(runDir, "progress.json");

export function readProgress(runDir: string): Progress | undefined {
  try { return JSON.parse(readFileSync(file(runDir), "utf8")); } catch { return undefined; }
}

/** Atomic: written to a temp file and renamed, so the live pane never reads half a file. */
export function updateProgress(runDir: string, patch: ProgressPatch): Progress {
  const p: Progress = readProgress(runDir) ?? {
    runId: "", label: "", size: "quick", agents: 0, startedAt: new Date().toISOString(),
    phases: PHASES.map((name) => ({ name, status: "pending" })), active: [], counts: emptyCounts(),
  };
  const { phase, agent, agentDone, ...rest } = patch;
  Object.assign(p, rest);
  if (phase) p.phases = p.phases.map((x) => (x.name === phase.name ? nextPhase(x, phase, p.size) : x));
  if (agent) p.active = [...p.active.filter((a) => a.persona !== agent.persona), agent];
  if (agentDone) p.active = p.active.filter((a) => a.persona !== agentDone);
  const tmp = `${file(runDir)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(p, null, 2));
  renameSync(tmp, file(runDir));
  return p;
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
