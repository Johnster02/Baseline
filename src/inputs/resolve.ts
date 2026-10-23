import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

export const INPUT_KINDS = ["github-pr", "github-issue", "jira", "linear", "file", "folder", "text", "url"] as const;
export type InputKind = (typeof INPUT_KINDS)[number];
export type InputRef = { kind: InputKind; ref: string };
export type Ambiguous = { ambiguous: string; options: InputKind[] };

const KEY = /^[A-Z][A-Z0-9]+-\d+$/;

function one(arg: string, ctx: { trackers: { jira: boolean; linear: boolean }; cwd: string }): InputRef | Ambiguous {
  const a = arg.trim();
  let u: URL | undefined;
  try { u = /^https?:\/\//i.test(a) ? new URL(a) : undefined; } catch { u = undefined; }
  if (u) {
    if (u.hostname === "github.com" && /\/pull\/\d+/.test(u.pathname)) return { kind: "github-pr", ref: a };
    if (u.hostname === "github.com" && /\/issues\/\d+/.test(u.pathname)) return { kind: "github-issue", ref: a };
    const jira = u.hostname.endsWith(".atlassian.net") && u.pathname.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/);
    if (jira && jira[1]) return { kind: "jira", ref: jira[1] };
    const lin = u.hostname === "linear.app" && u.pathname.match(/\/issue\/([A-Z][A-Z0-9]+-\d+)/);
    if (lin && lin[1]) return { kind: "linear", ref: lin[1] };
    return { kind: "url", ref: a };
  }
  if (/^#?\d+$/.test(a)) return { kind: "github-pr", ref: a.replace(/^#/, "") };
  if (KEY.test(a)) {
    const { jira, linear } = ctx.trackers;
    if (jira && !linear) return { kind: "jira", ref: a };
    if (linear && !jira) return { kind: "linear", ref: a };
    return { ambiguous: a, options: ["jira", "linear"] };
  }
  const p = resolve(ctx.cwd, a);
  if (a.length < 1024 && existsSync(p)) return { kind: statSync(p).isDirectory() ? "folder" : "file", ref: p };
  return { kind: "text", ref: a };
}

/** Works out what each argument is. A tracker key that could be Jira or Linear is never guessed. */
export function resolveInputs(args: string[], ctx: { trackers: { jira: boolean; linear: boolean }; cwd: string }): InputRef[] | Ambiguous {
  const out: InputRef[] = [];
  for (const a of args) {
    const r = one(a, ctx);
    if ("ambiguous" in r) return r;
    out.push(r);
  }
  return out;
}
