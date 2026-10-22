import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixture } from "./fixture-app/server";
import { openSession } from "../src/browser/session";
import { loadConfig, newRunner } from "../src/config/store";

let f: Awaited<ReturnType<typeof startFixture>>;
let state: string;
beforeAll(async () => {
  f = await startFixture();
  state = join(mkdtempSync(join(tmpdir(), "st-")), "state.json");
  const host = new URL(f.url).hostname;
  writeFileSync(state, JSON.stringify({ cookies: [{ name: "sid", value: "ok", domain: host, path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] }));
});
afterAll(() => f.stop());

const look = newRunner("customer", "customer", { kind: "session" });
const runDir = () => mkdtempSync(join(tmpdir(), "run-"));
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const had = (method: string, path: string) => f.requests.some((r) => r.method === method && r.path === path);

async function withSession(runner: typeof look, cfgPatch: object, fn: (s: Awaited<ReturnType<typeof openSession>>, dir: string) => Promise<void>) {
  const dir = runDir();
  const cfg = { ...loadConfig(dir), ...cfgPatch };
  const s = await openSession({ runDir: dir, runId: "r-test", runner, cfg, baseUrl: f.url, storageState: state });
  try { await fn(s, dir); } finally { await s.close(); }
  return dir;
}

describe("session guard against Acme shop", () => {
  it("look only: reads work, a click that writes is aborted and logged", async () => {
    f.requests.length = 0;
    const dir = await withSession(look, {}, async (s) => {
      await s.goto("/cart");
      expect(await s.page.title()).toBe("Cart");
      await s.page.getByRole("button", { name: "Apply discount" }).click();
      await s.page.getByText("failed").waitFor();
    });
    expect(had("POST", "/api/cart")).toBe(false);
    expect(read(join(dir, "blocked.json"))).toContainEqual(expect.objectContaining({ runner: "customer", method: "POST", path: "/api/cart", category: "unknown-write" }));
  });

  it("learns and allows a write fired on page load", async () => {
    f.requests.length = 0;
    const dir = await withSession(look, {}, async (s) => { await s.goto("/tracked"); });
    expect(had("POST", "/api/track")).toBe(true);
    expect(read(join(dir, "logs", "load-requests.json"))).toContain("POST /api/track");
  });

  it("allowlisted read-only POST works for look only", async () => {
    f.requests.length = 0;
    await withSession(look, { readPosts: ["/api/search"] }, async (s) => {
      await s.goto("/cart");
      await s.page.getByRole("button", { name: "Search" }).click();
      await s.page.getByText("done 200").waitFor();
    });
    expect(had("POST", "/api/search")).toBe(true);
  });

  it("create runner may write, but Send invoice is blocked as email", async () => {
    f.requests.length = 0;
    const create = { ...look, depth: "create" as const };
    const dir = await withSession(create, {}, async (s) => {
      await s.goto("/cart");
      await s.page.getByRole("button", { name: "Apply discount" }).click();
      await s.page.getByText("done 200").waitFor();
      await s.goto("/admin");
      await s.page.getByRole("button", { name: "Send invoice" }).click();
      await s.page.getByText("failed").waitFor();
    });
    expect(had("POST", "/api/cart")).toBe(true);
    expect(had("POST", "/api/invoice/send")).toBe(false);
    expect(read(join(dir, "blocked.json"))).toContainEqual(expect.objectContaining({ category: "email", trigger: "send invoice" }));
  });

  it("redacts token-like query values in the network log", async () => {
    const dir = await withSession(look, {}, async (s) => { await s.goto("/cart?token=abc123&x=1"); });
    const log = readFileSync(join(dir, "logs", "customer-network.json"), "utf8");
    expect(log).toContain("token=[redacted]");
    expect(log).toContain("x=1");
    expect(log).not.toContain("abc123");
  });

  it("refuses to load a production URL without live", async () => {
    f.requests.length = 0;
    const dir = await withSession(look, { productionUrls: [f.url] }, async (s) => {
      await expect(s.goto("/cart")).rejects.toThrow();
    });
    expect(f.requests.length).toBe(0);
    expect(read(join(dir, "blocked.json"))[0].category).toBe("live");
  });

  it("records created objects and screenshots", async () => {
    const dir = await withSession(look, {}, async (s) => {
      await s.goto("/cart");
      const p = await s.shot("cart", "Cart as customer");
      expect(existsSync(p)).toBe(true);
      s.created("order", "Baseline r-test order", "/orders/1");
    });
    expect(read(join(dir, "created.json"))).toContainEqual(expect.objectContaining({ runner: "customer", label: "Baseline r-test order" }));
    expect(read(join(dir, "shots.json"))).toContainEqual(expect.objectContaining({ caption: "Cart as customer" }));
  });
});

describe("direct API requests", () => {
  it("page.request methods are disabled so nothing skips the guard", async () => {
    f.requests.length = 0;
    await withSession(look, {}, async (s) => {
      await expect(s.page.request.post(f.url + "/api/cart")).rejects.toThrow(/not allowed/);
      await expect(s.page.context().request.fetch(f.url + "/api/cart", { method: "POST" })).rejects.toThrow(/not allowed/);
    });
    expect(had("POST", "/api/cart")).toBe(false);
  });
});
