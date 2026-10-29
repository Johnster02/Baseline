// What each browser command cost, per runner, so a slow run can be explained from evidence
// instead of guessed at. A 14-minute run against a 5-minute target started this (spec 2.1):
// Baseline's own overhead is milliseconds per call, so the time is somewhere else, and this says
// where.
//
// Method names and durations only. A command's arguments are values typed into someone's site and
// targets a page described, so none of them is recorded.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { appendJsonl, readJsonl } from "../core/json";

export type Timing = { at: string; runner: string; method: string; ms: number; ok: boolean };

export const timingsFile = (runDir: string, runner: string) => join(runDir, "logs", `${runner}-timings.jsonl`);

const asTiming = (v: unknown): Timing => {
  const o = v as Partial<Timing> | null;
  if (!o || typeof o.method !== "string" || typeof o.ms !== "number") throw new Error("not a timing");
  return { at: String(o.at ?? ""), runner: String(o.runner ?? ""), method: o.method, ms: o.ms, ok: o.ok !== false };
};

export function recordTiming(runDir: string, t: Timing): void {
  try { appendJsonl(timingsFile(runDir, t.runner), t); } catch { /* never fail a command over a log */ }
}

/** Every runner's timings for a run. Reads the files that are there; a missing one is just empty. */
export function readTimings(runDir: string, runners?: string[]): Timing[] {
  const dir = join(runDir, "logs");
  let names: string[] = [];
  if (runners) names = runners.map((r) => `${r}-timings.jsonl`);
  else {
    try { names = readdirSync(dir).filter((n) => n.endsWith("-timings.jsonl")); } catch { names = []; }
  }
  return names.flatMap((n) => readJsonl(join(dir, n), asTiming)).sort((a, b) => a.at.localeCompare(b.at));
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** A plain summary: where the time went, which commands were slowest, what the failures cost. */
export function summariseTimings(rows: Timing[]): string {
  if (!rows.length) return "This run recorded no timings. Timings are written while a runner's browser is open, so a run that never opened one has none.";
  const total = rows.reduce((n, r) => n + r.ms, 0);
  const failed = rows.filter((r) => !r.ok);
  const byRunner = new Map<string, { n: number; ms: number }>();
  const byMethod = new Map<string, { n: number; ms: number }>();
  for (const r of rows) {
    const a = byRunner.get(r.runner) ?? { n: 0, ms: 0 };
    byRunner.set(r.runner, { n: a.n + 1, ms: a.ms + r.ms });
    const b = byMethod.get(r.method) ?? { n: 0, ms: 0 };
    byMethod.set(r.method, { n: b.n + 1, ms: b.ms + r.ms });
  }
  const lines = [`${rows.length} browser commands, ${secs(total)} total in the browser.`];
  if (failed.length) {
    const cost = failed.reduce((n, r) => n + r.ms, 0);
    lines.push(`${failed.length} timed out or failed, costing ${secs(cost)} (${Math.round((cost / total) * 100)}% of it).`);
  }
  lines.push("", "per runner:");
  for (const [k, v] of [...byRunner].sort((a, b) => b[1].ms - a[1].ms)) lines.push(`  ${k}: ${v.n} commands, ${secs(v.ms)}`);
  lines.push("", "per command:");
  for (const [k, v] of [...byMethod].sort((a, b) => b[1].ms - a[1].ms)) lines.push(`  ${k}: ${v.n}x, ${secs(v.ms)}`);
  lines.push("", "slowest single calls:");
  for (const r of [...rows].sort((a, b) => b.ms - a.ms).slice(0, 10)) {
    lines.push(`  ${secs(r.ms)}  ${r.method}  ${r.runner}${r.ok ? "" : "  (failed)"}`);
  }
  return lines.join("\n");
}
