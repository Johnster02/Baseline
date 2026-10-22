import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { ThemeName } from "../config/schema";
import type { InputRef } from "../inputs/resolve";
import type { BlockedEntry } from "../browser/session";
import type { CommitInfo } from "../run/commit";
import type { Counts } from "../findings/counts";
import { countRun } from "../findings/counts";
import { filterFindings } from "../findings/filter";
import { findingSchema, isConflict, severityRank } from "../findings/schema";
import type { Finding } from "../findings/schema";
import { VERDICT_LABEL, VERDICT_VAR } from "./tokens";
import { APP_JS } from "../report/app";
import CSS from "../report/style.css?raw";

export type RunRecord = {
  runId: string; label: string; inputs: InputRef[]; url: string; size: "quick" | "full"; agents: number;
  startedAt: string; durationMin: number; commit: CommitInfo;
  permissions: { runner: string; can: string[]; cannot: string[] }[];
  findings: Finding[]; other: Finding[]; otherHidden: number; skipped: BlockedEntry[]; counts: Counts;
  unreadLinks: string[];
  /** Each runner's sign-in status this run. */
  runners: { key: string; ok: boolean; error?: string }[];
  /** Things the run created and could not remove. */
  leftBehind: { label: string; note: string }[];
  /** Screenshot path (relative to the run folder) to base64 JPEG/PNG. */
  shots: Record<string, string>;
};

const SHOT_BUDGET = 13 * 1024 * 1024;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const group = (v: string) => (isConflict(v as Finding["verdict"]) ? "conflict" : v);
const needsAttention = (f: Finding) => f.verdict !== "match" && f.verdict !== "skipped";
const ALLOW_HINT: Record<string, string> = {
  email: "allow email", auth: "allow auth and accounts", delete: "allow deleting", finance: "allow payments and finance",
  live: "allow live testing", "unknown-write": "give this runner create depth, or list the path as a read-only POST",
};

function readJson<T>(p: string, fallback: T): T {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; }
}

/** Everything the report needs about one run, read from its folder. Findings are filtered here. */
export function buildRunRecord(runDir: string): RunRecord {
  const run = readJson<{ runId: string; url: string; label: string; startedAt: string; permissions?: RunRecord["permissions"] }>(join(runDir, "run.json"), { runId: "", url: "", label: "", startedAt: "" });
  const inputs = readJson<{ items: { ref: InputRef }[]; unreadLinks?: string[] }>(join(runDir, "inputs.json"), { items: [] });
  const progress = readJson<{ size?: "quick" | "full"; agents?: number; startedAt?: string; finishedAt?: string }>(join(runDir, "progress.json"), {});
  const commit = readJson<CommitInfo>(join(runDir, "commit.json"), { codeRead: false, mismatch: false });
  const raw = readJson<unknown[]>(join(runDir, "findings.json"), []);
  const parsed = raw.map((r) => findingSchema.safeParse(r)).filter((r) => r.success).map((r) => r.data!);
  const rel = (p: string) => (isAbsolute(p) ? relative(runDir, p) : p);
  for (const f of parsed) if (f.observed) f.observed.shots = f.observed.shots.map(rel);
  const res = filterFindings(parsed, { otherCap: 5, codeRead: commit.codeRead });
  const order = (a: Finding, b: Finding) => Number(needsAttention(b)) - Number(needsAttention(a)) || severityRank(a.severity) - severityRank(b.severity);
  const findings = [...res.kept].sort(order);
  const skipped = readJson<BlockedEntry[]>(join(runDir, "blocked.json"), []);
  const shots: Record<string, string> = {};
  const want = new Set([...findings, ...res.other].flatMap((f) => f.observed?.shots ?? []));
  for (const p of want) {
    const abs = join(runDir, p);
    if (!abs.startsWith(runDir) || !existsSync(abs)) continue;
    shots[p] = readFileSync(abs).toString("base64");
  }
  const start = Date.parse(progress.startedAt ?? run.startedAt), end = Date.parse(progress.finishedAt ?? "");
  return {
    runId: run.runId, label: run.label, inputs: inputs.items.map((i) => i.ref), url: run.url,
    size: progress.size ?? "quick", agents: progress.agents ?? 0, startedAt: run.startedAt,
    durationMin: Number.isFinite(end - start) ? Math.round(((end - start) / 60000) * 10) / 10 : 0,
    commit, permissions: run.permissions ?? [], findings, other: res.other, otherHidden: res.otherHidden,
    skipped, counts: countRun(findings, skipped), unreadLinks: inputs.unreadLinks ?? [], shots,
    runners: readJson<RunRecord["runners"]>(join(runDir, "runners.json"), []),
    leftBehind: readJson<{ label: string; removed: boolean; note?: string }[]>(join(runDir, "cleanup.json"), [])
      .filter((c) => !c.removed).map((c) => ({ label: c.label, note: c.note ?? "" })),
  };
}

