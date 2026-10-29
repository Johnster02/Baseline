import { main, io, register, out, err } from "./cli";
import { findProjectRoot } from "./project";
import { errMsg } from "./core/json";
import { dataDirCandidates } from "./core/paths";
import { activeRun, explainBash } from "./hooks/bash-guard";
import "./commands";

// `baseline guard explain '<command>'`: what the Bash guard decides and which rule decided it, so
// a command the guard refuses by mistake can be diagnosed instead of guessed at.
register("guard", "explain the Bash guard's decision: guard explain [--agent] '<command>'", (args) => {
  const [sub, ...rest] = args;
  const agent = rest[0] === "--agent";
  const command = (agent ? rest.slice(1) : rest).join(" ");
  if (sub !== "explain" || !command) {
    err("usage: baseline guard explain [--agent] '<command>'");
    return 2;
  }
  const projectDir = process.cwd();
  const run = activeRun(projectDir);
  const protectedDirs = dataDirCandidates();
  const res = explainBash(command, { runUrl: run?.url, runUrls: run?.urls, live: run?.live, protectedDirs, agent, projectDir, cwd: io.origCwd });
  const lines = [`command: ${command}`, `decision: ${res.decision}`];
  if (res.decision === "deny") lines.push(`rule: ${res.rule}`, `reason: ${res.deny}`);
  const sites = run ? (run.urls ?? [run.url]).join(", ") : "none";
  lines.push(`as: ${agent ? "subagent" : "main session"}`, `active run: ${sites}`, `data folders: ${protectedDirs.join(", ")}`);
  out(lines.join("\n"));
  return 0;
});

// Agents may call baseline from inside a run folder. Work from the project root, but remember
// where the caller was so relative paths still mean what they meant.
io.origCwd = process.cwd();
const root = findProjectRoot(process.cwd());
if (root && root !== process.cwd()) process.chdir(root);

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(errMsg(e) + "\n");
    process.exit(1);
  },
);
