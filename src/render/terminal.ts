import type { ThemeName } from "../config/schema";
import type { Progress } from "../run/progress";
import type { RunRecord } from "./report";
import { THEMES } from "./tokens";

export type ColorMode = "truecolor" | "256" | "none";
export type TermOpts = { color: ColorMode; width: number; link?: string; localPath?: string };

export function colorMode(env: NodeJS.ProcessEnv = process.env): ColorMode {
  if (env.NO_COLOR) return "none";
  return /truecolor|24bit/i.test(env.COLORTERM ?? "") ? "truecolor" : "256";
}

const ANSI = /\x1b\[[0-9;]*m/g;
/** Run data comes from agents: drop C0/C1 control characters (ESC included) before painting it. */
const clean = (s: unknown) => String(s ?? "")
  .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, "") // OSC sequences (titles, links)
  .replace(/(\x1b\[|\x9b)[0-9;?]*[ -\/]*[@-~]/g, "") // CSI sequences
  .replace(/[\x00-\x1f\x7f-\x9f]/g, ""); // anything else that controls the terminal
export const visibleLength = (s: string) => [...s.replace(ANSI, "")].length;

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function to256([r, g, b]: [number, number, number]): number {
  const c = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)));
  return 16 + 36 * c(r) + 6 * c(g) + c(b);
}

/** Clip a line to `width` visible characters, keeping colour codes intact. */
function fit(line: string, width: number): string {
  if (visibleLength(line) <= width) return line;
  let out = "", n = 0;
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith("\x1b[")) { out += part; continue; }
    for (const ch of part) {
      if (n >= width - 1) return out + "…" + (out.includes("\x1b[") ? "\x1b[0m" : "");
      out += ch; n++;
    }
  }
  return out;
}

function painter(theme: ThemeName, mode: ColorMode) {
  const t = THEMES[theme];
  return (token: keyof typeof t | string, s: string) => {
    if (mode === "none" || !s) return s;
    const hex = (t as Record<string, string>)[token] ?? t.ink;
    const code = mode === "truecolor" ? `38;2;${rgb(hex!).join(";")}` : `38;5;${to256(rgb(hex!))}`;
    return `\x1b[${code}m${s}\x1b[0m`;
  };
}

const bar = (pct: number, cells: number) => {
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * cells);
  return ["█".repeat(filled), "░".repeat(cells - filled)] as const;
};
const elapsed = (from: string, to = Date.now()) => {
  const s = Math.max(0, Math.round((to - Date.parse(from)) / 1000));
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};
const PHASE_NAME: Record<string, string> = { gather: "gather", "read-code": "read code", explore: "explore", verdicts: "verdicts", refute: "refute", "clean-up": "clean up" };

function header(theme: ThemeName, c: ReturnType<typeof painter>, rest: string) {
  return theme === "br2049" ? `${c("ink", "BASELINE")} ${c("ink3", "// " + rest)}` : `${c("ink", "Baseline")} ${c("ink3", "· " + rest)}`;
}

/** The live view: one row per phase, one line per active agent, elapsed time and counts so far. */
export function renderProgress(p: Progress, theme: ThemeName, o: TermOpts): string[] {
  const c = painter(theme, o.color);
  const br = theme === "br2049";
  const rule = c("accentDim", "─".repeat(Math.max(10, Math.min(o.width, 48))));
  const glyph = { done: br ? "■" : "✓", active: br ? "▶" : "●", pending: br ? "□" : "○", skipped: br ? "·" : "–" };
  const lines = [header(theme, c, `${clean(p.label)} · ${clean(p.size)} run · ${p.agents} agents`), rule];
  for (const ph of p.phases) {
    const name = (br ? PHASE_NAME[ph.name]! : PHASE_NAME[ph.name]![0]!.toUpperCase() + PHASE_NAME[ph.name]!.slice(1)).padEnd(10);
    if (ph.status === "done") lines.push(`${c(br ? "accent" : "match", glyph.done)} ${name}  ${c("accent", "done")}   ${c("ink3", clean(ph.note))}`);
    else if (ph.status === "active") {
      const [on, off] = bar(ph.pct ?? 0, 16);
      lines.push(`${c("dust", glyph.active)} ${c("ink", name)}  ${c("accent", on)}${c("accentDim", off)} ${c("ink", `${ph.pct ?? 0}%`)}${ph.note ? " " + c("ink3", clean(ph.note)) : ""}`);
      for (const a of p.active) lines.push(`    ${c("accent", "›")} ${clean(a.persona).padEnd(10)} ${c("ink3", clean(a.doing))}`);
    } else if (ph.status === "skipped") lines.push(`${c("ink3", glyph.skipped)} ${c("ink3", name)}  ${c("ink3", "skipped")}`);
    else lines.push(`${c("accentDim", glyph.pending)} ${c("ink3", name)}`);
  }
  const k = p.counts;
  lines.push(rule, `${c("ink3", "elapsed")} ${c("ink", elapsed(p.startedAt, p.finishedAt ? Date.parse(p.finishedAt) : Date.now()))}  ${c("ink3", "found so far")} ${c("conflict", String(k.conflicts))} ${c("product", String(k.product))} ${c("unverified", String(k.unverified))} ${c("match", String(k.passed))}`);
  return lines.map((l) => fit(l, o.width));
}

/** The end-of-run summary: totals and pass rate only. Detail lives in the report. */
export function renderSummary(r: RunRecord, theme: ThemeName, o: TermOpts): string[] {
  const c = painter(theme, o.color);
  const br = theme === "br2049";
  const rule = c("accentDim", "─".repeat(Math.max(10, Math.min(o.width, 48))));
  const k = r.counts;
  const [on, off] = bar(k.passRate, 10);
  const dur = `${Math.floor(r.durationMin)}m ${String(Math.round((r.durationMin % 1) * 60)).padStart(2, "0")}s`;
  const row = (label: string, token: string, n: number) => `${c(token, label.padEnd(13))} ${c("ink", String(n))}`;
  const lines = [
    header(theme, c, `${clean(r.label)} · ${clean(r.size)} · ${dur}`), rule,
    `${c("ink", (br ? "PASS RATE" : "Pass rate").padEnd(11))} ${c("accent", on)}${c("accentDim", off)} ${c("ink", `${k.passRate}%`)}`,
    `${c("ink3", "checked".padEnd(11))} ${c("ink", String(k.checked).padEnd(4))} ${c("ink3", "passed")} ${c("match", String(k.passed))}`,
    "",
    row("conflicts", "conflict", k.conflicts),
    row("product", "product", k.product),
    ...(k.unspecced ? [row("unspecced", "unspecced", k.unspecced)] : []),
    row("unverified", "unverified", k.unverified),
    row("skipped", "skipped", k.skipped),
    "",
    `${c("ink3", "result".padEnd(11))} ${c("accent", br ? "COMPLETE" : "Complete")}`,
    rule,
  ];
  if (o.link) lines.push(`${c("ink3", "report")}  ${c("accent", clean(o.link))}`);
  if (o.localPath) lines.push(`${c("ink3", "local ")}  ${c("ink2", clean(o.localPath))}`);
  return lines.map((l) => fit(l, o.width));
}
