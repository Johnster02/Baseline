// Pure drawing logic for the Baseline band. No Node imports: this is bundled into the mod.
import type { ThemeName } from "../config/schema";
import type { Progress } from "../run/progress";
import type { SummaryInput } from "../render/terminal";
import { renderProgress, renderSummary } from "../render/terminal";

export type Segment = { text: string; color?: string };
export type RunSummary = SummaryInput & { runId: string; finishedAt: string; link?: string; localPath?: string };
export type FrameState = { progress?: Progress; summary?: RunSummary; now: number };

const SUMMARY_MS = 10 * 60 * 1000;

/** Truecolor ANSI (what the terminal renderer writes) to coloured text segments the band can draw. */
export function toSegments(line: string): Segment[] {
  const out: Segment[] = [];
  let color: string | undefined;
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    const m = part.match(/^\x1b\[38;2;(\d+);(\d+);(\d+)m$/);
    if (m) { color = "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join(""); continue; }
    if (part.startsWith("\x1b[")) { color = undefined; continue; }
    const text = part.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
    if (text) out.push(color ? { text, color } : { text });
  }
  return out;
}

/** Keep the rows that matter most when the band is short: header, the active phase and its agents, the footer. */
function fitRows(lines: string[], maxRows: number, isKey: (l: string, i: number) => boolean): string[] {
  if (lines.length <= maxRows) return lines;
  const keep = new Set<number>();
  lines.forEach((l, i) => { if (keep.size < maxRows && isKey(l, i)) keep.add(i); });
  for (let i = 0; i < lines.length && keep.size < maxRows; i++) keep.add(i);
  return lines.filter((_, i) => keep.has(i));
}

const plain = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * Progress has to fit the rows the band is given, but every phase row stays: a phase that
 * vanishes reads as a step the run skipped. Drop the divider rules first, then all but the
 * first agent line, then the elapsed line. Only a band too short for the phases themselves
 * falls back to keeping the key rows.
 */
function fitProgress(lines: string[], maxRows: number): string[] {
  if (lines.length <= maxRows) return lines;
  let out = lines.filter((l) => !/^─+$/.test(plain(l).trim()));
  if (out.length > maxRows) {
    let seen = false;
    out = out.filter((l) => !/^\s+›/.test(plain(l)) || (!seen && (seen = true)));
  }
  if (out.length > maxRows) out = out.filter((l) => !/^elapsed\b/.test(plain(l).trim()));
  if (out.length > maxRows) {
    const last = out.length - 1;
    out = fitRows(out, maxRows, (l, i) => i === 0 || i === last || /%|›/.test(plain(l)));
  }
  return out;
}

export function frame(s: FrameState, theme: ThemeName, width: number, maxRows: number): Segment[][] {
  const opts = { color: "truecolor" as const, width, now: s.now };
  let lines: string[] = [];
  const live = s.progress && !s.progress.finishedAt;
  if (live) {
    lines = fitProgress(renderProgress(s.progress!, theme, opts), maxRows);
  } else if (s.summary && s.now - Date.parse(s.summary.finishedAt) <= SUMMARY_MS) {
    lines = renderSummary(s.summary, theme, { ...opts, link: s.summary.link, localPath: s.summary.localPath });
    lines = fitRows(lines.filter((l) => l !== ""), maxRows, (l, i) => i === 0 || /pass rate|result|report/i.test(l.replace(/\x1b\[[0-9;]*m/g, "")));
  } else if (s.progress?.finishedAt && s.now - Date.parse(s.progress.finishedAt) <= SUMMARY_MS) {
    // Finished, summary not written yet: keep showing where it ended.
    lines = fitProgress(renderProgress(s.progress, theme, opts), maxRows);
  }
  return lines.map(toSegments);
}
