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
/**
 * Overrides that would point baseline at another run, data folder or an unguarded browser. Only an
 * assignment at the start of a command counts, so `grep -rn "BASELINE_DATA=" src` reads its own
 * source without being refused.
 */
const ENV_OVERRIDE = /^(BASELINE_(SHARED_BROWSER|RUN_DIR|DATA)|CLAUDE_PLUGIN_DATA)\s*=/i;
/** Wrappers and earlier, harmless assignments stripped while looking for a leading assignment. */
const ENV_PREFIX = new RegExp([
  String.raw`^[({!]\s*`,
  String.raw`^(?:env|export|declare|readonly|local|typeset|command|exec|nohup|time|builtin|sudo|doas|xargs|eval|set)(?:\s+(?:-u\s+\S+|-{1,2}[\w-]+(?:=\S*)?))*(?:\s+|$)`,
  String.raw`^(?:ba|z|da|k)?sh(?:\s+-\w+)*\s+-c\s+`,
  String.raw`^[A-Za-z_]\w*=\S*\s+`,
].join("|"));
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

/** True when a command segment starts by setting one of baseline's own variables. */
export function setsBaselineEnv(command: string): boolean {
  for (const seg of command.split(SEGMENT_SPLIT)) {
    let s = seg.replace(/\$'/g, "'").replace(/['"\\]/g, "").trim();
    for (let i = 0; i < 20 && s; i++) {
      if (ENV_OVERRIDE.test(s)) return true;
      const m = ENV_PREFIX.exec(s);
      if (!m || !m[0]) break;
      s = s.slice(m[0].length).trimStart();
    }
  }
  return false;
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

