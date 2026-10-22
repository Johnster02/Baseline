import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { register, out, err, io } from "../cli";
import { describePermissions, loadConfig } from "../config/store";
import { activeRunDir } from "../browser/runner-script";
import { newRun, finishRun } from "./state";
import { PHASES, updateProgress, readProgress } from "./progress";
import type { Phase } from "./progress";
import { sizeRun } from "./sizing";
import { commitInfo } from "./commit";
import { mergeSiteMap, readSiteMap } from "./sitemap";

const flag = (args: string[], name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const STATUSES = ["pending", "active", "done", "skipped"] as const;

function needRun(args: string[]): string | undefined {
  const d = activeRunDir(process.cwd(), flag(args, "--run"));
  if (!d) err("no active run. Start one with: baseline run new --url <url> --label <label>");
  return d;
}

register("run", "run new --url <u> --label <l> [--session <id>] | run finish", (args) => {
  if (args[0] === "new") {
    const url = flag(args, "--url"), label = flag(args, "--label");
    if (!url || !label) { err("usage: baseline run new --url <url> --label <label> [--session <id>]"); return 2; }
    const cfg = loadConfig(process.cwd());
    const permissions = cfg.runners.map((r) => ({ runner: r.key, ...describePermissions(r, cfg.patterns) }));
    const created = newRun(process.cwd(), flag(args, "--session"), { url, label, permissions });
    out(JSON.stringify(created));
    return 0;
  }
  if (args[0] === "finish") { finishRun(process.cwd()); out("run finished"); return 0; }
  err("usage: baseline run new|finish");
  return 2;
});

register("progress", "progress start <quick|full> <agents> | phase <name> <status> [pct] [note] | agent <persona> <doing> | agent-done <persona> | done", (args) => {
  const runDir = needRun(args);
  if (!runDir) return 2;
  const [sub, a, b, c, ...rest] = args.filter((x, i, all) => x !== "--run" && all[i - 1] !== "--run");
  const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
  switch (sub) {
    case "start":
      if (a !== "quick" && a !== "full") { err("size must be quick or full"); return 2; }
      updateProgress(runDir, { runId: run.runId, label: run.label, size: a, agents: Number(b) || 0, startedAt: new Date().toISOString() });
      return 0;
    case "phase":
      if (!PHASES.includes(a as Phase) || !STATUSES.includes(b as (typeof STATUSES)[number])) {
        err(`phase must be one of ${PHASES.join(", ")}; status one of ${STATUSES.join(", ")}`);
        return 2;
      }
      updateProgress(runDir, { phase: { name: a as Phase, status: b as (typeof STATUSES)[number], ...(c !== undefined && c !== "" ? { pct: Math.max(0, Math.min(100, Number(c))) } : {}), ...(rest.length ? { note: rest.join(" ") } : {}) } });
      return 0;
    case "agent":
      if (!a || !b) { err("usage: baseline progress agent <persona> <what it is doing>"); return 2; }
      updateProgress(runDir, { agent: { persona: a, doing: [b, c, ...rest].filter(Boolean).join(" ").slice(0, 80) } });
      return 0;
    case "agent-done":
      updateProgress(runDir, { agentDone: a });
      return 0;
    case "done":
      updateProgress(runDir, { finishedAt: new Date().toISOString(), ...(readProgress(runDir) ? {} : { runId: run.runId, label: run.label }) });
      return 0;
    default:
      err("usage: baseline progress start|phase|agent|agent-done|done");
      return 2;
  }
});

register("size", "size the active run from its inputs.json: size --personas a,b [--guide]", async (args) => {
  const runDir = needRun(args);
  if (!runDir) return 2;
  const inputs = JSON.parse(readFileSync(join(runDir, "inputs.json"), "utf8")) as { items: { ref: { kind: string }; body?: string; changedFiles?: string[] }[] };
  const personas = (flag(args, "--personas") ?? "").split(",").filter(Boolean);
  const changed = inputs.items.reduce((n, i) => n + (i.changedFiles?.length ?? 0), 0);
  const sized = inputs.items.map((i) => ({ kind: i.ref.kind, words: (i.body ?? "").split(/\s+/).filter(Boolean).length, guide: args.includes("--guide") }));
  const info = await commitInfo(process.cwd(), loadConfig(process.cwd()));
  out(JSON.stringify({ ...sizeRun(sized, changed, personas, info.codeRead), changedFiles: changed }));
  return 0;
});

register("commit", "which commit the code is at and which the site is running: commit [--out <file>]", async (args) => {
  const runDir = activeRunDir(process.cwd());
  let runUrl: string | undefined;
  try { runUrl = runDir ? JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).url : undefined; } catch { runUrl = undefined; }
  const info = JSON.stringify(await commitInfo(process.cwd(), loadConfig(process.cwd()), undefined, runUrl));
  const outFile = flag(args, "--out");
  if (outFile) {
    if (!runDir || !resolve(io.origCwd, outFile).startsWith(runDir)) { err("--out must be inside the active run folder"); return 2; }
    writeFileSync(resolve(io.origCwd, outFile), info);
  }
  out(info);
  return 0;
});

register("sitemap", "sitemap show | merge <file.json>", (args) => {
  if (args[0] === "show") { out(JSON.stringify(readSiteMap(process.cwd()), null, 2)); return 0; }
  if (args[0] === "merge" && args[1]) {
    let partial;
    try { partial = JSON.parse(readFileSync(resolve(io.origCwd, args[1]), "utf8")); } catch { err("sitemap file must be JSON: {routes:[{path,title,personas}], notes:[]}"); return 2; }
    const m = mergeSiteMap(process.cwd(), partial);
    out(`site map: ${m.routes.length} routes`);
    return 0;
  }
  err("usage: baseline sitemap show|merge <file>");
  return 2;
});
