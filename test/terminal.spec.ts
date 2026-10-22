import { describe, it, expect } from "vitest";
import { renderProgress, renderSummary, colorMode, visibleLength } from "../src/render/terminal";
import type { Progress } from "../src/run/progress";
import type { RunRecord } from "../src/render/report";
import { findingSchema } from "../src/findings/schema";

const progress = (): Progress => ({
  runId: "r-1", label: "PR #412", size: "quick", agents: 3, startedAt: new Date(Date.now() - 250000).toISOString(),
  phases: [
    { name: "gather", status: "done", note: "spec R1-R10, 6 files" }, { name: "read-code", status: "done", note: "cart.ts, discount.ts" },
    { name: "explore", status: "active", pct: 62 }, { name: "verdicts", status: "pending" }, { name: "refute", status: "pending" }, { name: "clean-up", status: "pending" },
  ],
  active: [{ persona: "customer", doing: "applying SPRING24 at checkout" }, { persona: "guest", doing: "opening /cart" }],
  counts: { checked: 7, passed: 5, passRate: 71, conflicts: 2, product: 1, unverified: 0, unspecced: 0, skipped: 0 },
});

const record = (): RunRecord => ({
  runId: "r-1", label: "PR #412", inputs: [], url: "https://staging.acme.dev", size: "quick", agents: 3, startedAt: "", durationMin: 9.2,
  commit: { codeRead: true, mismatch: false }, permissions: [],
  findings: [findingSchema.parse({ id: "R-01", title: "Expired code still gives a discount", verdict: "spec-built", specced: { text: "s", ref: "r" } })],
  other: [], otherHidden: 0, skipped: [], unreadLinks: [], shots: {},
  counts: { checked: 10, passed: 6, passRate: 60, conflicts: 2, product: 1, unspecced: 0, unverified: 1, skipped: 1 },
});

const none = { color: "none" as const, width: 60 };

describe("renderSummary", () => {
  it("shows totals, pass rate and Complete, never finding titles", () => {
    const text = renderSummary(record(), "dark", { ...none, link: "https://claude.ai/artifact/x", localPath: ".baseline/sessions/s/report.html" }).join("\n");
    expect(text).toContain("60%");
    expect(text).toMatch(/result\s+Complete/);
    expect(text).toMatch(/conflicts\s+2/);
    expect(text).toContain("https://claude.ai/artifact/x");
    expect(text).not.toContain("Expired code");
  });
  it("br2049 uses its own header and upper-case result", () => {
    const text = renderSummary(record(), "br2049", none).join("\n");
    expect(text).toContain("BASELINE //");
    expect(text).toContain("COMPLETE");
  });
  it("no colour codes when color is none", () => {
    expect(renderSummary(record(), "br2049", none).join("\n")).not.toContain("\x1b[");
  });
  it("truecolor uses 24-bit codes from the theme", () => {
    expect(renderSummary(record(), "dark", { color: "truecolor", width: 60 }).join("\n")).toContain("\x1b[38;2;122;167;255m");
  });
});

describe("renderProgress", () => {
  it("draws 10 of 16 cells at 62%", () => {
    const lines = renderProgress(progress(), "dark", none);
    const row = lines.find((l) => l.includes("Explore"))!;
    expect(row).toContain("█".repeat(10) + "░".repeat(6));
    expect(row).toContain("62%");
  });
  it("lists active agents and counts", () => {
    const text = renderProgress(progress(), "dark", none).join("\n");
    expect(text).toContain("applying SPRING24 at checkout");
    expect(text).toMatch(/4m 1\ds/);
  });
  it("never exceeds the width", () => {
    for (const l of renderProgress(progress(), "br2049", { color: "truecolor", width: 40 })) expect(visibleLength(l)).toBeLessThanOrEqual(40);
    for (const l of renderSummary(record(), "light", { color: "256", width: 40, link: "https://claude.ai/artifact/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })) expect(visibleLength(l)).toBeLessThanOrEqual(40);
  });
});

describe("colorMode", () => {
  it("reads NO_COLOR and COLORTERM", () => {
    expect(colorMode({ NO_COLOR: "1", COLORTERM: "truecolor" })).toBe("none");
    expect(colorMode({ COLORTERM: "24bit" })).toBe("truecolor");
    expect(colorMode({})).toBe("256");
  });
});

describe("summary and view cli", () => {
  it("summary --plain prints totals for a run folder", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { vi } = await import("vitest");
    const { main } = await import("../src/cli");
    await import("../src/commands");
    const proj = mkdtempSync(join(tmpdir(), "p-"));
    const runDir = join(proj, ".baseline", "sessions", "s", "runs", "r-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId: "r-1", url: "http://x", label: "PR #1", startedAt: "2026-10-22T09:00:00Z" }));
    writeFileSync(join(runDir, "findings.json"), JSON.stringify([{ id: "R-1", title: "Secret title", verdict: "match", specced: { text: "s", ref: "R1" } }]));
    let out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((s: any) => { out += String(s); return true; });
    vi.spyOn(process, "cwd").mockReturnValue(proj);
    expect(await main(["summary", runDir, "--plain", "--link", "https://claude.ai/artifact/x"])).toBe(0);
    vi.restoreAllMocks();
    expect(out).toContain("100%");
    expect(out).toContain("https://claude.ai/artifact/x");
    expect(out).not.toContain("Secret title");
    expect(out).not.toContain("\x1b[");
  });
});

describe("control characters from run data", () => {
  it("are stripped before painting", () => {
    const p = progress();
    p.label = "PR \x1b]0;pwned\x07#412";
    p.active = [{ persona: "cust\x1b[2Jomer", doing: "opening \x9b31m/cart" }];
    const t = renderProgress(p, "dark", { color: "none", width: 80 }).join("\n");
    expect(t).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(t).toContain("customer");
    expect(t).toContain("PR #412");
    expect(t).toContain("opening /cart");
  });
});
