import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterFindings } from "../src/findings/filter";
import { countRun } from "../src/findings/counts";
import { addNote, listNotes } from "../src/findings/notes";
import { findingSchema } from "../src/findings/schema";
import type { Finding } from "../src/findings/schema";
import { main } from "../src/cli";
import "../src/commands";

let n = 0;
const F = (o: Partial<Finding>): Finding => findingSchema.parse({
  id: `R-${++n}`, title: `finding ${n}`, verdict: "product", severity: "medium", personas: ["customer"], scope: "related",
  specced: { text: "s", ref: "spec R1" }, observed: { text: "o", shots: ["a.png"], steps: ["open"] }, refuter: { kept: true, note: "" }, ...o,
});
const opts = { otherCap: 5, codeRead: true };

describe("filterFindings", () => {
  it("never caps related findings", () => {
    const r = filterFindings(Array.from({ length: 12 }, () => F({})), opts);
    expect(r.kept).toHaveLength(12);
  });

  it("caps unrelated findings at 5, highest severity first, and counts the rest", () => {
    const sev = ["low", "critical", "medium", "high", "low", "medium", "high", "low"] as const;
    const r = filterFindings(sev.map((s) => F({ scope: "unrelated", severity: s })), opts);
    expect(r.other.map((f) => f.severity)).toEqual(["critical", "high", "high", "medium", "medium"]);
    expect(r.otherHidden).toBe(3);
    expect(r.kept).toHaveLength(0);
  });

  it("a conflict with no evidence becomes unverified", () => {
    const r = filterFindings([F({ verdict: "built-observed", observed: undefined, built: undefined })], opts);
    expect(r.kept[0]!.verdict).toBe("unverified");
  });

  it("a conflict backed only by a code reference stays a conflict", () => {
    const r = filterFindings([F({ verdict: "spec-built", observed: undefined, built: { text: "b", ref: "src/cart.ts:88" } })], opts);
    expect(r.kept[0]!.verdict).toBe("spec-built");
  });

  it("without code, verdicts that need code become unverified", () => {
    const r = filterFindings([F({ verdict: "spec-built", built: { text: "b", ref: "x:1" } }), F({ verdict: "not-built" })], { otherCap: 5, codeRead: false });
    expect(r.kept.map((f) => f.verdict)).toEqual(["unverified", "unverified"]);
  });

  it("merges the same issue seen by two personas", () => {
    const a = F({ route: "/checkout", specced: { text: "s", ref: "R2" }, verdict: "built-observed", personas: ["customer"], severity: "medium" });
    const b = F({ route: "/checkout", specced: { text: "s", ref: "R2" }, verdict: "built-observed", personas: ["guest"], severity: "high", title: "Other words" });
    const r = filterFindings([a, b], opts);
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0]!.personas.sort()).toEqual(["customer", "guest"]);
    expect(r.kept[0]!.severity).toBe("high");
  });

  it("drops what the refuter did not keep", () => {
    const r = filterFindings([F({ refuter: { kept: false, note: "deliberate" } })], opts);
    expect(r.kept).toHaveLength(0);
    expect(r.dropped).toHaveLength(1);
  });

  it("orders kept findings worst first", () => {
    const r = filterFindings([F({ severity: "low" }), F({ severity: "critical", verdict: "spec-built" }), F({ severity: "high" })], opts);
    expect(r.kept.map((f) => f.severity)).toEqual(["critical", "high", "low"]);
  });
});

describe("countRun", () => {
  it("6 match + 2 conflict + 1 product + 1 unverified = 8 checked, 75%", () => {
    const fs = [
      ...Array.from({ length: 6 }, () => F({ verdict: "match" })),
      F({ verdict: "spec-built" }), F({ verdict: "built-observed" }), F({ verdict: "product" }), F({ verdict: "unverified" }),
    ];
    const blocked = [{ runner: "c", category: "email", path: "/a", method: "POST" }, { runner: "c", category: "email", path: "/a", method: "POST" }];
    expect(countRun(fs, blocked as any)).toEqual({ checked: 8, passed: 6, passRate: 75, conflicts: 2, product: 1, unspecced: 0, unverified: 1, skipped: 1 });
  });
  it("zero checked has no pass rate", () => {
    expect(countRun([], []).passRate).toBeNull();
  });
});

describe("notes", () => {
  it("round trip", () => {
    const p = realpathSync(mkdtempSync(join(tmpdir(), "n-")));
    addNote(p, "R-3", "admins can't see billing by design");
    expect(listNotes(p)).toEqual([expect.objectContaining({ findingId: "R-3", text: "admins can't see billing by design" })]);
  });
});

describe("pass rate over verified checks only (dogfood)", () => {
  it("unverified and skipped findings don't drag the pass rate down", () => {
    const fs = [F({ verdict: "match" }), F({ verdict: "product" }), F({ verdict: "unverified" }), F({ verdict: "unverified" }), F({ verdict: "skipped" })];
    expect(countRun(fs, [])).toMatchObject({ checked: 1, passed: 1, passRate: 100, product: 1, unverified: 2, skipped: 1 });
  });
  it("nothing verified gives a null pass rate, not 0%", () => {
    expect(countRun([F({ verdict: "unverified" })], []).passRate).toBeNull();
  });
});

describe("pass rate covers requirement checks only (dogfood 2)", () => {
  it("unspecced and product observations are not failed checks", () => {
    const fs = [F({ verdict: "match" }), F({ verdict: "unspecced" }), F({ verdict: "product" })];
    expect(countRun(fs, [])).toMatchObject({ checked: 1, passed: 1, passRate: 100, unspecced: 1, product: 1 });
    expect(countRun([F({ verdict: "unspecced" })], []).passRate).toBeNull();
  });
});

describe("filterFindings: dedupe", () => {
  const G = (o: object) => findingSchema.parse({ id: `X-${++n}`, title: "t", verdict: "unspecced", specced: { text: "-", ref: "-" }, route: "/cart", personas: ["a"], observed: { text: "o", shots: [`s${n}.jpg`], steps: ["x"] }, ...o });
  it("different unspecced findings on one route stay apart", () => {
    expect(filterFindings([G({ title: "Prices missing" }), G({ title: "Search button does nothing" })], opts).kept).toHaveLength(2);
  });
  it("merged findings keep both personas' evidence", () => {
    const r = filterFindings([G({ title: "Same", personas: ["a"] }), G({ title: "same", personas: ["b"] })], opts).kept;
    expect(r).toHaveLength(1);
    expect(r[0]?.observed?.shots).toHaveLength(2);
  });
});

describe("baseline dismiss", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "dismiss-")));
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => vi.restoreAllMocks());
  it("records the finding's title and route, so the note survives renumbering", async () => {
    const runDir = join(cwd, ".baseline", "sessions", "s", "runs", "r-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId: "r-1", url: "http://x", label: "x", startedAt: new Date().toISOString() }));
    writeFileSync(join(runDir, "findings.json"), JSON.stringify([{ id: "U-customer-1", title: "Prices missing on cart", route: "/cart", verdict: "unspecced", specced: { text: "-", ref: "-" } }]));
    writeFileSync(join(cwd, ".baseline", "last-run"), runDir);
    expect(await main(["dismiss", "U-customer-1", "Prices are shown at checkout by design"])).toBe(0);
    expect(listNotes(cwd)[0]).toMatchObject({ findingId: "U-customer-1", title: "Prices missing on cart", route: "/cart", text: "Prices are shown at checkout by design" });
  });
});
