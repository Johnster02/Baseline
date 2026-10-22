import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide } from "../src/browser/guard";
import { bashGuard, activeRun } from "../src/hooks/bash-guard";
import { loadConfig, newRunner, saveConfig } from "../src/config/store";
import { filterFindings } from "../src/findings/filter";
import { findingSchema } from "../src/findings/schema";
import { buildRunRecord, renderSessionReport } from "../src/render/report";
import { main } from "../src/cli";
import "../src/commands";

const tmp = (p = "fr-") => mkdtempSync(join(tmpdir(), p));

describe("I-1 live runs", () => {
  it("a live run lets its own signin --live through the Bash guard, a normal run does not", () => {
    expect(bashGuard("baseline signin --all --url https://shop.acme.dev --live", { runUrl: "https://shop.acme.dev", live: true })).toEqual({ allow: true });
    expect(bashGuard("baseline signin --all --url https://shop.acme.dev --live", { runUrl: "https://staging.acme.dev" })).toMatchObject({ deny: expect.any(String) });
    expect(bashGuard("baseline config allow customer finance", { runUrl: "https://shop.acme.dev", live: true })).toMatchObject({ deny: expect.any(String) });
  });
  it("activeRun reports the live flag from run.json", () => {
    const p = tmp();
    const runDir = join(p, ".baseline", "sessions", "s", "runs", "r-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ url: "https://shop.acme.dev", live: true, startedAt: new Date().toISOString() }));
    writeFileSync(join(p, ".baseline", "active-run"), runDir);
    expect(activeRun(p)).toEqual({ url: "https://shop.acme.dev", live: true });
  });
});

describe("cli: run new", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = tmp();
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => vi.restoreAllMocks());
  it("M-4 refuses a production URL itself, and records --live", async () => {
    const cfg = { ...loadConfig(cwd), productionUrls: ["https://shop.acme.dev"] };
    saveConfig(cwd, cfg);
    expect(await main(["run", "new", "--url", "https://shop.acme.dev", "--label", "x"])).toBe(3);
    expect(await main(["run", "new", "--url", "https://shop.acme.dev", "--label", "x", "--live"])).toBe(0);
    const runDir = readFileSync(join(cwd, ".baseline", "active-run"), "utf8");
    expect(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).live).toBe(true);
  });
  it("I-3 config set merges list fields instead of replacing them", async () => {
    await main(["config", "set", "productionUrls", '["https://shop.acme.dev"]']);
    await main(["config", "set", "productionUrls", '["https://admin.acme.dev"]']);
    await main(["config", "set", "patterns", '{"email":{"words":["ping customer"]}}']);
    await main(["config", "set", "patterns", '{"finance":{"words":["top up"]}}']);
    await main(["config", "set", "readPosts", '["/api/search"]']);
    await main(["config", "set", "readPosts", '["/api/lookup"]']);
    const c = loadConfig(cwd);
    expect(c.productionUrls.sort()).toEqual(["https://admin.acme.dev", "https://shop.acme.dev"]);
    expect(c.patterns.email.words).toContain("ping customer");
    expect(c.patterns.finance.words).toContain("top up");
    expect(c.readPosts.sort()).toEqual(["/api/lookup", "/api/search"]);
    await main(["config", "set", "readPosts", '["/api/only"]', "--replace"]);
    expect(loadConfig(cwd).readPosts).toEqual(["/api/only"]);
  });
});

describe("I-2 read-only POST allowlist", () => {
  const cfg = { ...loadConfig(tmp()), readPosts: ["/graphql"] };
  const ctx = { runner: newRunner("c", "c", { kind: "session" }), cfg, learned: new Set<string>(), baseHost: "s.acme.dev" };
  it("allows a GraphQL query but not a mutation", () => {
    expect(decide({ method: "POST", url: "https://s.acme.dev/graphql", loading: false, body: JSON.stringify({ query: "query { me { id } }" }) }, ctx).action).toBe("continue");
    expect(decide({ method: "POST", url: "https://s.acme.dev/graphql", loading: false, body: JSON.stringify({ query: "mutation Save { save(id: 1) }" }) }, ctx)).toMatchObject({ action: "abort", category: "unknown-write" });
    expect(decide({ method: "POST", url: "https://s.acme.dev/graphql", loading: false, body: '{"operationName":"Save","query":"\\n  mutation Save { x }"}' }, ctx)).toMatchObject({ action: "abort" });
  });
});

let n = 0;
const F = (o: object) => findingSchema.parse({ id: `X-${++n}`, title: "t", verdict: "unspecced", specced: { text: "-", ref: "-" }, route: "/cart", personas: ["a"], observed: { text: "o", shots: [`s${n}.jpg`], steps: ["x"] }, ...o });

describe("I-5 dedupe", () => {
  it("different unspecced findings on one route stay apart", () => {
    expect(filterFindings([F({ title: "Prices missing" }), F({ title: "Search button does nothing" })], { otherCap: 5, codeRead: true }).kept).toHaveLength(2);
  });
  it("merged findings keep both personas' evidence", () => {
    const r = filterFindings([F({ title: "Same", personas: ["a"] }), F({ title: "same", personas: ["b"] })], { otherCap: 5, codeRead: true }).kept;
    expect(r).toHaveLength(1);
    expect(r[0]!.observed!.shots).toHaveLength(2);
  });
});

describe("I-4 and I-6 report sections", () => {
  it("shows runner sign-in status and anything left behind", () => {
    const proj = tmp();
    const runDir = join(proj, ".baseline", "sessions", "s", "runs", "r-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId: "r-1", url: "http://x", label: "x", startedAt: "2026-10-22T09:00:00Z" }));
    writeFileSync(join(runDir, "runners.json"), JSON.stringify([{ key: "customer", ok: true }, { key: "admin", ok: false, error: "signed out at /login" }]));
    writeFileSync(join(runDir, "cleanup.json"), JSON.stringify([{ label: "Baseline r-1 order", removed: false, note: "delete was blocked" }]));
    const rec = buildRunRecord(runDir);
    const html = renderSessionReport([rec], "br2049");
    expect(html).toContain("signed out at /login");
    expect(html).toContain("Left behind");
    expect(html).toContain("Baseline r-1 order");
  });
});

describe("I-4 signed-out detection", () => {
  it("a password field on a normal page is not 'signed out' for a session runner", async () => {
    const { looksSignedOut } = await import("../src/browser/signin");
    const runner = newRunner("a", "a", { kind: "session" });
    expect(looksSignedOut("https://s.acme.dev/settings/password", true, runner)).toBe(false);
    expect(looksSignedOut("https://s.acme.dev/login?next=/cart", true, runner)).toBe(true);
    const form = newRunner("b", "b", { kind: "form", loginUrl: "/auth/enter" });
    expect(looksSignedOut("https://s.acme.dev/auth/enter", false, form)).toBe(true);
    expect(looksSignedOut("https://s.acme.dev/account", true, form)).toBe(false);
  });
});