const WILD = /[*?[{$`]/;
/** Commands that print their arguments: a word of theirs is text, not a path to open. */
const PRINTS_ARGS = /^(echo|printf|print)$/;
/** Commands whose first argument is a regex or a script, not a path. */
const PATTERN_FIRST = /^(grep|egrep|fgrep|zgrep|rg|ag|ack|sed|awk)$/;
/** Flags of those commands that take a pattern or a pattern file, so the next word is their value. */
const TAKES_PATTERN = /^--?(regexp|file|expression)\b|^-[a-zA-Z]*[ef]/;
/** Words that run the next word rather than being the command themselves. */
const WRAPPER = /^(env|command|exec|nohup|time|builtin|sudo|doas|xargs|eval|export|declare|readonly|local|typeset|then|else|do|!)$/;

/**
 * The words of a command that sit where a path can go. A quoted regex (`sed -n '/\.config/p'`), a
 * search pattern (`grep -rn 'BASELINE_DATA=' src`) and text being echoed are not paths, so they
 * are left out — matching them against path patterns is what made the guard refuse its own
 * helpers. Anything after a redirect is a path again, and the exemptions only apply to a command
 * that stands alone: `echo ~/.config/baseline/x | xargs cat` is a read, not a print.
 */
export function pathWords(command: string): string[] {
  const segs = command.split(SEGMENT_SPLIT);
  const solo = segs.filter((s) => s.trim()).length === 1;
  const out: string[] = [];
  for (const seg of segs) {
    const parts = seg.replace(/\$'/g, "'").replace(/['"\\]/g, "").toLowerCase().split(/([\s;&|()<>]+)/);
    let cmd = "";
    let patternSeen = false;
    let valueFlag = false;
    let redirected = false;
    for (let i = 0; i < parts.length; i += 2) {
      const word = parts[i] ?? "";
      if (i > 0 && /[<>]/.test(parts[i - 1] ?? "")) redirected = true;
      if (!word) continue;
      const flag = word.startsWith("-");
      if (!cmd) {
        // Wrappers, leading assignments and their flags come before the program name.
        out.push(word);
        if (!flag && !/^[a-z_][\w.]*=/.test(word) && !WRAPPER.test(word)) cmd = word.slice(word.lastIndexOf("/") + 1);
        continue;
      }
      if (flag && TAKES_PATTERN.test(word)) valueFlag = true;
      if (!redirected && solo && PRINTS_ARGS.test(cmd)) continue;
      if (!redirected && !flag && !patternSeen && !valueFlag && PATTERN_FIRST.test(cmd)) { patternSeen = true; continue; }
      out.push(word);
    }
  }
  return out;
}

/** One glob segment as a regex. `*`, `?`, `[…]` and `{a,b}` stay inside their own segment. */
function segmentRe(seg: string): RegExp {
  let re = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i] as string;
    if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "[" && seg.includes("]", i + 1)) { const end = seg.indexOf("]", i + 1); re += seg.slice(i, end + 1); i = end; }
    else if (c === "{" && seg.includes("}", i + 1)) {
      const end = seg.indexOf("}", i + 1);
      re += "(" + seg.slice(i + 1, end).split(",").map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")";
      i = end;
    } else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** A segment that could stand for any number of folders: `**`, or a variable that may hold a path. */
const anySeg = (s: string) => s === "**" || /[$`]/.test(s);

/**
 * Could a glob's segments line up with a path's, from the same starting point? True both when the
 * glob can name something inside the path and when it can name a folder above it, since a glob
 * there expands into it. A malformed glob fails closed.
 */
function reaches(pat: string[], dir: string[]): boolean {
  try {
    let cur = new Set<number>([0]);
    for (let i = 0; ; i++) {
      if (cur.has(pat.length)) return true; // the glob ran out: it names dir, or a folder above it
      if (i === dir.length) return cur.size > 0; // dir ran out: the glob points inside it
      const next = new Set<number>();
      for (const p of cur) {
        const seg = pat[p] as string;
        if (anySeg(seg)) { next.add(p); next.add(p + 1); }
        else if (segmentRe(seg).test(dir[i] as string)) next.add(p + 1);
      }
      if (!next.size) return false;
      cur = next;
    }
  } catch { return true; }
}

const segsOf = (p: string) => p.split("/").filter((s) => s && s !== "." && s !== "..");

/**
 * A relative glob could reach a data folder if its folder names line up with part of one: with the
 * working folder unknown, `../.claude/plugins/data/*` is as good as the absolute spelling. Only a
 * hidden folder (`.config`, `.claude`) anchors the comparison — lining `data/*` or `plugins/*` up
 * with a data folder's middle would refuse ordinary project paths for no gain.
 */
function relativeGlobReaches(word: string, prot: string[]): boolean {
  if (!word.includes("/") || !WILD.test(word)) return false;
  const pat = segsOf(posix.normalize(word));
  for (let i = 0; i < pat.length; i++) {
    const seg = pat[i] as string;
    if (WILD.test(seg) || !seg.startsWith(".")) continue;
    for (const d of prot) {
      const dir = segsOf(d);
      for (let k = 0; k < dir.length; k++) if (dir[k] === seg && reaches(pat.slice(i), dir.slice(k))) return true;
    }
  }
  return false;
}

/** True when a command could read or write one of Baseline's data folders. */
export function mentionsDataDir(command: string, dirs: string[]): boolean {
  const home = resolve(process.env.HOME || homedir()).toLowerCase();
  const prot = dirs.map((d) => resolve(d).toLowerCase());
  const spellings = dataSpellings(prot, home);
  for (const word of pathWords(command)) {
    // The plugin data folder's variable, wherever it sits in a path word.
    if (/\$\{?claude_plugin_data\b/.test(word)) return true;
    // Any spelling of a data folder inside the word (`@/…`, `file://…`, `-o/…` included), after
    // collapsing // and /./.
    const flat = word.replace(/\/(\.\/)+/g, "/").replace(/\/{2,}/g, "/");
    for (const d of spellings) {
      for (let i = flat.indexOf(d); i >= 0; i = flat.indexOf(d, i + 1)) {
        const next = flat[i + d.length];
        if (next === undefined || !/[a-z0-9._-]/.test(next)) return true;
      }
    }
    // The legacy folder named relatively (`../../.config/baseline/…`).
    if (/\.config\/baseline(?![a-z0-9._-])/.test(flat)) return true;
    const w = word.replace(/^-{1,2}[a-z]+(?=[~/$])/, "");
    const at = w.search(/~\/|~$|\$\{?home\b|\//);
    // Mid-word only after a separator (`@`, `:`): `src/x` is a relative path, not `/x`.
    if (at < 0 || (at > 0 && /[a-z0-9._-]/.test(w[at - 1] ?? ""))) {
      if (relativeGlobReaches(w, prot)) return true;
      continue;
    }
    const raw = w.slice(at);
    // Expand ~ and $HOME, then normalise (//, /./ and ..) the way the shell's path lookup will.
    const t = posix.normalize(raw.replace(/^(~|\$home|\$\{home\})(?=\/|$)/, home));
    if (WILD.test(t)) {
      // A glob or variable: refuse only when it could line up with a data folder, either reaching
      // into one or naming a folder above one.
      if (!t.startsWith("/")) { if (relativeGlobReaches(t, prot)) return true; continue; }
      if (prot.some((d) => reaches(segsOf(t), segsOf(d)))) return true;
      continue;
    }
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

/** A guard decision with the name of the rule that made it, for `baseline guard explain`. */
export type BashExplain = { decision: "allow" } | { decision: "deny"; rule: string; deny: string };

/**
 * Every Bash rule in order, each named. `bashGuard` is this without the names: when the guard
 * refuses something it should not, `baseline guard explain '<command>'` says which rule to look at
 * instead of leaving it to be guessed.
 */
export function explainBash(command: string, ctx: BashContext): BashExplain {
  const no = (rule: string, deny: string): BashExplain => ({ decision: "deny", rule, deny });
  if (ctx.protectedDirs && mentionsDataDir(command, ctx.protectedDirs)) return no("data-folder", DATA_DENY);
  if (ctx.protectedDirs && sweepsHome(command)) return no("home-sweep", DATA_DENY);
  const urls = ctx.runUrls?.length ? ctx.runUrls : ctx.runUrl ? [ctx.runUrl] : [];
  if (!urls.length) return { decision: "allow" };
  const segments = command.split(SEGMENT_SPLIT).map((s) => normalizeSegment(s)).filter(Boolean);
  const frozen = "Baseline run in progress: permissions, runners and production settings can't change until the run finishes.";
  if (ctx.agent) {
    if (segments.some((s) => AGENT_FROZEN.test(s))) return no("agent-frozen", "Baseline run in progress: only the main session starts or finishes runs, signs runners in or changes config. Report back instead.");
    if (ctx.projectDir && writesProjectState(command, ctx.projectDir, ctx.cwd ?? ctx.projectDir)) return no("agent-project-state", "Baseline run in progress: nothing under .baseline/ changes outside the run folders until the run finishes.");
  }
  if (segments.some((s) => (MUTATING.test(s) && !(ctx.live && LIVE_OK.test(s))) || (MUTATING_ANYWHERE.test(s) && !(ctx.live && LIVE_OK.test(s))))) return no("config-frozen", frozen);
  if (setsBaselineEnv(command)) {
    return no("env-override", "Baseline run in progress: baseline's run, data folder and shared browser can't be overridden mid-run.");
  }
  if (/^\s*baseline\s/.test(command) && !SHELL_META.test(command)) return { decision: "allow" };

  const lower = command.toLowerCase();
  const hitsSite = urls.flatMap(hostAliases).some((h) => lower.includes(h));
  if (hitsSite && HTTP_TOOL.test(command) && (METHOD_FLAG.test(command) || LONG_DATA.test(command) || SHORT_DATA.test(command) || HTTPIE_METHOD.test(command))) {
    return no("site-write", "Baseline run in progress: writes to the site under test must go through `baseline script`, which carries the safety guard.");
  }
  if (hitsSite && SCRIPT_TOOL.test(command) && SCRIPT_WRITE.test(command)) {
    return no("site-write-script", "Baseline run in progress: don't call the site under test from scripts. Use `baseline script`.");
  }
  if (RUNS_PLAYWRIGHT.test(command)) {
    return no("playwright", "Baseline run in progress: drive the browser only with `baseline script <runner> <file>`, never Playwright directly.");
  }
  return { decision: "allow" };
}

export function bashGuard(command: string, ctx: BashContext): GuardResult {
  const e = explainBash(command, ctx);
  return e.decision === "allow" ? { allow: true } : { deny: e.deny };
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
