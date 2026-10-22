import { describe, it, expect } from "vitest";
import { decide, globMatch } from "../src/browser/guard";
import { loadConfig, newRunner } from "../src/config/store";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cfg = () => ({ ...loadConfig(mkdtempSync(join(tmpdir(), "g-"))), productionUrls: ["https://shop.acme.dev"] });
const look = newRunner("c", "customer", { kind: "session" });
const create = { ...look, depth: "create" as const };
const base = "https://staging.acme.dev";
const req = (o: Partial<Parameters<typeof decide>[0]>) => ({ method: "POST", url: base + "/api/x", loading: false, ...o });

describe("globMatch", () => {
  it("handles ** and *", () => {
    expect(globMatch("**/billing/**", "/org/1/billing/plan")).toBe(true);
    expect(globMatch("/api/*", "/api/search")).toBe(true);
    expect(globMatch("/api/*", "/api/a/b")).toBe(false);
    expect(globMatch("/api/search", "/api/search")).toBe(true);
  });
});

describe("decide", () => {
  const ctx = (runner = look, c = cfg()) => ({ runner, cfg: c, learned: new Set<string>() });

  it("blocks every request to a production URL without live, even reads", () => {
    expect(decide(req({ method: "GET", url: "https://shop.acme.dev/" }), ctx())).toMatchObject({ action: "abort", category: "live" });
  });
  it("allows production with live", () => {
    const r = { ...look, allow: ["live" as const] };
    expect(decide(req({ method: "GET", url: "https://shop.acme.dev/" }), ctx(r)).action).toBe("continue");
  });
  it("allows reads", () => {
    expect(decide(req({ method: "GET" }), ctx()).action).toBe("continue");
  });
  it("learns writes fired while a page loads", () => {
    const c = ctx();
    expect(decide(req({ loading: true }), c)).toEqual({ action: "continue", learn: "POST /api/x" });
    c.learned.add("POST /api/x");
    expect(decide(req({}), c).action).toBe("continue");
  });
  it("allows configured read-only posts", () => {
    const c = cfg();
    c.readPosts = ["/api/search"];
    expect(decide(req({ url: base + "/api/search" }), ctx(look, c)).action).toBe("continue");
  });
  it("blocks other writes for look only as unknown-write", () => {
    expect(decide(req({}), ctx())).toMatchObject({ action: "abort", category: "unknown-write" });
  });
  it("lets a create runner write", () => {
    expect(decide(req({}), ctx(create)).action).toBe("continue");
  });
  it("blocks a protected word click for a create runner", () => {
    expect(decide(req({ clickText: "Send Invoice now" }), ctx(create))).toMatchObject({ action: "abort", category: "email", trigger: "send invoice" });
  });
  it("blocks a protected URL pattern", () => {
    expect(decide(req({ url: base + "/org/1/billing/card" }), ctx(create))).toMatchObject({ action: "abort", category: "finance" });
  });
  it("a protected write is blocked even when it was learned on load", () => {
    const c = ctx(create);
    c.learned.add("POST /api/x");
    expect(decide(req({ clickText: "Delete user" }), c)).toMatchObject({ action: "abort", category: "delete" });
  });
  it("allows a protected category the runner was given", () => {
    const r = { ...create, allow: ["email" as const] };
    expect(decide(req({ clickText: "Send invoice" }), ctx(r)).action).toBe("continue");
  });
  it("matches words on word boundaries, so 'pay' does not match 'display'", () => {
    expect(decide(req({ clickText: "Display settings" }), ctx(create)).action).toBe("continue");
  });
});
