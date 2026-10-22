// src/render/tokens.ts
var THEMES = {
  br2049: {
    void: "#0e0d0a",
    deck: "#17160f",
    rule: "#34312a",
    ink: "#eee8d8",
    ink2: "#bdb5a3",
    ink3: "#847c6d",
    accent: "#bdeaa2",
    accentDim: "#5f7a52",
    dust: "#f0a057",
    match: "#a9cf98",
    conflict: "#ff6a5c",
    builtObs: "#f0a057",
    notBuilt: "#b4a5e6",
    guide: "#e6cf6e",
    unspecced: "#96c9da",
    product: "#e889c8",
    unverified: "#7d8c86",
    skipped: "#a59d8d"
  },
  light: {
    void: "#f4f5f4",
    deck: "#ffffff",
    rule: "#e1e4e2",
    ink: "#141b19",
    ink2: "#46524e",
    ink3: "#77817d",
    accent: "#14826c",
    accentDim: "#a6d2c7",
    dust: "#c0660f",
    match: "#1f9a85",
    conflict: "#d2354a",
    builtObs: "#cc6d17",
    notBuilt: "#6a55d4",
    guide: "#9c7a00",
    unspecced: "#1c74b3",
    product: "#b03a8a",
    unverified: "#8a948f",
    skipped: "#6f7874"
  },
  dark: {
    void: "#0b1220",
    deck: "#111a2e",
    rule: "#1f2b45",
    ink: "#e6ebf5",
    ink2: "#a9b4cb",
    ink3: "#6f7c98",
    accent: "#7aa7ff",
    accentDim: "#2a3f6b",
    dust: "#f5b25c",
    match: "#5fcf9f",
    conflict: "#f2777a",
    builtObs: "#f5b25c",
    notBuilt: "#a596ff",
    guide: "#e3cb63",
    unspecced: "#5fb8f0",
    product: "#d58be8",
    unverified: "#7c8aa6",
    skipped: "#94a09c"
  }
};

