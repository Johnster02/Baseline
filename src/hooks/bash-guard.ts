// PreToolUse guards. Best-effort layers behind the browser guard: they keep agents to
// `baseline script` while a run is active, stop permission changes mid-run, and keep every tool
// out of Baseline's data folder (passwords, saved sessions, tracker tokens) at all times.
// Kept free of heavy imports: these run on every tool call from dist/hook.cjs.
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path";
import { isInside, pluginDataRoots } from "../core/paths";

export { activeRun } from "./active-run";
import { activeRun } from "./active-run";

export function activeRunUrl(projectDir: string): string | undefined {
  return activeRun(projectDir)?.url;
}

function hostAliases(runUrl: string): string[] {
  let h = "";
  try { h = new URL(runUrl).hostname.toLowerCase().replace(/^\[|\]$/g, ""); } catch { return []; }
  const local = ["localhost", "127.0.0.1", "::1", "0.0.0.0"];
  return local.includes(h) ? local : [h];
}

const SEGMENT_SPLIT = /;|&&|\|\||\||&|\n|`|\$\(|\)/;
const SHELL_META = /[;&|`$()<>\n]/;
const MUTATING = /^baseline\s+(config\s+(allow|deny|depth|note|set|secret|add-runner|remove-runner)\b|.*\s--live\b)/;
/** The same subcommands however the program was named (an alias, a variable): never mid-run. */
const MUTATING_ANYWHERE = /(^|\s)config\s+(allow|deny|depth|note|set|secret|add-runner|remove-runner)\b|\s--live\b/;
/** What a subagent may never run mid-run: start or finish runs, sign in, change config. */
const AGENT_FROZEN = /^baseline\s+(run\s+(new|finish)\b|signin\b|config\s+(?!(show|describe)\b)\S)/;
/** Shell commands that write files: a redirect, tee, copy/move/remove, in-place edits. */
const WRITES_FILES = /(^|[^<>&0-9])>>?|(^|[\s;&|(])(tee|cp|mv|rm|rmdir|ln|install|truncate|touch|mkdir|dd|chmod|chown|rsync|unlink)(\s|$)|(^|\s)(sed|perl|ruby)\s+(-\S*\s+)*-i/;
/** A run started with --live may sign its runners in and check its own target with --live. */
const LIVE_OK = /^baseline\s+(signin|target-check)\s/;
/** Overrides that would point baseline at another run, data folder or an unguarded browser. */
const ENV_OVERRIDE = /\b(BASELINE_(SHARED_BROWSER|RUN_DIR|DATA)|CLAUDE_PLUGIN_DATA)\s*=/;
const BEFORE = String.raw`(^|[\s;&|(\x60'"/])`;
const HTTP_TOOL = new RegExp(BEFORE + String.raw`(curl|wget|http|https|xh|httpie)['"]?(\s|$)`, "i");
const SCRIPT_TOOL = new RegExp(BEFORE + String.raw`(python[0-9.]*|node|deno|bun|ruby|php|perl)['"]?(\s|$)`, "i");
const METHOD_FLAG = /(-X\s*|--request[=\s]+|--method[=\s]+)['"]?(POST|PUT|PATCH|DELETE)\b/i;
const LONG_DATA = /(^|\s)--(data[a-z-]*|form|json|post-data|post-file|upload-file)(\s|=|$)/;
const SHORT_DATA = /(^|\s)-[a-zA-Z]*[dFT](\s|=|@|$)/; // case-sensitive: -f and -t are harmless
const HTTPIE_METHOD = /(^|\s)(POST|PUT|PATCH|DELETE)\s+\S/;
const SCRIPT_WRITE = /\b(post|put|patch|delete)\b/i;
const RUNS_PLAYWRIGHT = /((npx|bunx|yarn)\s+|(pnpm|npm)\s+(exec|dlx)\s+)playwright\b|(require|import)\(\s*['"]playwright|from\s+['"]playwright|(^|[\s;&|/])playwright\s+(test|codegen|open|cr|ff|wk|screenshot|pdf|install|show-trace)\b/;

/**
 * Words that run the next word as the command: env assignments, `env`, `command`, `exec`,
 * `nohup`, `time`, `sh -c`, `eval`, a subshell paren. Stripped so `X=1 baseline …` reads as
 * `baseline …`.
 */
const PREFIX = new RegExp([
  String.raw`^[({!]\s*`,
  String.raw`^[A-Za-z_]\w*=\S*\s+`,
  String.raw`^(?:env|command|exec|nohup|time|builtin|sudo|doas|xargs|eval)(?:\s+(?:-u\s+\S+|-{1,2}[\w-]+(?:=\S*)?))*(?:\s+|$)`,
  String.raw`^(?:ba|z|da|k)?sh(?:\s+-\w+)*\s+-c\s+`,
].join("|"));

/** One command segment, with quoting, wrappers and the path to the program taken off. */
export function normalizeSegment(seg: string): string {
  let s = seg.replace(/\$'/g, "'").replace(/['"\\]/g, "").trim();
  for (let i = 0; i < 20; i++) {
    const m = PREFIX.exec(s);
    if (!m || !m[0]) break;
    s = s.slice(m[0].length).trimStart();
  }
  // ./bin/baseline, $CLAUDE_PLUGIN_ROOT/bin/baseline, or the bundle itself: all are `baseline`.
  return s
    .replace(/^\S*\/baseline(?=\s|$)/, "baseline")
    .replace(/^node(?:\s+-\S+)*\s+\S*\/cli\.cjs(?=\s|$)/, "baseline");
}

export type GuardResult = { allow: true } | { deny: string };

const DATA_DENY = "Baseline's data folder holds passwords, saved sessions and tracker tokens: tools can't read or change it. Use `baseline` commands instead.";

/** Spellings of the data folders a command might use: absolute, ~/…, $HOME/…, ${HOME}/…. */
function dataSpellings(dirs: string[], home: string): string[] {
  const out = new Set<string>();
  for (const d of dirs) {
    out.add(d);
    if (isInside(home, d) && d !== home) {
      const rest = d.slice(home.length);
      for (const h of ["~", "$home", "${home}"]) out.add(h + rest);
    }
  }
  return [...out];
}

/** True when a command names one of Baseline's data folders. */
export function mentionsDataDir(command: string, dirs: string[]): boolean {
  const home = resolve(process.env.HOME || homedir()).toLowerCase();
  const prot = dirs.map((d) => resolve(d).toLowerCase());
  const lower = command.replace(/['"\\]/g, "").toLowerCase();
  if (/\$\{?claude_plugin_data\b/.test(lower)) return true;
  // Any spelling of a data folder anywhere in the command (`@/…`, `file://…`, `-o/…` included),
  // after collapsing // and /./.
  const flat = lower.replace(/\/(\.\/)+/g, "/").replace(/\/{2,}/g, "/");
  for (const d of dataSpellings(prot, home)) {
    for (let i = flat.indexOf(d); i >= 0; i = flat.indexOf(d, i + 1)) {
      const next = flat[i + d.length];
      if (next === undefined || !/[a-z0-9._-]/.test(next)) return true;
    }
  }
  if (/\.config\/baseline(?![a-z0-9._-])/.test(flat)) return true;
  for (const word of lower.split(/[\s;&|()<>=]+/)) {
    // A path can start partway into a word (`@/x`, `file:///x`, `-o~/x`): check from there.
    // Any word, relative or not: a glob or variable in a path through .config or .claude could
    // expand to a data folder.
    if (/[*?[{$`]/.test(word) && /(^|\/)\.(config|claude)(\/|$)/.test(posix.normalize(word))) return true;
    const w = word.replace(/^-{1,2}[a-z]+(?=[~/$])/, "");
    const at = w.search(/~\/|~$|\$\{?home\b|\//);
    // Mid-word only after a separator (`@`, `:`): `src/x` is a relative path, not `/x`.
    if (at < 0 || (at > 0 && /[a-z0-9._-]/.test(w[at - 1] ?? ""))) continue;
    const raw = w.slice(at);
    // Expand ~ and $HOME, then normalise (//, /./ and ..) the way the shell's path lookup will.
    const expanded = raw.replace(/^(~|\$home|\$\{home\})(?=\/|$)/, home);
    const t = posix.normalize(expanded);
    const wild = t.search(/[*?[{$`]/);
    if (wild >= 0) {
      // A glob or variable could expand anywhere under its fixed prefix: refuse when that prefix
      // holds a data folder, or the path goes through .config or .claude.
      const fixed = t.slice(0, wild);
      const root = fixed.slice(0, fixed.lastIndexOf("/") + 1) || "/";
      if (/(^|\/)\.(config|claude)(\/|$)/.test(t)) return true;
      if (root.startsWith("/") && prot.some((d) => isInside(posix.normalize(root), d) || isInside(d, posix.normalize(root)))) return true;
      continue;
    }
    if (/(^|\/)\.config\/baseline(\/|$)/.test(t)) return true;
    if (t.startsWith("/") && prot.some((d) => isInside(d, t))) return true;
  }
  return false;
}

/**
 * Commands that sweep a home or config folder (and so the data folder inside it): recursive
 * listings, searches, archives and copies rooted at ~, $HOME, the home path, ~/.config or ~/.claude,
 * `cd` into those, and globs that spell the data folder's name partly (`.config/basel*`).
 * Defence in depth: a determined command can still get around a text check.
 */
export function sweepsHome(command: string): boolean {
  const lower = command.replace(/['"\\]/g, "").toLowerCase();
  if (/\.config\/basel[^/\s]*[*?[{]/.test(lower) || /\.config\/[*?[{]/.test(lower) || /\.claude\/(plugins\/)?[*?[{]/.test(lower)) return true;
  const home = resolve(process.env.HOME || homedir()).toLowerCase();
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const roots = [String.raw`~`, String.raw`\$home`, String.raw`\$\{home\}`, esc(home)].map((r) => `${r}(?:/(?:\\.config|\\.claude(?:/plugins)?))?/?`);
  const root = `(?:${roots.join("|")})(?=$|[\\s;&|)])`;
  const sweep = new RegExp(String.raw`(^|[\s;&|(])(find|grep\s+(?:-\S+\s+)*-\S*[rR]\S*|rg|ag|ls\s+(?:-\S+\s+)*-\S*[rR]\S*|tar|zip|7z|rsync|cp\s+(?:-\S+\s+)*-\S*[rRa]\S*|du|tree)\s+(?:-\S+\s+)*(?:\S+\s+)*?` + root);
  // `cd ~/.config && cat baseline/...`: moving into one of those folders and then doing more.
  const cdThen = new RegExp(String.raw`(^|[\s;&|(])(cd|pushd)\s+` + root + String.raw`\s*(&&|;|\|\|?|\n)\s*\S`);
  return sweep.test(lower) || cdThen.test(lower);
}

/** Paths a command names under the project's .baseline/ but outside its run folders, when it writes files. */
function writesProjectState(command: string, projectDir: string, cwd: string): boolean {
  if (!WRITES_FILES.test(command)) return false;
  const state = resolve(projectDir, ".baseline");
  const tokens = command.replace(/['"]/g, " ").split(/[\s;&|()<>]+/).filter((t) => t.includes(".baseline"));
  return tokens.some((t) => {
    const abs = absPath(t.replace(/^\d*>+/, ""), cwd);
    return isInside(state, abs) && !isInside(resolve(state, "sessions"), abs);
  });
}

/**
 * The Bash guard. `protectedDirs` (Baseline's data folders) are off limits at all times; the rest
 * applies while a run is active (`runUrl` set).
 */
export type BashContext = {
  runUrl?: string | undefined;
  /** Every active run's URL (several runs can be going at once). Defaults to [runUrl]. */
  runUrls?: string[] | undefined;
  live?: boolean | undefined;
  protectedDirs?: string[] | undefined;
  /** The call comes from a subagent (the hook input had an agent_id). */
  agent?: boolean | undefined;
  /** For subagent writes into .baseline/: the project, and where the command runs. */
  projectDir?: string | undefined;
  cwd?: string | undefined;
};

export function bashGuard(command: string, ctx: BashContext): GuardResult {
  if (ctx.protectedDirs && (mentionsDataDir(command, ctx.protectedDirs) || sweepsHome(command))) return { deny: DATA_DENY };
  const urls = ctx.runUrls?.length ? ctx.runUrls : ctx.runUrl ? [ctx.runUrl] : [];
  if (!urls.length) return { allow: true };
  const segments = command.split(SEGMENT_SPLIT).map((s) => normalizeSegment(s)).filter(Boolean);
  const frozen = "Baseline run in progress: permissions, runners and production settings can't change until the run finishes.";
  if (ctx.agent) {
    if (segments.some((s) => AGENT_FROZEN.test(s))) return { deny: "Baseline run in progress: only the main session starts or finishes runs, signs runners in or changes config. Report back instead." };
    if (ctx.projectDir && writesProjectState(command, ctx.projectDir, ctx.cwd ?? ctx.projectDir)) return { deny: "Baseline run in progress: nothing under .baseline/ changes outside the run folders until the run finishes." };
  }
  if (segments.some((s) => (MUTATING.test(s) && !(ctx.live && LIVE_OK.test(s))) || (MUTATING_ANYWHERE.test(s) && !(ctx.live && LIVE_OK.test(s))))) return { deny: frozen };
  if (ENV_OVERRIDE.test(command)) {
    return { deny: "Baseline run in progress: baseline's run, data folder and shared browser can't be overridden mid-run." };
  }
  if (/^\s*baseline\s/.test(command) && !SHELL_META.test(command)) return { allow: true };

  const lower = command.toLowerCase();
  const hitsSite = urls.flatMap(hostAliases).some((h) => lower.includes(h));
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
export function toolGuard(toolName: string, ctx: { runUrl?: string | undefined }): GuardResult {
  if (ctx.runUrl && /^mcp__.*(playwright|chrome|browser|puppeteer)/i.test(toolName)) {
    return { deny: "Baseline run in progress: browser tools are off; agents use `baseline script`." };
  }
  return { allow: true };
}

/** Symlinks resolved through the closest existing parent, so a link into the data folder is caught. */
function realExisting(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try { return join(realpathSync.native(cur), ...rest); } catch { /* walk up */ }
    const up = dirname(cur);
    if (up === cur) return resolve(p);
    rest.unshift(basename(cur));
    cur = up;
  }
}

/** `~/x` and relative paths, made absolute. */
function absPath(p: string, cwd: string): string {
  if (p === "~" || p.startsWith("~/")) return resolve(process.env.HOME || homedir(), p.slice(2));
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/** Read, Grep and Glob: never inside the data folders. */
/**
 * Read, Grep and Glob: never inside the data folders. A search rooted above one (your home folder,
 * ~/.config) would reach into it too, so a search root that contains a data folder is refused as
 * well. `paths` are file paths and search roots, never a Grep regex.
 */
export function readGuard(paths: string[], ctx: { cwd: string; protectedDirs: string[]; search?: boolean | undefined }): GuardResult {
  for (const p of paths) {
    // A glob's fixed prefix is what decides where it looks.
    const glob = /[*?[{]/.test(p);
    let fixed = p.split(/[*?[{]/)[0] ?? "";
    if (glob) fixed = fixed.slice(0, fixed.lastIndexOf("/") + 1) || (fixed.startsWith("/") ? "/" : ".");
    if (!fixed) continue;
    const abs = realExisting(absPath(fixed, ctx.cwd));
    const dirs = ctx.protectedDirs.flatMap((d) => [resolve(d), realExisting(d)]);
    if (dirs.some((d) => isInside(d, abs))) return { deny: DATA_DENY };
    if ((ctx.search || glob) && dirs.some((d) => isInside(abs, d))) {
      return { deny: "That search would reach into Baseline's data folder (passwords, saved sessions). Search a narrower folder." };
    }
  }
  return { allow: true };
}

/**
 * Write, Edit, MultiEdit, NotebookEdit: never inside the data folders; while a run is active,
 * nothing under the project's .baseline/ except the run folders (config, the active-run pointer).
 */
export function writeGuard(path: string, ctx: { cwd: string; projectDir: string; protectedDirs: string[]; runUrl?: string | undefined }): GuardResult {
  if (!path) return { allow: true };
  const abs = absPath(path, ctx.cwd);
  if ([...ctx.protectedDirs, ...pluginDataRoots(process.env.HOME || homedir())].some((d) => isInside(d, abs))) return { deny: DATA_DENY };
  if (!ctx.runUrl) return { allow: true };
  const state = resolve(ctx.projectDir, ".baseline");
  if (isInside(state, abs) && !isInside(resolve(state, "sessions"), abs)) {
    return { deny: "Baseline run in progress: its config and run pointer can't change until the run finishes. Write only inside the run folder." };
  }
  return { allow: true };
}
