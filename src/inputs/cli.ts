import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFlags, isOneOf } from "../core/args";
import { activeRunDir } from "../core/paths";
import { errMsg, readJsonFile, writeJsonAtomic } from "../core/json";
import { inputsFileSchema, parse } from "../run/schemas";
import { register, out, err, io } from "../cli";
import { INPUT_KINDS, resolveInputs } from "./resolve";
import type { InputRef } from "./resolve";
import { fetchInput, insecureTrackerWarning } from "./fetch";
import { loadTrackers } from "./trackers";

register("inputs", "fetch what a run checks against: inputs [--run <dir>] [--as jira|linear] <input...> | inputs unread-link <url> [--reason <text>]", async (args) => {
  const { values: f, positionals: raw } = parseFlags(args, { as: { type: "string" }, reason: { type: "string" } });
  // `inputs unread-link <url>`: the gatherer records a link it could not open, instead of
  // hand-editing inputs.json and writing a shape the sizing step can't read (spec 3.5).
  if (raw[0] === "unread-link") {
    const runDir = activeRunDir(process.cwd(), f.run, io.origCwd);
    const url = raw[1];
    if (!runDir || !url) { err("usage: baseline inputs unread-link <url> [--reason <text>] [--run <dir>]"); return 2; }
    let parsedUrl: URL;
    try { parsedUrl = new URL(url); } catch { err(`"${url}" is not a URL`); return 2; }
    if (!/^https?:$/.test(parsedUrl.protocol)) { err(`"${url}" is not an http(s) URL`); return 2; }
    const file = join(runDir, "inputs.json");
    // Edit the raw object, never a parsed copy: writing a parsed copy back would drop every field
    // the schema does not know, and a validation failure would overwrite the whole file with
    // defaults — losing every fetched ticket and PR body (review finding I4).
    let fileJson: Record<string, unknown> = { items: [], unreadLinks: [] };
    if (existsSync(file)) {
      let parsed: unknown;
      try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch { err(`${file} is not valid JSON. Fix it, or run \`baseline inputs\` again.`); return 2; }
      const check = inputsFileSchema.safeParse(parsed);
      if (!check.success) {
        err(`${file} can't be read, so nothing was added to it: ${check.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "file"}: ${i.message}`).join("; ")}`);
        return 2;
      }
      fileJson = parsed as Record<string, unknown>;
    }
    const links = inputsFileSchema.parse(fileJson).unreadLinks;
    if (!links.some((l) => l.url === url)) links.push({ url, ...(f.reason ? { reason: f.reason.slice(0, 300) } : {}) });
    fileJson.unreadLinks = links;
    mkdirSync(runDir, { recursive: true });
    writeJsonAtomic(file, fileJson);
    out(JSON.stringify({ unreadLinks: links.length }));
    return 0;
  }
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
  // Keep any unread links the gatherer already recorded: re-fetching the inputs is not a reason
  // to forget what it could not open (review minor 8).
  const existing = readJsonFile(join(runDir, "inputs.json"), parse(inputsFileSchema), { items: [], unreadLinks: [] });
  writeFileSync(join(runDir, "inputs.json"), JSON.stringify({ items, unreadLinks: existing.unreadLinks }, null, 2));
  out(JSON.stringify({ items: items.map((i) => ({ kind: i.ref.kind, title: i.title, changedFiles: i.changedFiles?.length ?? 0, links: i.links.length, files: i.files?.length ?? 0 })) }));
  return 0;
});
