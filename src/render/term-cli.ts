import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { register, out, err } from "../cli";
import { loadConfig } from "../config/store";
import { activeRunDir } from "../browser/runner-script";
import { readProgress } from "../run/progress";
import { buildRunRecord } from "./report";
import { colorMode, renderProgress, renderSummary } from "./terminal";

const flag = (args: string[], name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const width = () => Math.min(process.stdout.columns || 72, 72);

register("summary", "end-of-run totals: summary <runDir> [--plain] [--link <url>]", (args) => {
  const runDir = args[0] && !args[0].startsWith("--") ? resolve(args[0]) : activeRunDir(process.cwd());
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
  writeFileSync(join(runDir, "summary.json"), JSON.stringify({ runId: rec.runId, label: rec.label, size: rec.size, durationMin: rec.durationMin, counts: rec.counts, finishedAt: p?.finishedAt ?? new Date().toISOString(), link: flag(args, "--link"), localPath: local }));
  writeFileSync(join(process.cwd(), ".baseline", "last-run"), runDir);
  out(renderSummary(rec, cfg.theme, { color: args.includes("--plain") ? "none" : colorMode(), width: width(), link: flag(args, "--link"), localPath: local }).join("\n"));
  return 0;
});

register("view", "the active run's progress as text: view [--plain]", (args) => {
  const runDir = activeRunDir(process.cwd(), flag(args, "--run"));
  const p = runDir ? readProgress(runDir) : undefined;
  if (!p) { err("no run in progress"); return 2; }
  out(renderProgress(p, loadConfig(process.cwd()).theme, { color: args.includes("--plain") ? "none" : colorMode(), width: width() }).join("\n"));
  return 0;
});
