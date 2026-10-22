import { describe, it, expect } from "vitest";
import { frame, toSegments } from "../src/mod/frame";
import type { Progress } from "../src/run/progress";

const now = Date.parse("2026-10-22T10:00:00Z");
const progress = (o: Partial<Progress> = {}): Progress => ({
  runId: "r-1", label: "PR #412", size: "quick", agents: 3, startedAt: "2026-10-22T09:56:00Z",
  phases: [{ name: "gather", status: "done" }, { name: "read-code", status: "done" }, { name: "explore", status: "active", pct: 62 }, { name: "verdicts", status: "pending" }, { name: "refute", status: "pending" }, { name: "clean-up", status: "pending" }],
  active: [{ persona: "customer", doing: "opening /cart" }],
  counts: { checked: 0, passed: 0, passRate: 0, conflicts: 1, product: 0, unspecced: 0, unverified: 0, skipped: 0 }, ...o,
});
const summary = (finishedAt: string) => ({
  runId: "r-1", label: "PR #412", size: "quick" as const, durationMin: 9.2, finishedAt, link: "https://claude.ai/artifact/x",
  counts: { checked: 10, passed: 6, passRate: 60, conflicts: 2, product: 1, unspecced: 0, unverified: 1, skipped: 1 },
});
const text = (rows: ReturnType<typeof frame>) => rows.map((r) => r.map((s) => s.text).join("")).join("\n");

describe("frame", () => {
  it("draws nothing with no run", () => {
    expect(frame({ now }, "dark", 80, 20)).toEqual([]);
  });
  it("draws progress while a run is active", () => {
    const t = text(frame({ progress: progress(), now }, "dark", 80, 20));
    expect(t).toContain("Explore");
    expect(t).toContain("62%");
    expect(t).toContain("opening /cart");
  });
  it("draws the summary for 10 minutes after a run finishes", () => {
    expect(text(frame({ summary: summary("2026-10-22T09:55:00Z"), now }, "dark", 80, 20))).toMatch(/Pass rate.*60%/);
    expect(frame({ summary: summary("2026-10-22T09:49:00Z"), now }, "dark", 80, 20)).toEqual([]);
  });
  it("progress wins over an older summary", () => {
    expect(text(frame({ progress: progress(), summary: summary("2026-10-22T09:55:00Z"), now }, "dark", 80, 20))).toContain("62%");
  });
  it("fits the rows it is given, keeping the active phase", () => {
    const rows = frame({ progress: progress(), now }, "dark", 80, 4);
    expect(rows.length).toBeLessThanOrEqual(4);
    expect(text(rows)).toContain("62%");
  });
  it("segments carry the theme's hex colours", () => {
    const segs = frame({ progress: progress(), now }, "dark", 80, 20).flat();
    expect(segs.some((s) => s.color === "#7aa7ff")).toBe(true);
  });
});

describe("toSegments", () => {
  it("splits truecolor ANSI into coloured segments", () => {
    expect(toSegments("\x1b[38;2;255;0;0mred\x1b[0m plain")).toEqual([{ text: "red", color: "#ff0000" }, { text: " plain" }]);
  });
});

describe("finished progress without a summary", () => {
  it("shows for 10 minutes, then disappears", () => {
    expect(frame({ progress: progress({ finishedAt: "2026-10-22T09:58:00Z" }), now }, "dark", 80, 20).length).toBeGreaterThan(0);
    expect(frame({ progress: progress({ finishedAt: "2026-10-22T09:40:00Z" }), now }, "dark", 80, 20)).toEqual([]);
  });
});