export function sessionRuns(sessionDir: string): RunRecord[] {
  const runs = join(sessionDir, "runs");
  if (!existsSync(runs)) return [];
  return readdirSync(runs).filter((d) => existsSync(join(runs, d, "run.json"))).map((d) => buildRunRecord(join(runs, d)));
}

function issueText(f: Finding, r: RunRecord): string {
  return [`${f.title}`, "", `Spec: ${f.specced.text} (${f.specced.ref})`,
    f.built ? `Built: ${f.built.text} (${f.built.ref})` : "", f.observed ? `Observed: ${f.observed.text}` : "",
    f.observed?.steps.length ? "\nSteps:\n" + f.observed.steps.map((s, i) => `${i + 1}. ${s}`).join("\n") : "",
    `\nFound by Baseline run ${r.runId} on ${r.url} as ${f.personas.join(", ")}.`].filter(Boolean).join("\n");
}

function findingHTML(f: Finding, r: RunRecord, i: number, budget: { left: number }): string {
  const c = `var(${VERDICT_VAR[f.verdict] ?? "--v-human"})`;
  const shots = (f.observed?.shots ?? []).map((p) => {
    const b64 = r.shots[p];
    if (!b64 || b64.length > budget.left) return `<p class="notice">Screenshot ${esc(p)} is kept in the run folder.</p>`;
    budget.left -= b64.length;
    const mime = p.endsWith(".png") ? "image/png" : "image/jpeg";
    return `<figure class="shot"><div class="bar"><span>${esc(p)}</span></div><button class="zoom" data-caption="${esc(f.title)}"><div class="canvas real"><img alt="${esc(f.title)}" loading="lazy" src="data:${mime};base64,${b64}"></div></button></figure>`;
  }).join("");
  const conflictCol = (k: "specced" | "built" | "observed") => (f.verdict === "spec-built" && k !== "observed") || (f.verdict === "built-observed" && k !== "specced") ? " conflict" : "";
  const cols = [
    `<div class="col${conflictCol("specced")}"><div class="lbl">Specced</div><p>${esc(f.specced.text)}</p><div class="ref">${esc(f.specced.ref)}</div></div>`,
    r.commit.codeRead && f.built ? `<div class="col${conflictCol("built")}"><div class="lbl">Built</div><p>${esc(f.built.text)}</p><div class="ref">${esc(f.built.ref)}</div></div>` : "",
    `<div class="col${conflictCol("observed")}"><div class="lbl">Observed</div><p>${esc(f.observed?.text ?? "Not seen on the site.")}</p></div>`,
  ].join("");
  const steps = f.observed?.steps.length ? `<ol class="steps">${f.observed.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : "";
  return `<details class="f" style="--c:${c};--i:${i}" data-group="${group(f.verdict)}" data-personas="${esc(f.personas.join(","))}" data-text="${esc((f.title + " " + f.specced.text + " " + (f.observed?.text ?? "")).toLowerCase())}">
<summary><i class="mk"></i><span class="rid">${esc(f.id)}</span><span class="ttl">${esc(f.title)}<small>${esc(f.personas.join(", "))}${f.route ? " · " + esc(f.route) : ""}</small></span>
<span class="right"><span class="tag">${esc(VERDICT_LABEL[f.verdict] ?? f.verdict)}</span><span class="sev${f.severity === "critical" ? " crit" : ""}">${esc(f.severity)}</span></span></summary>
<div class="body"><div class="chips">${f.checklistItem ? `<span>checklist ${esc(f.checklistItem)}</span>` : ""}${f.scope === "unrelated" ? "<span>not related to this change</span>" : ""}</div>
<div class="cols">${cols}</div>${!r.commit.codeRead ? `<div class="nobuilt">Code was not read for this run.</div>` : ""}
${shots && steps ? `<div class="evidence"><div>${shots}</div><div>${steps}</div></div>` : shots || steps}
${f.refuter?.note ? `<div class="refuter"><b>Refuter</b><span>${esc(f.refuter.note)}</span></div>` : ""}
<div class="actions"><span class="chips"></span><button class="btn" type="button" data-copy="${esc(issueText(f, r))}">Copy as issue</button></div></div></details>`;
}

function runHTML(r: RunRecord, hidden: boolean): string {
  const budget = { left: SHOT_BUDGET };
  const attention = r.findings.filter(needsAttention).length;
  const personas = [...new Set(r.findings.flatMap((f) => f.personas))];
  const groups: [string, string][] = [["all", "All"], ["conflict", "Conflicts"], ["product", "Product"], ["unspecced", "Unspecced"], ["unverified", "Unverified"], ["match", "Match"]];
  const legend = (["conflict", "product", "unspecced", "unverified", "match"] as const).map((g) => {
    const n = r.findings.filter((f) => group(f.verdict) === g).length;
    const v = g === "conflict" ? "--v-specbuilt" : VERDICT_VAR[g];
    return `<button class="lg${n ? "" : " zero"}" type="button" data-filter="${g}" aria-pressed="false" style="--c:var(${v})"><i class="sw"></i><span class="t">${g === "conflict" ? "Conflicts" : g[0]!.toUpperCase() + g.slice(1)}</span><span class="n">${n}</span></button>`;
  }).join("");
  const warn = [
    !r.commit.codeRead ? `<p class="warn">Code was not read for this run: findings compare the spec with the site only.</p>` : "",
    r.commit.mismatch ? `<p class="warn">The site is running a different commit (${esc(r.commit.deployed)}) from the code that was read (${esc(r.commit.commitRead)}). Some findings may be version gaps.</p>` : "",
  ].join("");
  const otherHTML = r.other.length || r.otherHidden ? `<section class="sec wp" style="--w:4"><h2>Other observations · not related to this change</h2><div class="list">${r.other.map((f, i) => findingHTML(f, r, i, budget)).join("")}</div>${r.otherHidden ? `<p class="more">+${r.otherHidden} more, not listed</p>` : ""}</section>` : "";
  const uniqSkipped = [...new Map(r.skipped.map((s) => [`${s.runner}|${s.category}|${s.method}|${s.path}`, s])).values()];
  const skippedHTML = uniqSkipped.length ? `<section class="sec wp" style="--w:5"><h2>Skipped · ${uniqSkipped.length}</h2><div class="rows">${uniqSkipped.map((s) =>
    `<div class="row"><span><b>${esc(s.runner)}</b> <span class="k">${esc(s.method)} ${esc(s.host)}${esc(s.path)}</span></span><span>${esc(s.reason)}${s.trigger ? ` (“${esc(s.trigger)}”)` : ""}</span><span class="k">To include it next time: ${esc(ALLOW_HINT[s.category] ?? "change this runner's permissions")}</span></div>`).join("")}</div></section>` : "";
  const permHTML = r.permissions.length ? `<section class="sec wp" style="--w:6"><h2>Permissions this run had</h2><div class="rows">${r.permissions.map((p) =>
    `<div class="perm"><b>${esc(p.runner)}</b><ul>${p.can.map((c) => `<li>${esc(c)}</li>`).join("")}</ul><ul class="no">${p.cannot.map((c) => `<li>not: ${esc(c)}</li>`).join("")}</ul></div>`).join("")}</div></section>` : "";
  const runnersHTML = (r.runners ?? []).some((x) => !x.ok) ? `<section class="sec wp" style="--w:5"><h2>Runners</h2><div class="rows">${r.runners.map((x) =>
    `<div class="row"><span><b>${esc(x.key)}</b></span><span>${x.ok ? "signed in" : "not signed in"}</span><span class="k">${esc(x.error ?? "")}</span></div>`).join("")}</div></section>` : "";
  const leftHTML = (r.leftBehind ?? []).length ? `<section class="sec wp" style="--w:6"><h2>Left behind · ${r.leftBehind.length}</h2><div class="rows">${r.leftBehind.map((x) =>
    `<div class="row"><span><b>${esc(x.label)}</b></span><span>${esc(x.note)}</span><span class="k">Remove it by hand on the site.</span></div>`).join("")}</div></section>` : "";
  const unread = r.unreadLinks.length ? `<section class="sec wp" style="--w:7"><h2>Links that could not be read</h2><div class="rows">${r.unreadLinks.map((l) => `<div class="row"><span class="k">${esc(l)}</span></div>`).join("")}</div></section>` : "";
  return `<section class="run" data-run="${esc(r.runId)}"${hidden ? " hidden" : ""}>
<header class="case wp" style="--w:0"><div><h1>${esc(r.label)}</h1><div class="tele"><span>run <b>${esc(r.runId)}</b></span><span>${r.size} · <b>${r.agents} agents</b></span><span>${r.durationMin}m</span><span>${esc(r.url)}${r.commit.commitRead ? ` @ <b>${esc(r.commit.commitRead)}</b>` : ""}</span></div></div><span class="result">Complete</span></header>
${warn}
<div class="summary wp" style="--w:1"><div class="block"><div class="count"><b>${attention}</b><span>need a look · ${r.counts.passRate === null ? "nothing verified yet" : `${r.counts.passRate}% pass · ${r.counts.checked} verified`}${r.counts.unverified ? ` · ${r.counts.unverified} unverified` : ""}</span></div>
<div class="tally">${r.findings.map((f, i) => `<i class="${f.verdict === "match" ? "ok" : ""}" data-group="${group(f.verdict)}" style="--c:var(${VERDICT_VAR[f.verdict]});--i:${i}"></i>`).join("")}</div>
<div class="legend">${legend}</div></div>
<div class="block"><div class="block-h"><span class="lbl">People</span></div><div class="people">${personas.map((p) => {
    const mine = r.findings.filter((f) => f.personas.includes(p));
    const bad = mine.filter(needsAttention).length;
    return `<button class="person" type="button" data-persona="${esc(p)}" aria-pressed="false"><span class="nm">${esc(p)}</span><span class="dots">${mine.map((f, i) => `<i style="--c:var(${VERDICT_VAR[f.verdict]});--i:${i}"></i>`).join("")}</span><span class="ct${bad ? " has" : ""}">${bad} to look at</span></button>`;
  }).join("")}</div></div></div>
<div class="toolbar wp" style="--w:2"><div class="seg" role="group" aria-label="Filter">${groups.map(([g, l]) => `<button type="button" data-filter="${g}" aria-pressed="${g === "all"}">${l}</button>`).join("")}</div>
<div class="tools-r"><span class="readout data"><b>${r.findings.length}</b> shown</span><input class="search" type="search" placeholder="Search findings" aria-label="Search findings"></div></div>
<div class="list wp" style="--w:3">${r.findings.length ? r.findings.map((f, i) => findingHTML(f, r, i, budget)).join("") : `<p class="empty">No findings for this run.</p>`}</div>
${runnersHTML}${leftHTML}${otherHTML}${skippedHTML}${permHTML}${unread}
</section>`;
}

/** One self-contained page for every run in a Claude Code session, newest first. */
export function renderSessionReport(runs: RunRecord[], theme: ThemeName): string {
  const sorted = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const cls = theme === "br2049" ? "" : `plain ${theme}`;
  const rail = sorted.length > 1 ? `<div><div class="block-h"><span class="lbl">Runs this session</span><span class="lbl">${sorted.length}</span></div><div class="feats">${sorted.map((r, i) =>
    `<button class="feat" type="button" data-pick="${esc(r.runId)}" aria-current="${i === 0}"><span class="row"><span class="nm">${esc(r.label)}</span></span><span class="row"><span class="map">${esc(r.runId)}</span><span class="st">${r.counts.passRate === null ? "not verified" : r.counts.passRate + "% pass"}</span></span></button>`).join("")}</div></div>` : "";
  return `<!doctype html>
<html lang="en" class="${cls}" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Baseline report</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Michroma&family=Inter:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500&family=IBM+Plex+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP&text=%E7%85%A7%E5%90%88%E4%B8%8D%E4%B8%80%E8%87%B4&display=swap">
<style>${CSS}</style></head><body>
<div class="vignette" aria-hidden="true"></div><div class="roll" aria-hidden="true"></div><div class="sweep" id="sweep" aria-hidden="true"></div>
<div class="console"><aside class="rail">
<div class="brand"><b>BASELINE<span class="cursor" aria-hidden="true"></span></b><span>spec / build / site <span class="jp" aria-hidden="true">照合</span></span></div>
<div class="seg skins" role="group" aria-label="Theme"><button type="button" data-skin="br2049" aria-pressed="${theme === "br2049"}">BR2049</button><button type="button" data-skin="light" aria-pressed="${theme === "light"}">Light</button><button type="button" data-skin="dark" aria-pressed="${theme === "dark"}">Dark</button></div>
${rail}</aside>
<main class="deck" id="deck">${sorted.map((r, i) => runHTML(r, i !== 0)).join("\n")}</main></div>
<div class="lb" id="lb" hidden><div class="lb-back"></div><div class="lb-frame"><div class="lb-bar"><span class="p"></span><button type="button">Close</button></div><div class="lb-view"><div class="lb-img"><img alt=""></div></div></div></div>
<script>${APP_JS.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
}
