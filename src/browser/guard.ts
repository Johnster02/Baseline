import type { Category, ProjectConfig, Runner, PatternCategory } from "../config/schema";
import { isProduction } from "../config/store";

import { createHash } from "node:crypto";

export type GuardRequest = { method: string; url: string; loading: boolean; clickText?: string; body?: string; document?: boolean };
export type GuardContext = { runner: Runner; cfg: ProjectConfig; learned: Set<string>; baseHost?: string; createdPaths?: string[] };
export type Decision =
  | { action: "continue"; learn?: string }
  | { action: "abort"; category: Category | "unknown-write"; reason: string; trigger?: string };

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const PATTERN_ORDER: PatternCategory[] = ["email", "auth", "delete", "finance"];

/** Decode, drop ;params and a trailing slash, so /a/%64elete/ and /a/delete;x=1 match like /a/delete. */
export function normalizePath(path: string): string {
  let p = path;
  try { p = decodeURIComponent(p); } catch { /* keep raw */ }
  p = p.split("/").map((seg) => seg.split(";")[0]).join("/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p || "/";
}

/** `**` matches across slashes, `*` within one segment. Anchored to the whole (normalised) path. */
export function globMatch(pattern: string, rawPath: string): boolean {
  const path = normalizePath(rawPath);
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

/** A learned request is this exact call: host, method, path and body. A different body to the same
 *  path (a GraphQL mutation after a query) is a different request. */
/** A GraphQL mutation, in a JSON body or as a raw query string. */
export function looksLikeMutation(body?: string): boolean {
  if (!body) return false;
  let q = body;
  try {
    const j = JSON.parse(body);
    const ops = Array.isArray(j) ? j : [j];
    q = ops.map((o) => (o && typeof o.query === "string" ? o.query : "")).join("\n");
  } catch { /* not JSON */ }
  return /(^|[\s{}])mutation\b/.test(q.replace(/#[^\n]*/g, ""));
}

export const requestKey = (method: string, url: string, body = "") => {
  const u = new URL(url);
  const h = body ? " #" + createHash("sha256").update(body).digest("hex").slice(0, 16) : "";
  return `${method.toUpperCase()} ${u.host}${u.pathname}${h}`;
};

/** Categories whose URL patterns also apply to page navigations (GETs with side effects, like /logout). */
const GET_CATEGORIES: PatternCategory[] = ["auth", "delete"];

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
  const u = new URL(req.url);
  const path = u.pathname;
  if (READ_METHODS.has(method)) {
    if (req.document) {
      for (const cat of GET_CATEGORIES) {
        if (runner.allow.includes(cat)) continue;
        const g = cfg.patterns[cat].urls.find((x) => globMatch(x, path));
        if (g) return { action: "abort", category: cat, reason: `page link matches protected ${cat} URL pattern`, trigger: g };
      }
    }
    return { action: "continue" };
  }

  for (const cat of PATTERN_ORDER) {
    if (runner.allow.includes(cat)) continue;
    const p = cfg.patterns[cat];
    const url = p.urls.find((g) => globMatch(g, path));
    if (url) return { action: "abort", category: cat, reason: `matches protected ${cat} URL pattern`, trigger: url };
    const word = req.clickText ? p.words.find((w) => wordHit(req.clickText!, w)) : undefined;
    if (word) return { action: "abort", category: cat, reason: `clicked control looks like ${cat}`, trigger: word.toLowerCase() };
  }

  if (method === "DELETE" && !runner.allow.includes("delete")) {
    const own = (ctx.createdPaths ?? []).some((c) => normalizePath(c) === normalizePath(path));
    if (!own) return { action: "abort", category: "delete", reason: "DELETE request, and this runner may not delete" };
  }

  const key = requestKey(method, req.url, req.body);
  const sameHost = !ctx.baseHost || u.host === ctx.baseHost;
  if (req.loading && sameHost) return ctx.learned.has(key) ? { action: "continue" } : { action: "continue", learn: key };
  // Other hosts during a page load (analytics, the auth provider's session refresh): allowed, never learned.
  if (req.loading) return { action: "continue" };
  if (ctx.learned.has(key)) return { action: "continue" };
  // A read-only POST path is allowed only for reads: a GraphQL mutation to the same path is a write.
  if (cfg.readPosts.some((g) => globMatch(g, path)) && !looksLikeMutation(req.body)) return { action: "continue" };
  if (runner.depth === "look") return { action: "abort", category: "unknown-write", reason: "look-only runner: this would change data" };
  return { action: "continue" };
}

/** Message text as words: JSON decoded (escapes resolved), camelCase, snake_case and kebab-case split. */
export function normaliseMessage(message: string): string {
  return splitWords(decodeMessage(message).text);
}

function splitWords(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.:/=&?]+/g, " ").replace(/\s+/g, " ").trim();
}

/** JSON and percent-decoded text, and whether escapes were still left (checked before any splitting). */
export function decodeMessage(message: string): { text: string; undecodable: boolean } {
  let text = message;
  try {
    const parts: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "string") parts.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { parts.push(k); walk(x); }
    };
    walk(JSON.parse(message));
    text = parts.join(" ");
  } catch { /* not JSON: use as is */ }
  // Percent-escapes decoded leniently (bad bytes become U+FFFD, the rest still decode), repeated
  // so double encoding can't hide a word.
  const dec = new TextDecoder("utf-8", { fatal: false });
  for (let i = 0; i < 20 && /%[0-9a-f]{2}/i.test(text); i++) {
    const next = text.replace(/(%[0-9a-f]{2})+/gi, (m) => dec.decode(Uint8Array.from(m.match(/%([0-9a-f]{2})/gi)!.map((h) => parseInt(h.slice(1), 16)))));
    if (next === text) break;
    text = next;
  }
  return { text, undecodable: /%[0-9a-f]{2}/i.test(text) };
}

