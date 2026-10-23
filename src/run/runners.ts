// <runDir>/runners.json: who signed in, and who got signed out mid-run. The report reads it.
import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "../core/json";

export type RunnerStatus = { key: string; ok: boolean; error?: string };

const parseStatuses = (v: unknown): RunnerStatus[] =>
  Array.isArray(v) ? v.filter((x): x is RunnerStatus => !!x && typeof x.key === "string" && typeof x.ok === "boolean") : [];

/** Merge new statuses in, one entry per runner, the newest winning. */
export function recordRunnerStatus(runDir: string, results: RunnerStatus[]): void {
  const file = join(runDir, "runners.json");
  const prev = readJsonFile(file, parseStatuses, []);
  const fresh = results.map(({ key, ok, error }) => ({ key, ok, ...(error ? { error } : {}) }));
  writeJsonAtomic(file, [...prev.filter((p) => !fresh.some((r) => r.key === p.key)), ...fresh]);
}
