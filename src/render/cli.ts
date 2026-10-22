import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { register, out, err, io } from "../cli";
import { loadConfig } from "../config/store";
import { renderSessionReport, sessionRuns } from "./report";

register("report", "write the session's report.html: report <sessionDir>", (args) => {
  if (!args[0]) { err("usage: baseline report <sessionDir>"); return 2; }
  const sessionDir = resolve(io.origCwd, args[0]);
  const runs = sessionRuns(sessionDir);
  if (!runs.length) { err(`no runs in ${sessionDir}`); return 2; }
  const file = join(sessionDir, "report.html");
  writeFileSync(file, renderSessionReport(runs, loadConfig(process.cwd()).theme));
  out(file);
  return 0;
});
