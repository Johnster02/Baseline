import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderSessionReport, buildRunRecord } from "../src/render/report";
import type { RunRecord } from "../src/render/report";
import { THEMES } from "../src/render/tokens";
import { findingSchema } from "../src/findings/schema";

const finding = (o: object) => findingSchema.parse({ id: "R-01", title: "Expired code still gives a discount", verdict: "spec-built", severity: "high", personas: ["customer"],
  specced: { text: "Expired codes are rejected.", ref: "spec.md R2" }, built: { text: "Checked on save only.", ref: "src/cart.ts:88" },
  observed: { text: "SPRING24 took 10% off.", shots: [], steps: ["open /cart", "apply SPRING24"] }, refuter: { kept: true, note: "Reproduced twice." }, ...o });

const record = (o: Partial<RunRecord> = {}): RunRecord => ({
  runId: "r-20261022-0914", label: "PR #412 Discount codes", inputs: [{ kind: "github-pr", ref: "412" }], url: "https://staging.acme.dev",
  size: "quick", agents: 3, startedAt: "2026-10-22T09:14:00Z", durationMin: 9.2,
  commit: { codeRead: true, commitRead: "a41c9e2", mismatch: false },
  permissions: [{ runner: "customer", can: ["browse pages"], cannot: ["send email"] }],
  findings: [finding({})], other: [], otherHidden: 0,
  skipped: [{ at: "", runner: "customer", method: "POST", host: "staging.acme.dev", path: "/api/invoice/send", category: "email", reason: "clicked control looks like email", trigger: "send invoice" }],
  counts: { checked: 10, passed: 6, passRate: 60, conflicts: 2, product: 1, unspecced: 0, unverified: 1, skipped: 1 },
  unreadLinks: [], shots: {}, runners: [], leftBehind: [], ...o,
});

