import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { register, out, err, io } from "../cli";
import { loadConfig } from "../config/store";
import { renderSessionReport, sessionRuns } from "./report";
import { parseFlags } from "../core/args";

register("report", "write the session's report.html: report <sessionDir> [--open]", (args) => {
  const { values: f, positionals } = parseFlags(args, { open: { type: "boolean" } });
  if (!positionals[0]) { err("usage: baseline report <sessionDir> [--open]"); return 2; }
  const sessionDir = resolve(io.origCwd, positionals[0]);
  const runs = sessionRuns(sessionDir);
  if (!runs.length) { err(`no runs in ${sessionDir}`); return 2; }
  const file = join(sessionDir, "report.html");
  writeFileSync(file, renderSessionReport(runs, loadConfig(process.cwd()).theme));
  if (f.open) io.openFile(file);
  out(file);
  return 0;
});
