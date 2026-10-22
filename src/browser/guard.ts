import type { Category, ProjectConfig, Runner, PatternCategory } from "../config/schema";
import { isProduction } from "../config/store";

export type GuardRequest = { method: string; url: string; loading: boolean; clickText?: string };
export type GuardContext = { runner: Runner; cfg: ProjectConfig; learned: Set<string> };
export type Decision =
  | { action: "continue"; learn?: string }
  | { action: "abort"; category: Category | "unknown-write"; reason: string; trigger?: string };

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const PATTERN_ORDER: PatternCategory[] = ["email", "auth", "delete", "finance"];

/** `**` matches across slashes, `*` within one segment. Anchored to the whole path. */
export function globMatch(pattern: string, path: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*") { re += ".*"; i++; }
    else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i").test(path);
}

function wordHit(text: string, word: string): boolean {
  const w = word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`, "i").test(text);
}

export const requestKey = (method: string, url: string) => `${method.toUpperCase()} ${new URL(url).pathname}`;

/**
 * The look-only and protected-area rules, in order. Pure so it can be tested without a browser.
 * Protected areas are checked before anything that would allow a write, including writes learned on load.
 */
export function decide(req: GuardRequest, ctx: GuardContext): Decision {
  const { runner, cfg } = ctx;
  const method = req.method.toUpperCase();
  if (isProduction(req.url, cfg) && !runner.allow.includes("live")) {
    return { action: "abort", category: "live", reason: "production site, live testing not allowed for this runner" };
  }
  if (READ_METHODS.has(method)) return { action: "continue" };

  const path = new URL(req.url).pathname;
  for (const cat of PATTERN_ORDER) {
    if (runner.allow.includes(cat)) continue;
    const p = cfg.patterns[cat];
    const url = p.urls.find((g) => globMatch(g, path));
    if (url) return { action: "abort", category: cat, reason: `matches protected ${cat} URL pattern`, trigger: url };
    const word = req.clickText ? p.words.find((w) => wordHit(req.clickText!, w)) : undefined;
    if (word) return { action: "abort", category: cat, reason: `clicked control looks like ${cat}`, trigger: word.toLowerCase() };
  }

  const key = requestKey(method, req.url);
  if (req.loading) return ctx.learned.has(key) ? { action: "continue" } : { action: "continue", learn: key };
  if (ctx.learned.has(key)) return { action: "continue" };
  if (cfg.readPosts.some((g) => globMatch(g, path))) return { action: "continue" };
  if (runner.depth === "look") return { action: "abort", category: "unknown-write", reason: "look-only runner: this would change data" };
  return { action: "continue" };
}

/** Query values that look like credentials are replaced before anything is logged. */
export function redactUrl(raw: string): string {
  const u = new URL(raw);
  const qs = [...u.searchParams.entries()].map(([k, v]) =>
    `${k}=${/token|jwt|session|code|secret|password|key|auth|sig/i.test(k) || v.length > 48 ? "[redacted]" : v}`);
  return u.pathname + (qs.length ? "?" + qs.join("&") : "");
}
