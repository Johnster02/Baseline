import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newRun, finishRun } from "../src/run/state";
import { updateProgress, readProgress } from "../src/run/progress";
import { sizeRun } from "../src/run/sizing";
import { commitInfo } from "../src/run/commit";
import { readSiteMap, mergeSiteMap } from "../src/run/sitemap";
import { loadConfig } from "../src/config/store";

const tmp = () => mkdtempSync(join(tmpdir(), "run-"));

describe("newRun", () => {
  it("runs in one session share a session dir and write run.json + active-run", () => {
    const p = tmp();
    const a = newRun(p, "sess-1", { url: "http://localhost:3000", label: "PR #412" });
    const b = newRun(p, "sess-1", { url: "http://localhost:3000", label: "PR #412" });
    expect(a.sessionDir).toBe(b.sessionDir);
    expect(a.runDir).not.toBe(b.runDir);
    expect(JSON.parse(readFileSync(join(b.runDir, "run.json"), "utf8"))).toMatchObject({ runId: b.runId, url: "http://localhost:3000" });
    expect(readFileSync(join(p, ".baseline", "active-run"), "utf8")).toBe(b.runDir);
  });

  it("without a session id each run gets its own session dir", () => {
    const p = tmp();
    expect(newRun(p, undefined, { url: "http://x", label: "x" }).sessionDir).not.toBe(newRun(p, undefined, { url: "http://x", label: "x" }).sessionDir);
  });

  it("run ids look like r-YYYYMMDD-HHMM with a suffix when needed", () => {
    expect(newRun(tmp(), "s", { url: "http://x", label: "x" }).runId).toMatch(/^r-\d{8}-\d{4}(-\d+)?$/);
  });

  it("finishRun removes the active-run pointer", () => {
    const p = tmp();
    newRun(p, "s", { url: "http://x", label: "x" });
    finishRun(p);
    expect(existsSync(join(p, ".baseline", "active-run"))).toBe(false);
  });
});

describe("progress", () => {
  it("patches phases and agents, and a reader never sees partial JSON", () => {
    const d = tmp();
    updateProgress(d, { runId: "r-1", label: "PR #412", size: "quick", agents: 3 });
    updateProgress(d, { phase: { name: "explore", status: "active", pct: 62 } });
    updateProgress(d, { agent: { persona: "customer", doing: "opening /cart" } });
    for (let i = 0; i < 50; i++) { updateProgress(d, { phase: { name: "explore", status: "active", pct: i } }); expect(() => readProgress(d)).not.toThrow(); }
    const p = readProgress(d)!;
    // A lower reported pct never pulls the bar back below 62.
    expect(p.phases.find((x) => x.name === "explore")!.pct).toBeGreaterThanOrEqual(62);
    expect(p.phases.find((x) => x.name === "explore")!.since).toBeTruthy();
    expect(p.phases.map((x) => x.name)).toEqual(["gather", "read-code", "explore", "verdicts", "refute", "clean-up"]);
    expect(p.active).toEqual([{ persona: "customer", doing: "opening /cart" }]);
  });
});

describe("sizeRun", () => {
  it("one PR, 3 files, one persona is a PR run with at most 3 agents", () => {
    const r = sizeRun([{ kind: "github-pr", words: 200 }], 3, ["customer"], true, ["src/cart/Cart.tsx"]);
    expect(r.size).toBe("pr");
    expect(r.agents).toBeLessThanOrEqual(3);
    expect(r.codeOnly).toBe(false);
  });
  it("a single ticket without a PR is quick", () => {
    expect(sizeRun([{ kind: "jira", words: 300 }], 0, ["customer"], true).size).toBe("quick");
  });
  it("a PR touching no UI files is code-only, with no explorers", () => {
    const r = sizeRun([{ kind: "github-pr", words: 100 }], 2, ["customer"], true, ["server/jobs/sync.ts", "server/jobs/sync.test.ts"]);
    expect(r.codeOnly).toBe(true);
    expect(r.plan.some((p) => p.startsWith("explorer:"))).toBe(false);
  });
  it("a PR touching only tests inside a UI folder is still code-only", () => {
    expect(sizeRun([{ kind: "github-pr", words: 100 }], 1, ["customer"], true, ["src/components/__tests__/Cart.test.tsx"]).codeOnly).toBe(true);
  });
  it("a PR touching a page or stylesheet is not code-only", () => {
    expect(sizeRun([{ kind: "github-pr", words: 100 }], 2, ["customer"], true, ["server/api.ts", "app/cart/page.ts"]).codeOnly).toBe(false);
    expect(sizeRun([{ kind: "github-pr", words: 100 }], 1, ["customer"], true, ["src/theme.css"]).codeOnly).toBe(false);
  });
  it("PR runs send at most 2 explorers", () => {
    expect(sizeRun([{ kind: "github-pr", words: 100 }], 2, ["a", "b"], true, ["x.tsx"]).plan.filter((p) => p.startsWith("explorer:")).length).toBe(2);
  });
  it("a spec folder makes it full", () => {
    expect(sizeRun([{ kind: "folder", words: 0 }], 0, ["customer", "admin"], true).size).toBe("full");
  });
  it("more than 15 changed files makes it full", () => {
    expect(sizeRun([{ kind: "github-pr", words: 100 }], 16, ["customer"], true).size).toBe("full");
  });
  it("no code means no code reader", () => {
    expect(sizeRun([{ kind: "text", words: 20 }], 0, ["customer"], false).plan).not.toContain("code-reader");
  });
  it("full runs cap explorers at 4", () => {
    const r = sizeRun([{ kind: "folder", words: 0 }], 0, ["a", "b", "c", "d", "e", "f"], true);
    expect(r.plan.filter((x) => x.startsWith("explorer")).length).toBe(4);
  });
});

