// The Baseline band: live progress above the prompt while a run is going, then the summary.
// A Claude Code mod: bundled to mod/pane.js, which may only import its own files.
import { frame } from "./frame";
import type { FrameState, RunSummary } from "./frame";
import type { Progress } from "../run/progress";
import type { ThemeName } from "../config/schema";

let state: FrameState = { now: Date.now() };
let theme: ThemeName = "br2049";
let lastKey = "";

async function readJson<T>($: any, path: string): Promise<T | undefined> {
  try {
    if (!(await $.fs.exists(path))) return undefined;
    return JSON.parse(String(await $.fs.read(path)));
  } catch { return undefined; }
}

async function readText($: any, path: string): Promise<string | undefined> {
  try { return (await $.fs.exists(path)) ? String(await $.fs.read(path)).trim() : undefined; } catch { return undefined; }
}

async function refresh($: any) {
  const cwd = String(await $.session.cwd());
  const root = cwd + "/.baseline";
  const cfg = await readJson<{ theme?: ThemeName }>($, root + "/config.json");
  theme = cfg?.theme ?? "br2049";
  const active = await readText($, root + "/active-run");
  const last = await readText($, root + "/last-run");
  // Only follow pointers into this project's own run folders.
  const inside = (p?: string) => (p && p.startsWith(root + "/sessions/") && !p.includes("/../") ? p : undefined);
  const runDir = inside(active) || inside(last);
  const progress = runDir ? await readJson<Progress>($, runDir + "/progress.json") : undefined;
  const summary = !inside(active) && inside(last) ? await readJson<RunSummary>($, last + "/summary.json") : undefined;
  state = { progress, summary, now: Date.now() };
  // Redraw when something changed, and every 2s while a run is live so the clock and bars move.
  const live = progress && !progress.finishedAt;
  const key = JSON.stringify([progress, summary, theme, Math.floor(Date.now() / (live ? 2000 : 10000))]);
  if (key !== lastKey) { lastKey = key; $.ui.invalidate("ui.render"); }
}

export function register(on: any) {
  on("session.start", async ($: any, e: any, next: any) => {
    await refresh($);
    $.clock.every(1000, () => refresh($));
    return next(e);
  });

  on("ui.render", { component: "AbovePrompt" }, async ($: any, e: any, next: any) => {
    const width = Math.max(30, Number(e.props?.bodyColumns) || 72);
    const maxRows = Math.max(1, Number(e.props?.maxRows) || 12);
    const rows = frame({ ...state, now: Date.now() }, theme, Math.min(width, 72), maxRows);
    if (!rows.length) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    const theirs = await next(e);
    const ours = Box({
      flexDirection: "column",
      children: rows.map((segs, i) => Box({
        key: "row-" + i,
        flexDirection: "row",
        children: segs.map((s, j) => (s.color ? Text({ key: "s-" + j, color: s.color, children: [s.text] }) : Text({ key: "s-" + j, children: [s.text] }))),
      })),
    });
    return theirs ? Box({ flexDirection: "column", children: [ours, theirs] }) : ours;
  });
}