// src/render/terminal.ts
var ANSI = /\x1b\[[0-9;]*m/g;
var num = (n) => Number.isFinite(Number(n)) ? Number(n) : 0;
var clean = (s) => String(s ?? "").replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, "").replace(/(\x1b\[|\x9b)[0-9;?]*[ -\/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, "");
var visibleLength = (s) => [...s.replace(ANSI, "")].length;
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
}
function to256([r, g, b]) {
  const c = (v) => v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40));
  return 16 + 36 * c(r) + 6 * c(g) + c(b);
}
function fit(line, width) {
  if (visibleLength(line) <= width) return line;
  let out = "", n = 0;
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith("\x1B[")) {
      out += part;
      continue;
    }
    for (const ch of part) {
      if (n >= width - 1) return out + "\u2026" + (out.includes("\x1B[") ? "\x1B[0m" : "");
      out += ch;
      n++;
    }
  }
  return out;
}
function painter(theme2, mode) {
  const t = THEMES[theme2];
  return (token, s) => {
    if (mode === "none" || !s) return s;
    const hex = t[token] ?? t.ink;
    const code = mode === "truecolor" ? `38;2;${rgb(hex).join(";")}` : `38;5;${to256(rgb(hex))}`;
    return `\x1B[${code}m${s}\x1B[0m`;
  };
}
var bar = (pct, cells) => {
  const filled = Math.round(Math.max(0, Math.min(100, pct)) / 100 * cells);
  return ["\u2588".repeat(filled), "\u2591".repeat(cells - filled)];
};
var elapsed = (from, to = Date.now()) => {
  const s = Math.max(0, Math.round((to - Date.parse(from)) / 1e3));
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};
var PHASE_NAME = { gather: "gather", "read-code": "read code", explore: "explore", verdicts: "verdicts", refute: "refute", "clean-up": "clean up" };
function header(theme2, c, rest) {
  return theme2 === "br2049" ? `${c("ink", "BASELINE")} ${c("ink3", "// " + rest)}` : `${c("ink", "Baseline")} ${c("ink3", "\xB7 " + rest)}`;
}
function renderProgress(p, theme2, o) {
  const c = painter(theme2, o.color);
  const br = theme2 === "br2049";
  const rule = c("accentDim", "\u2500".repeat(Math.max(10, Math.min(o.width, 48))));
  const glyph = { done: br ? "\u25A0" : "\u2713", active: br ? "\u25B6" : "\u25CF", pending: br ? "\u25A1" : "\u25CB", skipped: br ? "\xB7" : "\u2013" };
  const lines = [header(theme2, c, `${clean(p.label)} \xB7 ${clean(p.size)} run \xB7 ${num(p.agents)} agents`), rule];
  for (const ph of p.phases) {
    const name = (br ? PHASE_NAME[ph.name] : PHASE_NAME[ph.name][0].toUpperCase() + PHASE_NAME[ph.name].slice(1)).padEnd(10);
    if (ph.status === "done") lines.push(`${c(br ? "accent" : "match", glyph.done)} ${name}  ${c("accent", "done")}   ${c("ink3", clean(ph.note))}`);
    else if (ph.status === "active") {
      const pct = Math.round(num(ph.pct));
      const [on, off] = bar(pct, 16);
      lines.push(`${c("dust", glyph.active)} ${c("ink", name)}  ${c("accent", on)}${c("accentDim", off)} ${c("ink", `${pct}%`)}${ph.note ? " " + c("ink3", clean(ph.note)) : ""}`);
      for (const a of p.active) lines.push(`    ${c("accent", "\u203A")} ${clean(a.persona).padEnd(10)} ${c("ink3", clean(a.doing))}`);
    } else if (ph.status === "skipped") lines.push(`${c("ink3", glyph.skipped)} ${c("ink3", name)}  ${c("ink3", "skipped")}`);
    else lines.push(`${c("accentDim", glyph.pending)} ${c("ink3", name)}`);
  }
  const k = p.counts;
  lines.push(rule, `${c("ink3", "elapsed")} ${c("ink", elapsed(p.startedAt, p.finishedAt ? Date.parse(p.finishedAt) : Date.now()))}  ${c("ink3", "found so far")} ${c("conflict", String(num(k.conflicts)))} ${c("product", String(num(k.product)))} ${c("unverified", String(num(k.unverified)))} ${c("match", String(num(k.passed)))}`);
  return lines.map((l) => fit(l, o.width));
}
function renderSummary(r, theme2, o) {
  const c = painter(theme2, o.color);
  const br = theme2 === "br2049";
  const rule = c("accentDim", "\u2500".repeat(Math.max(10, Math.min(o.width, 48))));
  const k = Object.fromEntries(Object.entries(r.counts).map(([key, v]) => [key, num(v)]));
  const [on, off] = bar(k.passRate, 10);
  const d = num(r.durationMin);
  const dur = `${Math.floor(d)}m ${String(Math.round(d % 1 * 60)).padStart(2, "0")}s`;
  const row = (label, token, n) => `${c(token, label.padEnd(13))} ${c("ink", String(n))}`;
  const lines = [
    header(theme2, c, `${clean(r.label)} \xB7 ${clean(r.size)} \xB7 ${dur}`),
    rule,
    `${c("ink", (br ? "PASS RATE" : "Pass rate").padEnd(11))} ${c("accent", on)}${c("accentDim", off)} ${c("ink", `${k.passRate}%`)}`,
    `${c("ink3", "checked".padEnd(11))} ${c("ink", String(k.checked).padEnd(4))} ${c("ink3", "passed")} ${c("match", String(k.passed))}`,
    "",
    row("conflicts", "conflict", k.conflicts),
    row("product", "product", k.product),
    ...k.unspecced ? [row("unspecced", "unspecced", k.unspecced)] : [],
    row("unverified", "unverified", k.unverified),
    row("skipped", "skipped", k.skipped),
    "",
    `${c("ink3", "result".padEnd(11))} ${c("accent", br ? "COMPLETE" : "Complete")}`,
    rule
  ];
  if (o.link) lines.push(`${c("ink3", "report")}  ${c("accent", clean(o.link))}`);
  if (o.localPath) lines.push(`${c("ink3", "local ")}  ${c("ink2", clean(o.localPath))}`);
  return lines.map((l) => fit(l, o.width));
}

