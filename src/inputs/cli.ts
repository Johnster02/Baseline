import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { register, out, err, io } from "../cli";
import { bashGuard, activeRun, toolGuard } from "../hooks/bash-guard";
import { recordPluginData } from "../config/secrets";
import { resolveInputs } from "./resolve";
import type { InputKind, InputRef } from "./resolve";
import { fetchInput } from "./fetch";
import { loadTrackers, storeTrackersFromEnv } from "./trackers";

register("inputs", "fetch what a run checks against: inputs --run <dir> [--as jira|linear] <input...>", async (args) => {
  const runIdx = args.indexOf("--run");
  const asIdx = args.indexOf("--as");
  if (runIdx < 0 || !args[runIdx + 1]) { err("usage: baseline inputs --run <dir> [--as jira|linear] <input...>"); return 2; }
  const runDir = resolve(io.origCwd, args[runIdx + 1]!);
  const as = asIdx >= 0 ? (args[asIdx + 1] as InputKind) : undefined;
  const skip = new Set([runIdx, runIdx + 1, ...(asIdx >= 0 ? [asIdx, asIdx + 1] : [])]);
  const raw = args.filter((_, i) => !skip.has(i));
  const trackers = loadTrackers();
  const res = resolveInputs(raw, { trackers: { jira: !!trackers.jira, linear: !!trackers.linear }, cwd: io.origCwd });
  let refs: InputRef[];
  if ("ambiguous" in res) {
    if (!as || !res.options.includes(as)) { out(JSON.stringify(res)); return 4; }
    refs = resolveInputs(raw.map((a) => (a === res.ambiguous ? "\u0000" : a)), { trackers: { jira: false, linear: false }, cwd: io.origCwd }) as InputRef[];
    refs = refs.map((r) => (r.ref === "\u0000" ? { kind: as, ref: res.ambiguous } : r));
  } else refs = res;
  const items = [];
  for (const r of refs) {
    try { items.push(await fetchInput(r, { trackers })); }
    catch (e) { err((e as Error).message); return 1; }
  }
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "inputs.json"), JSON.stringify({ items, unreadLinks: [] }, null, 2));
  out(JSON.stringify({ items: items.map((i) => ({ kind: i.ref.kind, title: i.title, changedFiles: i.changedFiles?.length ?? 0, links: i.links.length, files: i.files?.length ?? 0 })) }));
  return 0;
});

register("hook", "internal: hook handlers (store-options, bash-guard)", (args) => {
  if (args[0] === "store-options") {
    if (process.env.CLAUDE_PLUGIN_DATA) recordPluginData(process.env.CLAUDE_PLUGIN_DATA);
    storeTrackersFromEnv(process.env);
    return 0;
  }
  if (args[0] === "bash-guard" || args[0] === "tool-guard") {
    // Malformed input is allowed through: this is a best-effort second layer behind the browser guard.
    let input: { tool_name?: string; tool_input?: { command?: string }; cwd?: string } = {};
    try { input = JSON.parse(io.readStdin()); } catch { return 0; }
    const run = activeRun(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
    const ctx = { runUrl: run?.url, live: run?.live };
    const res = args[0] === "bash-guard" ? bashGuard(input.tool_input?.command ?? "", ctx) : toolGuard(input.tool_name ?? "", ctx);
    if ("deny" in res) { err(res.deny); return 2; }
    return 0;
  }
  err("unknown hook");
  return 2;
});