describe("commitInfo", () => {
  it("no git repo means code not read", async () => {
    expect(await commitInfo(tmp(), loadConfig(tmp()))).toEqual({ codeRead: false, mismatch: false });
  });
  it("flags a mismatch between the commit read and the deployed one", async () => {
    const d = tmp();
    execFileSync("git", ["init", "-q"], { cwd: d });
    writeFileSync(join(d, "a"), "1");
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "x", "--allow-empty"], { cwd: d });
    execFileSync("git", ["add", "."], { cwd: d });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "y"], { cwd: d });
    const cfg = { ...loadConfig(d), versionProbe: { url: "http://x/version", pattern: '"commit":"([0-9a-f]+)"' } };
    const r = await commitInfo(d, { ...cfg, versionProbe: { url: "http://staging.acme.dev/version", pattern: cfg.versionProbe.pattern } }, async () => '{"commit":"a41c9e2"}', "http://staging.acme.dev");
    expect(r.codeRead).toBe(true);
    expect(r.deployed).toBe("a41c9e2");
    expect(r.mismatch).toBe(true);
  });
});

describe("site map", () => {
  it("merges personas for a repeated route without duplicating it", () => {
    const p = tmp();
    mergeSiteMap(p, { routes: [{ path: "/cart", title: "Cart", personas: ["customer"] }], notes: [] });
    mergeSiteMap(p, { routes: [{ path: "/cart", title: "Cart", personas: ["admin"] }, { path: "/admin", title: "Admin", personas: ["admin"] }], notes: ["admin sees billing"] });
    const m = readSiteMap(p);
    expect(m.routes).toHaveLength(2);
    expect(m.routes.find((r) => r.path === "/cart")!.personas.sort()).toEqual(["admin", "customer"]);
    expect(m.notes).toEqual(["admin sees billing"]);
  });
});

describe("commitInfo probe safety", () => {
  it("only probes the run's own site", async () => {
    const d = tmp();
    execFileSync("git", ["init", "-q"], { cwd: d });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x", "--allow-empty"], { cwd: d });
    const cfg = { ...loadConfig(d), versionProbe: { url: "http://169.254.169.254/latest/meta-data", pattern: "(.*)" } };
    let called = false;
    const r = await commitInfo(d, cfg, async () => { called = true; return "x"; }, "https://staging.acme.dev");
    expect(called).toBe(false);
    expect(r.deployed).toBeUndefined();
  });
});

describe("probe origin", () => {
  it("a different port or scheme on the same host is refused", async () => {
    const d = tmp();
    execFileSync("git", ["init", "-q"], { cwd: d });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x", "--allow-empty"], { cwd: d });
    let called = 0;
    const probe = async () => { called++; return '{"commit":"abc1234"}'; };
    const mk = (url: string) => ({ ...loadConfig(d), versionProbe: { url, pattern: '"commit":"([0-9a-f]+)"' } });
    await commitInfo(d, mk("http://staging.acme.dev:2375/version"), probe, "http://staging.acme.dev");
    await commitInfo(d, mk("https://staging.acme.dev/version"), probe, "http://staging.acme.dev");
    expect(called).toBe(0);
  });
});
