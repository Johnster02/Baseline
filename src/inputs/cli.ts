import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFlags, isOneOf } from "../core/args";
import { activeRunDir } from "../core/paths";
import { errMsg } from "../core/json";
import { register, out, err, io } from "../cli";
import { INPUT_KINDS, resolveInputs } from "./resolve";
import type { InputRef } from "./resolve";
import { fetchInput, insecureTrackerWarning } from "./fetch";
import { loadTrackers } from "./trackers";

register("inputs", "fetch what a run checks against: inputs [--run <dir>] [--as jira|linear] <input...>", async (args) => {
  const { values: f, positionals: raw } = parseFlags(args, { as: { type: "string" } });
  // Same rule as every other command: --run, else the active run.
  const runDir = activeRunDir(process.cwd(), f.run, io.origCwd);
  if (!runDir || !raw.length) { err("usage: baseline inputs [--run <dir>] [--as jira|linear] <input...>"); return 2; }
  if (f.as !== undefined && !isOneOf(INPUT_KINDS, f.as)) { err(`--as must be one of ${INPUT_KINDS.join(", ")}`); return 2; }
  const as = f.as;
  const trackers = loadTrackers();
  const warning = insecureTrackerWarning(trackers);
  if (warning) err(warning);
  // Each argument on its own; --as settles every ambiguous key the same way.
  const refs: InputRef[] = [];
  for (const a of raw) {
    const res = resolveInputs([a], { trackers: { jira: !!trackers.jira, linear: !!trackers.linear }, cwd: io.origCwd });
    if (!("ambiguous" in res)) { refs.push(...res); continue; }
    if (!as || !res.options.includes(as)) { out(JSON.stringify(res)); return 4; }
    refs.push({ kind: as, ref: res.ambiguous });
  }
  const items = [];
  for (const r of refs) {
    try { items.push(await fetchInput(r, { trackers })); }
    catch (e) { err(errMsg(e)); return 1; }
  }
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "inputs.json"), JSON.stringify({ items, unreadLinks: [] }, null, 2));
  out(JSON.stringify({ items: items.map((i) => ({ kind: i.ref.kind, title: i.title, changedFiles: i.changedFiles?.length ?? 0, links: i.links.length, files: i.files?.length ?? 0 })) }));
  return 0;
});
