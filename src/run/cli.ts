import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { register, out, err, io } from "../cli";
import { checkTarget, describePermissions, loadConfig } from "../config/store";
import { activeRunDir, isInside } from "../core/paths";
import { parseFlags, isOneOf } from "../core/args";
import { errMsg, readJsonFile } from "../core/json";
import { z } from "zod";
import { newRun, finishRun } from "./state";
import { stopHosts } from "../browser/host";
import { PHASES, updateProgress, readProgress } from "./progress";
import { sizeRun, SIZES } from "./sizing";
import { commitInfo } from "./commit";
import { readTimings, summariseTimings } from "./timings";
import { mergeSiteMap, parseSiteMap, readSiteMap } from "./sitemap";
import { inputsFileSchema, parse, runFileSchema } from "./schemas";
import type { RunFile } from "./schemas";
import { readCreated } from "../browser/owned";
import { trustedActiveRun } from "../hooks/active-run";

const STATUSES = ["pending", "active", "done", "skipped"] as const;

/** The run a command works on: --run <dir>, else the active run. Same rule for every command. */
export function runFor(runFlag: string | undefined): string | undefined {
  return activeRunDir(process.cwd(), runFlag, io.origCwd);
}

function needRun(runFlag: string | undefined): string | undefined {
  const d = runFor(runFlag);
  if (!d) err("no active run. Start one with: baseline run new --url <url> --label <label>");
  return d;
}

const readRun = (runDir: string): RunFile | undefined => readJsonFile<RunFile | undefined>(join(runDir, "run.json"), parse(runFileSchema), undefined);

register("created", "what the run created, from Baseline's own record (agents can't edit it): created [--run <dir>]", (args) => {
  const runDir = needRun(parseFlags(args, {}).values.run);
  if (!runDir) return 2;
  out(JSON.stringify(readCreated(runDir), null, 2));
  return 0;
});

register("run", "run new --url <u> --label <l> [--session <id>] [--force] | run finish", (args) => {
  const { values: f, positionals } = parseFlags(args, { url: { type: "string" }, label: { type: "string" }, session: { type: "string" }, live: { type: "boolean" }, force: { type: "boolean" } });
  if (positionals[0] === "new") {
    const url = f.url, label = f.label;
    if (!url || !label) { err("usage: baseline run new --url <url> --label <label> [--session <id>]"); return 2; }
    const cfg = loadConfig(process.cwd());
    const live = f.live === true;
    const target = checkTarget(url, cfg, live);
    if (!target.ok) { err(target.reason === "production" ? "refusing: that URL is marked as production. Start the run with --live to test it." : "refusing: not a full http(s) URL"); return 3; }
    // One run at a time by default: a second one is only started on purpose.
    const other = trustedActiveRun(process.cwd());
    if (other && f.force !== true) {
      err(`another run is still in progress in this project (${other.runDir}). Finish it first with \`baseline run finish\`, or start this one anyway with --force.`);
      return 4;
    }
    // Notes travel in their own field: they are the user's words, never part of what a runner may do.
    const permissions = cfg.runners.map((r) => ({ runner: r.key, ...describePermissions(r, cfg.patterns), notes: r.notes }));
    const created = newRun(process.cwd(), f.session, { url, label, permissions, live });
    out(JSON.stringify(created));
    return 0;
  }
  if (positionals[0] === "finish") {
    // Never leave a browser running after the run: close every runner's browser for it now.
    const finished = finishRun(process.cwd());
    if (finished) stopHosts(finished);
    out("run finished");
    return 0;
  }
  err("usage: baseline run new|finish");
  return 2;
});

