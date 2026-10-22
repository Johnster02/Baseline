import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Counts } from "../findings/counts";
import { emptyCounts } from "../findings/counts";

export const PHASES = ["gather", "read-code", "explore", "verdicts", "refute", "clean-up"] as const;
export type Phase = (typeof PHASES)[number];
export type PhaseState = { name: Phase; status: "pending" | "active" | "done" | "skipped"; pct?: number; note?: string };
export type Progress = {
  runId: string; label: string; size: "quick" | "full"; agents: number; startedAt: string;
  phases: PhaseState[]; active: { persona: string; doing: string }[]; counts: Counts; finishedAt?: string;
};
export type ProgressPatch = Partial<Pick<Progress, "runId" | "label" | "size" | "agents" | "counts" | "finishedAt">> & {
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
  if (phase) p.phases = p.phases.map((x) => (x.name === phase.name ? { ...phase } : x));
  if (agent) p.active = [...p.active.filter((a) => a.persona !== agent.persona), agent];
  if (agentDone) p.active = p.active.filter((a) => a.persona !== agentDone);
  const tmp = `${file(runDir)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(p, null, 2));
  renameSync(tmp, file(runDir));
  return p;
}
