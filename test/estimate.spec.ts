import { describe, it, expect } from "vitest";
import { estimatePct } from "../src/run/estimate";
import { renderProgress } from "../src/render/terminal";
import type { Progress } from "../src/run/progress";

const t0 = Date.parse("2026-10-22T10:00:00Z");
const at = (s: number) => t0 + s * 1000;
const iso = new Date(t0).toISOString();

describe("estimatePct", () => {
  it("moves an active phase with no milestones", () => {
    const ph = { name: "gather", status: "active", since: iso };
    expect(estimatePct(ph, "quick", at(0))).toBe(0);
    const a = estimatePct(ph, "quick", at(30)), b = estimatePct(ph, "quick", at(90));
    expect(a).toBeGreaterThan(10);
    expect(b).toBeGreaterThan(a);
    expect(estimatePct(ph, "quick", at(36000))).toBeLessThanOrEqual(95);
  });
  it("starts from the last milestone and keeps going", () => {
    const ph = { name: "read-code", status: "active", since: iso, pct: 50, pctAt: iso };
    expect(estimatePct(ph, "quick", at(0))).toBe(50);
    expect(estimatePct(ph, "quick", at(60))).toBeGreaterThan(50);
  });
  it("full runs move slower than quick ones", () => {
    const ph = { name: "explore", status: "active", since: iso };
    expect(estimatePct(ph, "full", at(120))).toBeLessThan(estimatePct(ph, "quick", at(120)));
  });
  it("PR runs move fastest", () => {
    const ph = { name: "explore", status: "active", since: iso };
    expect(estimatePct(ph, "pr", at(120))).toBeGreaterThan(estimatePct(ph, "quick", at(120)));
  });
  it("leaves non-active phases and old progress files alone", () => {
    expect(estimatePct({ name: "gather", status: "done", pct: 40 }, "quick", at(60))).toBe(40);
    expect(estimatePct({ name: "explore", status: "active", pct: 62 }, "quick", at(60))).toBe(62);
  });
});

describe("renderProgress", () => {
  it("draws the estimate for gather, which never reports a pct", () => {
    const p: Progress = {
      runId: "r", label: "PR", size: "quick", agents: 1, startedAt: iso, active: [],
      phases: [{ name: "gather", status: "active", since: iso }, { name: "read-code", status: "pending" }, { name: "explore", status: "pending" }, { name: "verdicts", status: "pending" }, { name: "refute", status: "pending" }, { name: "clean-up", status: "pending" }],
      counts: { checked: 0, passed: 0, passRate: 0, conflicts: 0, product: 0, unspecced: 0, unverified: 0, skipped: 0 },
    };
    const line = renderProgress(p, "dark", { color: "none", width: 80, now: at(60) }).find((l) => l.includes("Gather"))!;
    const pct = Number(line.match(/(\d+)%/)![1]);
    expect(pct).toBeGreaterThan(30);
    expect(pct).toBeLessThan(95);
  });
});
