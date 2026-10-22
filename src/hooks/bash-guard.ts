import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The url of this project's active run, if one is going. */
export function activeRunUrl(projectDir: string): string | undefined {
  const pointer = join(projectDir, ".baseline", "active-run");
  if (!existsSync(pointer)) return undefined;
  const runDir = readFileSync(pointer, "utf8").trim();
  if (!runDir.startsWith(join(projectDir, ".baseline", "sessions"))) return undefined;
  try { return JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).url; } catch { return undefined; }
}

const HTTP_TOOLS = /(^|[\s;&|(`])(curl|wget|http|https|xh|httpie)(\s|$)/;
const WRITE_FLAGS = /(-X\s*|--request[=\s]+|--method[=\s]+)(POST|PUT|PATCH|DELETE)\b|(\s|^)(-d|--data[a-z-]*|-F|--form|--json|--post-data|--post-file|--upload-file|-T)(\s|=|$)|(^|\s)(POST|PUT|PATCH|DELETE)\s+\S/i;
const PLAYWRIGHT = /\bplaywright\b/i;
const VIA_BASELINE = /^\s*baseline\s/;

/**
 * Best-effort second layer while a run is active: an agent should reach the site only through
 * `baseline script`. Denies HTTP writes to the site under test and direct Playwright use.
 */
export function bashGuard(command: string, ctx: { runUrl?: string }): { allow: true } | { deny: string } {
  if (!ctx.runUrl) return { allow: true };
  if (VIA_BASELINE.test(command)) return { allow: true };
  let host = "";
  try { host = new URL(ctx.runUrl).hostname; } catch { host = ""; }
  if (host && command.includes(host) && HTTP_TOOLS.test(command) && WRITE_FLAGS.test(command)) {
    return { deny: `Baseline run in progress: writes to ${host} must go through \`baseline script\`, which carries the safety guard.` };
  }
  if (PLAYWRIGHT.test(command)) {
    return { deny: "Baseline run in progress: drive the browser only with `baseline script <runner> <file>`, never Playwright directly." };
  }
  return { allow: true };
}
