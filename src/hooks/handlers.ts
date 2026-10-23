// The PreToolUse guard hooks, shared by dist/hook.cjs (what hooks.json runs) and `baseline hook`.
import { dataDirCandidates } from "../core/paths";
import { activeRun, bashGuard, readGuard, toolGuard, writeGuard } from "./bash-guard";
import type { GuardResult } from "./bash-guard";

export const GUARD_HOOKS = ["bash-guard", "tool-guard", "read-guard", "write-guard"] as const;
export type GuardHook = (typeof GUARD_HOOKS)[number];
export const isGuardHook = (n: string): n is GuardHook => (GUARD_HOOKS as readonly string[]).includes(n);

type HookInput = { tool_name?: unknown; cwd?: unknown; agent_id?: unknown; tool_input?: Record<string, unknown> };
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Run one guard hook on Claude Code's hook JSON. Exit code 2 blocks the tool, with `deny` shown. */
export function runGuardHook(name: GuardHook, stdin: string, env: NodeJS.ProcessEnv = process.env): { code: number; deny?: string } {
  // Malformed input is allowed through: these are best-effort layers behind the browser guard.
  let input: HookInput;
  try { input = JSON.parse(stdin) as HookInput; } catch { return { code: 0 }; }
  if (!input || typeof input !== "object") return { code: 0 };
  const ti = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  const cwd = str(input.cwd) || process.cwd();
  const projectDir = env.CLAUDE_PROJECT_DIR || cwd;
  const protectedDirs = dataDirCandidates();
  let res: GuardResult;
  if (name === "read-guard") {
    // Read names a file; Glob a pattern under an optional root; Grep a root and a file glob.
    // Grep's `pattern` is a regex, never a path.
    const tool = str(input.tool_name);
    const root = str(ti.path);
    const glob = str(ti.glob) || (tool === "Glob" ? str(ti.pattern) : "");
    const globAt = glob && root && !/^[~/]/.test(glob) ? `${root.replace(/\/+$/, "")}/${glob}` : glob;
    const paths = [str(ti.file_path), root, globAt].filter(Boolean);
    res = readGuard(paths, { cwd, protectedDirs, search: tool === "Grep" || tool === "Glob" });
  } else {
    const run = activeRun(projectDir);
    const urls = run?.urls ?? (run ? [run.url] : []);
    if (name === "bash-guard") res = bashGuard(str(ti.command), { runUrl: run?.url, runUrls: urls, live: run?.live, protectedDirs, agent: !!str(input.agent_id), projectDir, cwd });
    else if (name === "tool-guard") res = toolGuard(str(input.tool_name), { runUrl: run?.url });
    else res = writeGuard(str(ti.file_path) || str(ti.notebook_path), { cwd, projectDir, protectedDirs, runUrl: run?.url });
  }
  return "deny" in res ? { code: 2, deny: res.deny } : { code: 0 };
}

/**
 * A guard that throws must not wave the tool through while a run is going (Claude Code treats any
 * exit but 2 as "allowed"). Outside a run the guards are only the data-folder check, so a crash
 * there lets the tool run rather than breaking every tool call.
 */
export function safeGuardHook(name: GuardHook, stdin: string, env: NodeJS.ProcessEnv = process.env, run: typeof runGuardHook = runGuardHook): { code: number; deny?: string } {
  try { return run(name, stdin, env); } catch {
    let projectDir = env.CLAUDE_PROJECT_DIR || process.cwd();
    try { const i = JSON.parse(stdin) as HookInput; if (!env.CLAUDE_PROJECT_DIR && typeof i?.cwd === "string") projectDir = i.cwd; } catch { /* keep */ }
    let active = true;
    try { active = !!activeRun(projectDir); } catch { active = true; }
    return active ? { code: 2, deny: "Baseline's guard hit an error while a run is active, so this tool call is blocked. Try again, or finish the run." } : { code: 0 };
  }
}
