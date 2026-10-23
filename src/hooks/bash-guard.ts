import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";

const STALE_MS = 6 * 3600 * 1000;

export function activeRunUrl(projectDir: string): string | undefined {
  return activeRun(projectDir)?.url;
}

/** This project's active run, if one is going (and not abandoned hours ago). */
export function activeRun(projectDir: string): { url: string; live: boolean } | undefined {
  const pointer = join(projectDir, ".baseline", "active-run");
  if (!existsSync(pointer)) return undefined;
  let runDir: string, root: string;
  try {
    runDir = realpathSync(readFileSync(pointer, "utf8").trim());
    root = realpathSync(join(projectDir, ".baseline", "sessions"));
  } catch { return undefined; }
  if (!runDir.startsWith(root + sep)) return undefined;
  try {
    const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as { url?: string; startedAt?: string; live?: boolean };
    const started = Date.parse(run.startedAt ?? "") || statSync(pointer).mtimeMs;
    if (Date.now() - started > STALE_MS || !run.url) return undefined;
    return { url: run.url, live: run.live === true };
  } catch { return undefined; }
}

function hostAliases(runUrl: string): string[] {
  let h = "";
  try { h = new URL(runUrl).hostname.toLowerCase().replace(/^\[|\]$/g, ""); } catch { return []; }
  const local = ["localhost", "127.0.0.1", "::1", "0.0.0.0"];
  return local.includes(h) ? local : [h];
}

const SEGMENT_SPLIT = /;|&&|\|\||\||\n|`|\$\(/;
const SHELL_META = /[;&|`$()<>\n]/;
const MUTATING = /^baseline\s+(config\s+(allow|deny|depth|note|set|secret|add-runner|remove-runner)\b|.*\s--live\b)/;
/** A run started with --live may sign its runners in and check its own target with --live. */
const LIVE_OK = /^baseline\s+(signin|target-check)\s/;
const BEFORE = String.raw`(^|[\s;&|(\x60'"/])`;
const HTTP_TOOL = new RegExp(BEFORE + String.raw`(curl|wget|http|https|xh|httpie)['"]?(\s|$)`, "i");
const SCRIPT_TOOL = new RegExp(BEFORE + String.raw`(python[0-9.]*|node|deno|bun|ruby|php|perl)['"]?(\s|$)`, "i");
const METHOD_FLAG = /(-X\s*|--request[=\s]+|--method[=\s]+)['"]?(POST|PUT|PATCH|DELETE)\b/i;
const LONG_DATA = /(^|\s)--(data[a-z-]*|form|json|post-data|post-file|upload-file)(\s|=|$)/;
const SHORT_DATA = /(^|\s)-[a-zA-Z]*[dFT](\s|=|@|$)/; // case-sensitive: -f and -t are harmless
const HTTPIE_METHOD = /(^|\s)(POST|PUT|PATCH|DELETE)\s+\S/;
const SCRIPT_WRITE = /\b(post|put|patch|delete)\b/i;
const RUNS_PLAYWRIGHT = /((npx|bunx|yarn)\s+|(pnpm|npm)\s+(exec|dlx)\s+)playwright\b|(require|import)\(\s*['"]playwright|from\s+['"]playwright|(^|[\s;&|/])playwright\s+(test|codegen|open|cr|ff|wk|screenshot|pdf|install|show-trace)\b/;

export type GuardResult = { allow: true } | { deny: string };

/**
 * Best-effort second layer while a run is active. Agents should reach the site only through
 * `baseline script`, and nobody changes permissions or production protection mid-run.
 */
export function bashGuard(command: string, ctx: { runUrl?: string; live?: boolean }): GuardResult {
  if (!ctx.runUrl) return { allow: true };
  const segments = command.split(SEGMENT_SPLIT).map((s) => s.trim()).filter(Boolean);
  if (segments.some((s) => MUTATING.test(s) && !(ctx.live && LIVE_OK.test(s)))) {
    return { deny: "Baseline run in progress: permissions, runners and production settings can't change until the run finishes." };
  }
  if (/^\s*baseline\s/.test(command) && !SHELL_META.test(command)) return { allow: true };

  const lower = command.toLowerCase();
  const hitsSite = hostAliases(ctx.runUrl).some((h) => lower.includes(h));
  if (hitsSite && HTTP_TOOL.test(command) && (METHOD_FLAG.test(command) || LONG_DATA.test(command) || SHORT_DATA.test(command) || HTTPIE_METHOD.test(command))) {
    return { deny: "Baseline run in progress: writes to the site under test must go through `baseline script`, which carries the safety guard." };
  }
  if (hitsSite && SCRIPT_TOOL.test(command) && SCRIPT_WRITE.test(command)) {
    return { deny: "Baseline run in progress: don't call the site under test from scripts. Use `baseline script`." };
  }
  if (RUNS_PLAYWRIGHT.test(command)) {
    return { deny: "Baseline run in progress: drive the browser only with `baseline script <runner> <file>`, never Playwright directly." };
  }
  return { allow: true };
}

/** Browser-driving MCP tools skip the guard entirely, so they are off while a run is active. */
export function toolGuard(toolName: string, ctx: { runUrl?: string }): GuardResult {
  if (ctx.runUrl && /^mcp__.*(playwright|chrome|browser|puppeteer)/i.test(toolName)) {
    return { deny: "Baseline run in progress: browser tools are off; agents use `baseline script`." };
  }
  return { allow: true };
}
