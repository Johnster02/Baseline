import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli";
import "../src/commands";
import { wsDecide } from "../src/browser/guard";
import { loadConfig, newRunner } from "../src/config/store";
import { listNotes } from "../src/findings/notes";
import { startFixture, FIXTURE_USER } from "./fixture-app/server";
import { openSession } from "../src/browser/session";
import { SignedOutError } from "../src/browser/signin";

const tmp = (p = "mn-") => mkdtempSync(join(tmpdir(), p));

describe("cli", () => {
  let cwd: string, out: string;
  beforeEach(() => {
    cwd = tmp(); out = "";
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    vi.spyOn(process.stdout, "write").mockImplementation((s: any) => { out += String(s); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation((s: any) => { out += String(s); return true; });
    process.env.BASELINE_DATA = tmp("data-");
  });
  afterEach(() => vi.restoreAllMocks());

  it("M-1 --as applies to every ambiguous key instead of crashing", async () => {
    const run = tmp("run-");
    const code = await main(["inputs", "--run", run, "--as", "linear", "ABC-1", "DEF-2"]);
    expect(code).toBe(1);
    expect(out).toMatch(/Linear is not set up/);
  });

  it("M-3 a dismiss note records the finding's title and route, so it survives renumbering", async () => {
    const runDir = join(cwd, ".baseline", "sessions", "s", "runs", "r-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId: "r-1", url: "http://x", label: "x", startedAt: new Date().toISOString() }));
    writeFileSync(join(runDir, "findings.json"), JSON.stringify([{ id: "U-customer-1", title: "Prices missing on cart", route: "/cart", verdict: "unspecced", specced: { text: "-", ref: "-" } }]));
    writeFileSync(join(cwd, ".baseline", "last-run"), runDir);
    expect(await main(["dismiss", "U-customer-1", "Prices are shown at checkout by design"])).toBe(0);
    expect(listNotes(cwd)[0]).toMatchObject({ findingId: "U-customer-1", title: "Prices missing on cart", route: "/cart", text: "Prices are shown at checkout by design" });
  });
});

describe("M-6 WebSocket rules", () => {
  const cfg = { ...loadConfig(tmp()), productionUrls: ["https://shop.acme.dev"] };
  const create = { ...newRunner("a", "a", { kind: "session" }), depth: "create" as const };
  const look = newRunner("c", "c", { kind: "session" });
  it("never connects to production without live", () => {
    expect(wsDecide({ url: "wss://shop.acme.dev/live", loading: true }, { runner: create, cfg })).toMatchObject({ action: "abort", category: "live" });
  });
  it("blocks a create runner's message that carries a protected action", () => {
    expect(wsDecide({ url: "wss://staging.acme.dev/ws", loading: false, message: '{"event":"send invoice","id":3}' }, { runner: create, cfg })).toMatchObject({ action: "abort", category: "email" });
    expect(wsDecide({ url: "wss://staging.acme.dev/ws", loading: false, message: '{"event":"cart:update"}' }, { runner: create, cfg }).action).toBe("continue");
  });
  it("look-only: messages only while loading", () => {
    expect(wsDecide({ url: "wss://staging.acme.dev/ws", loading: true, message: "subscribe" }, { runner: look, cfg }).action).toBe("continue");
    expect(wsDecide({ url: "wss://staging.acme.dev/ws", loading: false, message: "x" }, { runner: look, cfg })).toMatchObject({ action: "abort", category: "unknown-write" });
  });
});

describe("browser", () => {
  let f: Awaited<ReturnType<typeof startFixture>>;
  let state: string;
  beforeAll(async () => {
    f = await startFixture();
    state = join(tmp("st-"), "s.json");
    writeFileSync(state, JSON.stringify({ cookies: [{ name: "sid", value: "ok", domain: new URL(f.url).hostname, path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] }));
  });
  afterAll(() => f.stop());
  const runner = newRunner("customer", "customer", { kind: "form", loginUrl: "/login" });

  it("M-2 a second session never overwrites an earlier screenshot", async () => {
    const dir = tmp("run-");
    for (let i = 0; i < 2; i++) {
      const s = await openSession({ runDir: dir, runId: "r", runner, cfg: loadConfig(dir), baseUrl: f.url, storageState: state });
      await s.goto("/cart");
      await s.shot("cart", "Cart " + i);
      await s.close();
    }
    expect(readdirSync(join(dir, "shots")).sort()).toEqual(["customer-cart-1.jpg", "customer-cart-2.jpg"]);
    expect(JSON.parse(readFileSync(join(dir, "shots.json"), "utf8")).map((x: any) => x.path)).toEqual(["shots/customer-cart-1.jpg", "shots/customer-cart-2.jpg"]);
  });

  it("M-5 a click that lands on the sign-in page throws SignedOutError", async () => {
    const dir = tmp("run-");
    const s = await openSession({ runDir: dir, runId: "r", runner, cfg: loadConfig(dir), baseUrl: f.url, storageState: state });
    try {
      await s.goto("/admin");
      await expect(s.click({ role: "link", name: "Switch account" })).rejects.toBeInstanceOf(SignedOutError);
    } finally { await s.close(); }
  });
});

describe("WebSocket normalisation (security review)", () => {
  const cfg = { ...loadConfig(tmp()), productionUrls: [] as string[] };
  const create = { ...newRunner("a", "a", { kind: "session" }), depth: "create" as const };
  it("sees protected words through JSON escapes, camelCase and snake_case", () => {
    for (const m of ['{"event":"send\\u0020invoice"}', '{"action":"sendInvoice"}', '{"action":"send_invoice"}', '{"op":"delete-user"}'])
      expect(wsDecide({ url: "wss://s.acme.dev/ws", loading: false, message: m }, { runner: create, cfg }).action, m).toBe("abort");
  });
  it("applies protected URL patterns when the socket opens", () => {
    const c = { ...cfg, patterns: { ...cfg.patterns, finance: { ...cfg.patterns.finance, urls: [...cfg.patterns.finance.urls, "/ws/payments"] } } };
    expect(wsDecide({ url: "wss://s.acme.dev/ws/payments", loading: true }, { runner: create, cfg: c })).toMatchObject({ action: "abort", category: "finance" });
  });
});

describe("protected words normalised the same way as messages", () => {
  const base = loadConfig(tmp());
  const cfg = { ...base, patterns: { ...base.patterns, finance: { ...base.patterns.finance, words: [...base.patterns.finance.words, "top-up", "buyCredits"] } } };
  const create = { ...newRunner("a", "a", { kind: "session" }), depth: "create" as const };
  it("matches hyphenated and camelCase words, raw or normalised, with any spacing", () => {
    for (const m of ['{"op":"top-up"}', '{"op":"topUp"}', '{"op":"top   up"}', '{"op":"buy_credits"}', "action=top%2Dup&x=%ZZ"])
      expect(wsDecide({ url: "wss://s.acme.dev/ws", loading: false, message: m }, { runner: create, cfg }).action, m).toBe("abort");
  });
});

describe("percent decoding (security review)", () => {
  const cfg = loadConfig(tmp());
  const create = { ...newRunner("a", "a", { kind: "session" }), depth: "create" as const };
  it("decodes around bad bytes and through double encoding", () => {
    for (const m of ["%FF%73end%20invoice", "send%2520invoice"])
      expect(wsDecide({ url: "wss://s.acme.dev/ws", loading: false, message: m }, { runner: create, cfg }).action, m).toBe("abort");
  });
});

describe("deep percent encoding", () => {
  it("decodes five layers", () => {
    let m = "send invoice";
    for (let i = 0; i < 5; i++) m = encodeURIComponent(m);
    const create = { ...newRunner("a", "a", { kind: "session" }), depth: "create" as const };
    expect(wsDecide({ url: "wss://s.acme.dev/ws", loading: false, message: m }, { runner: create, cfg: loadConfig(tmp()) }).action).toBe("abort");
  });
});

describe("fail closed on undecodable escapes", () => {
  it("a message that still has escapes after decoding is blocked for a create runner", () => {
    let m = "send invoice";
    for (let i = 0; i < 25; i++) m = encodeURIComponent(m);
    const create = { ...newRunner("a", "a", { kind: "session" }), depth: "create" as const };
    expect(wsDecide({ url: "wss://s.acme.dev/ws", loading: false, message: m }, { runner: create, cfg: loadConfig(tmp()) })).toMatchObject({ action: "abort", category: "unknown-write" });
  });
});

describe("leftover escapes are checked before splitting", () => {
  it("an escape that camelCase splitting would break apart still fails closed", async () => {
    const { decodeMessage } = await import("../src/browser/guard");
    let m = "%2D"; // "2D" is what camelCase splitting would break into "2 D"
    for (let i = 0; i < 25; i++) m = encodeURIComponent(m);
    expect(decodeMessage(m).undecodable).toBe(true);
    expect(decodeMessage("%73end").undecodable).toBe(false);
  });
});