register("progress", "progress start <pr|quick|full> <agents> | phase <name> <status> [pct] [note] | agent <persona> <doing> | agent-done <persona> | done", (args) => {
  const { values: f, positionals } = parseFlags(args, {});
  const runDir = needRun(f.run);
  if (!runDir) return 2;
  const [sub, a, b, c, ...rest] = positionals;
  const run = readRun(runDir);
  if (!run) { err(`no readable run.json in ${runDir}`); return 2; }
  switch (sub) {
    case "start":
      if (!isOneOf(SIZES, a)) { err(`size must be one of ${SIZES.join(", ")}`); return 2; }
      updateProgress(runDir, { runId: run.runId, label: run.label, size: a, agents: Number(b) || 0, startedAt: new Date().toISOString() });
      return 0;
    case "phase":
      if (!isOneOf(PHASES, a) || !isOneOf(STATUSES, b)) {
        err(`phase must be one of ${PHASES.join(", ")}; status one of ${STATUSES.join(", ")}`);
        return 2;
      }
      updateProgress(runDir, { phase: { name: a, status: b, ...(c !== undefined && c !== "" ? { pct: Math.max(0, Math.min(100, Number(c))) } : {}), ...(rest.length ? { note: rest.join(" ") } : {}) } });
      return 0;
    case "agent":
      if (!a || !b) { err("usage: baseline progress agent <persona> <what it is doing>"); return 2; }
      updateProgress(runDir, { agent: { persona: a, doing: [b, c, ...rest].filter(Boolean).join(" ").slice(0, 80) } });
      return 0;
    case "agent-done":
      if (!a) { err("usage: baseline progress agent-done <persona>"); return 2; }
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
  const { values: f } = parseFlags(args, { personas: { type: "string" }, guide: { type: "boolean" } });
  const runDir = needRun(f.run);
  if (!runDir) return 2;
  // Say what is actually wrong. A single bad field used to come out as "no readable inputs.json",
  // which sent people looking for a missing file that was right there (spec 3.5).
  const file = join(runDir, "inputs.json");
  if (!existsSync(file)) { err(`no inputs.json in ${runDir}. Run: baseline inputs <input...>`); return 2; }
  let inputs: ReturnType<typeof inputsFileSchema.parse>;
  try {
    inputs = inputsFileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch (e) {
    const why = e instanceof z.ZodError
      ? e.issues.slice(0, 3).map((i) => `${i.path.join(".") || "file"}: ${i.message}`).join("; ")
      : errMsg(e);
    err(`${file} can't be read: ${why}`);
    return 2;
  }
  const personas = (f.personas ?? "").split(",").filter(Boolean);
  const paths = inputs.items.flatMap((i) => i.changedFiles ?? []);
  const changed = paths.length;
  const sized = inputs.items.map((i) => ({ kind: i.ref.kind, words: (i.body ?? "").split(/\s+/).filter(Boolean).length, guide: f.guide === true }));
  const info = await commitInfo(process.cwd(), loadConfig(process.cwd()));
  out(JSON.stringify({ ...sizeRun(sized, changed, personas, info.codeRead, paths), changedFiles: changed }));
  return 0;
});

register("timings", "what each browser command cost this run: timings [--run <dir>]", (args) => {
  const runDir = needRun(parseFlags(args, {}).values.run);
  if (!runDir) return 2;
  out(summariseTimings(readTimings(runDir)));
  return 0;
});

register("commit", "which commit the code is at and which the site is running: commit [--out <file>] [--run <dir>]", async (args) => {
  const { values: f } = parseFlags(args, { out: { type: "string" } });
  const runDir = runFor(f.run);
  const runUrl = runDir ? readRun(runDir)?.url : undefined;
  const info = JSON.stringify(await commitInfo(process.cwd(), loadConfig(process.cwd()), undefined, runUrl));
  if (f.out) {
    const target = resolve(io.origCwd, f.out);
    if (!runDir || !isInside(runDir, target) || resolve(target) === resolve(runDir)) { err("--out must be inside the active run folder"); return 2; }
    writeFileSync(target, info);
  }
  out(info);
  return 0;
});

register("sitemap", "sitemap show | merge <file.json>", (args) => {
  if (args[0] === "show") { out(JSON.stringify(readSiteMap(process.cwd()), null, 2)); return 0; }
  if (args[0] === "merge" && args[1]) {
    let partial;
    try { partial = parseSiteMap(JSON.parse(readFileSync(resolve(io.origCwd, args[1]), "utf8"))); }
    catch (e) { err(`sitemap file must be JSON: {routes:[{path,title,personas}], notes:[]} (${e instanceof Error ? e.message : String(e)})`); return 2; }
    const m = mergeSiteMap(process.cwd(), partial);
    out(`site map: ${m.routes.length} routes`);
    return 0;
  }
  err("usage: baseline sitemap show|merge <file>");
  return 2;
});