// src/mod/frame.ts
var SUMMARY_MS = 10 * 60 * 1e3;
function toSegments(line) {
  const out = [];
  let color;
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    const m = part.match(/^\x1b\[38;2;(\d+);(\d+);(\d+)m$/);
    if (m) {
      color = "#" + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
      continue;
    }
    if (part.startsWith("\x1B[")) {
      color = void 0;
      continue;
    }
    const text = part.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
    if (text) out.push(color ? { text, color } : { text });
  }
  return out;
}
function fitRows(lines, maxRows, isKey) {
  if (lines.length <= maxRows) return lines;
  const keep = /* @__PURE__ */ new Set();
  lines.forEach((l, i) => {
    if (keep.size < maxRows && isKey(l, i)) keep.add(i);
  });
  for (let i = 0; i < lines.length && keep.size < maxRows; i++) keep.add(i);
  return lines.filter((_, i) => keep.has(i));
}
function frame(s, theme2, width, maxRows) {
  const opts = { color: "truecolor", width };
  let lines = [];
  const live = s.progress && !s.progress.finishedAt;
  if (live) {
    lines = renderProgress(s.progress, theme2, opts);
    const last = lines.length - 1;
    lines = fitRows(lines, maxRows, (l, i) => i === 0 || i === last || /%|›/.test(l.replace(/\x1b\[[0-9;]*m/g, "")));
  } else if (s.summary && s.now - Date.parse(s.summary.finishedAt) <= SUMMARY_MS) {
    lines = renderSummary(s.summary, theme2, { ...opts, link: s.summary.link, localPath: s.summary.localPath });
    lines = fitRows(lines.filter((l) => l !== ""), maxRows, (l, i) => i === 0 || /pass rate|result|report/i.test(l.replace(/\x1b\[[0-9;]*m/g, "")));
  } else if (s.progress?.finishedAt && s.now - Date.parse(s.progress.finishedAt) <= SUMMARY_MS) {
    lines = renderProgress(s.progress, theme2, opts).slice(0, maxRows);
  }
  return lines.map(toSegments);
}

// src/mod/pane.ts
var state = { now: Date.now() };
var theme = "br2049";
var lastKey = "";
async function readJson($, path) {
  try {
    if (!await $.fs.exists(path)) return void 0;
    return JSON.parse(String(await $.fs.read(path)));
  } catch {
    return void 0;
  }
}
async function readText($, path) {
  try {
    return await $.fs.exists(path) ? String(await $.fs.read(path)).trim() : void 0;
  } catch {
    return void 0;
  }
}
async function refresh($) {
  const cwd = String(await $.session.cwd());
  const root = cwd + "/.baseline";
  const cfg = await readJson($, root + "/config.json");
  theme = cfg?.theme ?? "br2049";
  const active = await readText($, root + "/active-run");
  const last = await readText($, root + "/last-run");
  const inside = (p) => p && p.startsWith(root + "/sessions/") && !p.includes("/../") ? p : void 0;
  const runDir = inside(active) || inside(last);
  const progress = runDir ? await readJson($, runDir + "/progress.json") : void 0;
  const summary = !inside(active) && inside(last) ? await readJson($, last + "/summary.json") : void 0;
  state = { progress, summary, now: Date.now() };
  const key = JSON.stringify([progress, summary, theme, Math.floor(Date.now() / 1e4)]);
  if (key !== lastKey) {
    lastKey = key;
    $.ui.invalidate("ui.render");
  }
}
function register(on) {
  on("session.start", async ($, e, next) => {
    await refresh($);
    $.clock.every(1e3, () => refresh($));
    return next(e);
  });
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
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
        children: segs.map((s, j) => s.color ? Text({ key: "s-" + j, color: s.color, children: [s.text] }) : Text({ key: "s-" + j, children: [s.text] }))
      }))
    });
    return theirs ? Box({ flexDirection: "column", children: [ours, theirs] }) : ours;
  });
}
export {
  register
};
