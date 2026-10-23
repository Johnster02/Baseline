import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { register, out, err, io } from "../cli";
import { loadConfig } from "../config/store";
import { activeRunDir } from "../core/paths";
import { parseFlags } from "../core/args";
import { readProgress } from "../run/progress";
import { buildRunRecord } from "./report";
import { colorMode, renderProgress, renderSummary } from "./terminal";

const FLAGS = { plain: { type: "boolean" }, link: { type: "string" } } as const;
const width = () => Math.min(process.stdout.columns || 72, 72);

register("summary", "end-of-run totals: summary <runDir> [--plain] [--link <url>]", (args) => {
  const { values: f, positionals } = parseFlags(args, FLAGS);
  const runDir = positionals[0] ? resolve(io.origCwd, positionals[0]) : activeRunDir(process.cwd(), f.run, io.origCwd);
  if (!runDir) { err("usage: baseline summary <runDir> [--plain] [--link <url>]"); return 2; }
  // Only ever write into this project's own run folders.
  const sessionsRoot = join(process.cwd(), ".baseline", "sessions");
  let real = runDir;
  try { real = realpathSync(runDir); } catch { /* checked below */ }
  let rootReal = sessionsRoot;
  try { rootReal = realpathSync(sessionsRoot); } catch { /* none yet */ }
  if (!real.startsWith(rootReal + sep)) { err(`refusing: ${JSON.stringify(runDir)} is not a run folder of this project`); return 2; }
  mkdirSync(join(process.cwd(), ".baseline"), { recursive: true });
  const cfg = loadConfig(process.cwd());
  const rec = buildRunRecord(runDir);
  const local = join(runDir, "..", "..", "report.html");
  // The band reads this to show the summary after the run.
  const p = readProgress(runDir);
  writeFileSync(join(runDir, "summary.json"), JSON.stringify({ runId: rec.runId, label: rec.label, size: rec.size, durationMin: rec.durationMin, counts: rec.counts, rejectedCount: rec.rejected.length, finishedAt: p?.finishedAt ?? new Date().toISOString(), link: f.link, localPath: local }));
  writeFileSync(join(process.cwd(), ".baseline", "last-run"), runDir);
  out(renderSummary({ ...rec, rejectedCount: rec.rejected.length }, cfg.theme, { color: f.plain ? "none" : colorMode(), width: width(), link: f.link, localPath: local }).join("\n"));
  return 0;
});

register("view", "the active run's progress as text: view [--plain]", (args) => {
  const { values: f } = parseFlags(args, FLAGS);
  const runDir = activeRunDir(process.cwd(), f.run, io.origCwd);
  const p = runDir ? readProgress(runDir) : undefined;
  if (!p) { err("no run in progress"); return 2; }
  out(renderProgress(p, loadConfig(process.cwd()).theme, { color: f.plain ? "none" : colorMode(), width: width() }).join("\n"));
  return 0;
});