/**
 * WebSockets: production needs live; look-only may send only while a page loads; deeper runners
 * may not send a message that names a protected action they aren't allowed.
 */
export function wsDecide(req: { url: string; loading: boolean; message?: string }, ctx: { runner: Runner; cfg: ProjectConfig }): Decision {
  const { runner, cfg } = ctx;
  const httpish = req.url.replace(/^ws/i, "http");
  if (isProduction(httpish, cfg) && !runner.allow.includes("live")) {
    return { action: "abort", category: "live", reason: "production site, live testing not allowed for this runner" };
  }
  const path = new URL(httpish).pathname;
  for (const cat of PATTERN_ORDER) {
    if (runner.allow.includes(cat)) continue;
    const g = cfg.patterns[cat].urls.find((x) => globMatch(x, path));
    if (g) return { action: "abort", category: cat, reason: `WebSocket URL matches protected ${cat} pattern`, trigger: g };
  }
  if (req.message === undefined) return { action: "continue" };
  if (runner.depth === "look") {
    return req.loading ? { action: "continue" } : { action: "abort", category: "unknown-write", reason: "look-only runner: WebSocket message after the page loaded" };
  }
  for (const cat of PATTERN_ORDER) {
    if (runner.allow.includes(cat)) continue;
    // Words and message go through the same normalisation; the raw message is checked too.
    const decoded = decodeMessage(req.message);
    const text = splitWords(decoded.text);
    // Escapes left after decoding mean we can't read it: fail closed.
    if (decoded.undecodable) return { action: "abort", category: "unknown-write", reason: "WebSocket message could not be decoded to check it" };
    const word = cfg.patterns[cat].words.find((w) => wordHit(text, normaliseMessage(w)) || wordHit(req.message!, w));
    if (word) return { action: "abort", category: cat, reason: `WebSocket message looks like ${cat}`, trigger: word.toLowerCase() };
  }
  return { action: "continue" };
}

/** Query values that look like credentials are replaced before anything is logged. */
export function redactUrl(raw: string): string {
  const u = new URL(raw);
  const looksSecret = (seg: string) => seg.length >= 20 && /[a-z]/i.test(seg) && /\d/.test(seg) && /^[A-Za-z0-9_.~-]+$/.test(seg);
  const pathname = u.pathname.split("/").map((seg) => (looksSecret(seg) ? "[redacted]" : seg)).join("/");
  const qs = [...u.searchParams.entries()].map(([k, v]) =>
    `${k}=${/token|jwt|session|code|secret|password|key|auth|sig/i.test(k) || v.length > 48 ? "[redacted]" : v}`);
  return pathname + (qs.length ? "?" + qs.join("&") : "");
}
