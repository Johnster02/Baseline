// dist/hook.cjs: the guard hooks on their own, so the hook that runs on every tool call loads a
// few KB instead of the whole engine. Usage: node dist/hook.cjs <bash-guard|tool-guard|read-guard|write-guard>
import { readFileSync } from "node:fs";
import { isGuardHook, safeGuardHook } from "./handlers";

const name = process.argv[2] ?? "";
if (!isGuardHook(name)) {
  process.stderr.write(`baseline: unknown hook "${name}"\n`);
  process.exit(1); // a non-blocking error: an unknown hook never stops the tool
}
let stdin = "";
try { stdin = readFileSync(0, "utf8"); } catch { /* no input: allowed */ }
const res = safeGuardHook(name, stdin);
if (res.deny) process.stderr.write(res.deny + "\n");
process.exit(res.code);