describe("renderSessionReport", () => {
  it("shows a run switcher, newest first, when the session has more than one run", () => {
    const html = renderSessionReport([record({ runId: "r-1", startedAt: "2026-10-22T09:00:00Z" }), record({ runId: "r-2", startedAt: "2026-10-22T10:00:00Z" })], "br2049");
    expect(html).toContain('data-run="r-2"');
    expect(html.indexOf('data-pick="r-2"')).toBeLessThan(html.indexOf('data-pick="r-1"'));
  });

  it("says Complete and never pass/fail wording", () => {
    const html = renderSessionReport([record()], "br2049");
    expect(html).toContain("Complete");
    expect(html).not.toMatch(/Ready for QA|Needs work/);
  });

  it("hides every Built column and says so when code was not read", () => {
    const html = renderSessionReport([record({ commit: { codeRead: false, mismatch: false } })], "br2049");
    expect(html).not.toContain('<div class="lbl">Built');
    expect(html).toContain("Code was not read");
  });

  it("warns when the site runs a different commit", () => {
    const html = renderSessionReport([record({ commit: { codeRead: true, commitRead: "a41c9e2", deployed: "b7c1d2e", mismatch: true } })], "br2049");
    expect(html).toMatch(/different commit/);
  });

  it("lists skipped actions with the permission that would allow them", () => {
    const html = renderSessionReport([record()], "br2049");
    expect(html).toContain("/api/invoice/send");
    expect(html).toMatch(/allow email/i);
  });

  it("escapes finding text", () => {
    const html = renderSessionReport([record({ findings: [finding({ title: "<script>alert(1)</script>" })] })], "br2049");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("starts in the chosen theme and carries the navy dark tokens", () => {
    const html = renderSessionReport([record()], "dark");
    expect(html).toMatch(/<html[^>]*class="plain dark"/);
    expect(THEMES.dark.void).toBe("#0b1220");
    expect(html).toContain("--void:#0b1220");
    expect(THEMES.br2049.void).toBe("#0e0d0a");
  });

  it("caps other observations and shows how many more", () => {
    const other = Array.from({ length: 5 }, (_, i) => finding({ id: `O-${i}`, scope: "unrelated", verdict: "product" }));
    const html = renderSessionReport([record({ other, otherHidden: 3 })], "br2049");
    expect(html).toContain("+3 more");
  });

  it("stays under 16 MiB with many screenshots by leaving some in the run folder", () => {
    const shots: Record<string, string> = {};
    const big = Buffer.alloc(600 * 1024, 7).toString("base64");
    const fs = Array.from({ length: 40 }, (_, i) => { shots[`s${i}.jpg`] = big; return finding({ id: `R-${i}`, observed: { text: "x", shots: [`s${i}.jpg`], steps: ["a"] } }); });
    const html = renderSessionReport([record({ findings: fs, shots })], "br2049");
    expect(Buffer.byteLength(html)).toBeLessThan(16 * 1024 * 1024);
    expect(html).toContain("kept in the run folder");
  });
});

describe("buildRunRecord", () => {
  it("assembles a record from a run folder and filters findings", () => {
    const proj = mkdtempSync(join(tmpdir(), "p-"));
    const runDir = join(proj, ".baseline", "sessions", "s", "runs", "r-1");
    mkdirSync(join(runDir, "shots"), { recursive: true });
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId: "r-1", url: "http://x", label: "PR #1", startedAt: "2026-10-22T09:00:00Z", permissions: [] }));
    writeFileSync(join(runDir, "inputs.json"), JSON.stringify({ items: [{ ref: { kind: "text", ref: "t" } }], unreadLinks: ["https://wiki/x"] }));
    writeFileSync(join(runDir, "progress.json"), JSON.stringify({ size: "quick", agents: 2, startedAt: "2026-10-22T09:00:00Z", finishedAt: "2026-10-22T09:09:00Z" }));
    writeFileSync(join(runDir, "shots", "customer-a-1.jpg"), "JPEGDATA");
    writeFileSync(join(runDir, "findings.json"), JSON.stringify([
      { id: "R-1", title: "a", verdict: "match", specced: { text: "s", ref: "R1" } },
      { id: "R-2", title: "b", verdict: "product", specced: { text: "s", ref: "R2" }, observed: { text: "o", shots: ["shots/customer-a-1.jpg"], steps: ["x"] } },
      { id: "R-3", title: "c", verdict: "product", specced: { text: "s", ref: "R3" }, refuter: { kept: false, note: "deliberate" } },
    ]));
    writeFileSync(join(runDir, "commit.json"), JSON.stringify({ codeRead: false, mismatch: false }));
    const r = buildRunRecord(runDir);
    expect(r.findings.map((f) => f.id)).toEqual(["R-2", "R-1"]);
    expect(r.counts).toMatchObject({ checked: 1, passed: 1, passRate: 100, product: 1 });
    expect(r.durationMin).toBe(9);
    expect(r.unreadLinks).toEqual(["https://wiki/x"]);
    expect(Buffer.from(r.shots["shots/customer-a-1.jpg"]!, "base64").toString()).toBe("JPEGDATA");
  });
});

describe("baseline report cli", () => {
  it("writes report.html for a session and prints its path", async () => {
    const { main } = await import("../src/cli");
    await import("../src/commands");
    const { vi } = await import("vitest");
    const proj = mkdtempSync(join(tmpdir(), "p-"));
    const sess = join(proj, ".baseline", "sessions", "s");
    const runDir = join(sess, "runs", "r-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId: "r-1", url: "http://x", label: "PR #1", startedAt: "2026-10-22T09:00:00Z" }));
    let out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((s: any) => { out += String(s); return true; });
    vi.spyOn(process, "cwd").mockReturnValue(proj);
    expect(await main(["report", sess])).toBe(0);
    vi.restoreAllMocks();
    expect(out.trim()).toBe(join(sess, "report.html"));
    expect(readFileSync(join(sess, "report.html"), "utf8")).toContain("PR #1");
  });
});
