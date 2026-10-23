import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixture } from "./fixture-app/server";
import { openSession as rawOpenSession, readBlocked } from "../src/browser/session";
import { trustRun } from "./helpers/trust";
import { loadConfig, newRunner } from "../src/config/store";
import { readJsonl } from "../src/core/json";
import { trustedFiles } from "../src/core/paths";
import { SignedOutError } from "../src/browser/signin";
import { requestKey } from "../src/browser/guard";

let f: Awaited<ReturnType<typeof startFixture>>;
let state: string;
beforeAll(async () => {
  // Trusted run state goes to the data folder: keep it out of the real one.
  process.env.BASELINE_DATA = mkdtempSync(join(tmpdir(), "data-"));
  f = await startFixture();
  state = join(mkdtempSync(join(tmpdir(), "st-")), "state.json");
  const host = new URL(f.url).hostname;
  writeFileSync(state, JSON.stringify({ cookies: [{ name: "sid", value: "ok", domain: host, path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] }));
});
afterAll(() => f.stop());

/** Open a session on a hand-made run folder, recording it the way `run new` would first. */
const openSession: typeof rawOpenSession = (o) => { trustRun(o); return rawOpenSession(o); };

const look = newRunner("customer", "customer", { kind: "session" });
const runDir = () => mkdtempSync(join(tmpdir(), "run-"));
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const lines = (p: string) => readJsonl<any>(p);
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
    expect(lines(join(dir, "blocked.jsonl"))).toContainEqual(expect.objectContaining({ runner: "customer", method: "POST", path: "/api/cart", category: "unknown-write" }));
    // The report reads Baseline's own copy, which agents can't edit.
    expect(readBlocked(dir)).toContainEqual(expect.objectContaining({ method: "POST", path: "/api/cart" }));
  });

  it("learns and allows a write fired on page load", async () => {
    f.requests.length = 0;
    const dir = await withSession(look, {}, async (s) => { await s.goto("/tracked"); });
    expect(had("POST", "/api/track")).toBe(true);
    // Learned writes live in the data folder: a script can't add to them.
    expect(read(trustedFiles.learned(dir, "customer")).some((k: string) => k.startsWith("POST ") && k.includes("/api/track"))).toBe(true);
    expect(existsSync(join(dir, "logs", "load-requests-customer.json"))).toBe(false);
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
    expect(lines(join(dir, "blocked.jsonl"))).toContainEqual(expect.objectContaining({ category: "email", trigger: "send invoice" }));
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
    expect(lines(join(dir, "blocked.jsonl"))[0].category).toBe("live");
  });

  it("records created objects and screenshots", async () => {
    const dir = await withSession(look, {}, async (s, d) => {
      await s.goto("/cart");
      const p = await s.shot("cart", "Cart as customer");
      expect(p).toMatch(/^shots\/customer-cart-1\.jpg$/);
      expect(existsSync(join(d, p))).toBe(true);
      s.created("order", "Baseline r-test order", "/orders/1");
    });
    expect(lines(join(dir, "created.jsonl"))).toContainEqual(expect.objectContaining({ runner: "customer", label: "Baseline r-test order", labelled: true }));
    expect(lines(join(dir, "shots.jsonl"))).toContainEqual(expect.objectContaining({ caption: "Cart as customer" }));
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

const createRunner = { ...look, depth: "create" as const };
const blockedLog = (dir: string) => readFileSync(join(dir, "blocked.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("session guard: protected actions in the browser", () => {
  it("a POST learned on load does not unlock a different body to the same path (GraphQL)", async () => {
    f.requests.length = 0;
    const dir = await withSession(look, {}, async (s) => {
      await s.goto("/gql");
      await s.click({ role: "button", name: "Rename" });
      await s.page.getByText("failed").waitFor();
    });
    expect(f.requests.filter((r) => r.path === "/graphql").length).toBe(1);
    expect(blockedLog(dir)).toContainEqual(expect.objectContaining({ path: "/graphql", category: "unknown-write" }));
  });

  it("a GET navigation to a protected URL pattern is blocked", async () => {
    f.requests.length = 0;
    const dir = await withSession(look, {}, async (s) => {
      await s.goto("/admin");
      await s.click({ role: "link", name: "Remove member" }).catch(() => {});
    });
    expect(had("GET", "/users/7/delete")).toBe(false);
    expect(blockedLog(dir)).toContainEqual(expect.objectContaining({ category: "delete" }));
  });

  it("logout links are treated as auth and blocked", async () => {
    f.requests.length = 0;
    await withSession(look, {}, async (s) => {
      await s.goto("/admin");
      await s.click({ role: "link", name: "Log out" }).catch(() => {});
    });
    expect(had("GET", "/logout")).toBe(false);
  });

  it("a confirm step does not launder a protected click on a create runner", async () => {
    f.requests.length = 0;
    const dir = await withSession(createRunner, {}, async (s) => {
      await s.goto("/admin");
      await s.click({ role: "button", name: "Delete project" });
      await s.click({ role: "button", name: "Confirm" });
      await s.page.getByText("failed").waitFor();
    });
    expect(had("DELETE", "/api/projects/3")).toBe(false);
    expect(blockedLog(dir)).toContainEqual(expect.objectContaining({ category: "delete" }));
  });

  it("icon buttons are read by their title", async () => {
    const dir = runDir();
    const cfg = loadConfig(dir);
    cfg.patterns.delete.words.push("archive");
    const s = await openSession({ runDir: dir, runId: "r-test", runner: createRunner, cfg, baseUrl: f.url, storageState: state });
    f.requests.length = 0;
    try {
      await s.goto("/admin");
      await s.click({ role: "button", name: "Archive" });
      await s.page.getByText("failed").waitFor();
    } finally { await s.close(); }
    expect(had("POST", "/api/archive")).toBe(false);
  });

  it("created() cannot whitelist a DELETE: only paths the site itself returned count", async () => {
    f.requests.length = 0;
    const dir = await withSession(createRunner, {}, async (s) => {
      await s.goto("/admin");
      s.created("project", "Baseline r-test project", "/api/projects/3");
      await s.click({ role: "button", name: "Tidy up" });
      await s.page.getByText("failed").waitFor();
    });
    expect(had("DELETE", "/api/projects/3")).toBe(false);
    expect(blockedLog(dir)).toContainEqual(expect.objectContaining({ category: "delete" }));
  });

  it("goto refuses another origin, a scheme-relative URL and non-http schemes", async () => {
    await withSession(look, {}, async (s) => {
      await expect(s.goto("https://example.com/")).rejects.toThrow(/only goes to pages on/);
      await expect(s.goto("//example.com/x")).rejects.toThrow(/only goes to pages on/);
      await expect(s.goto("javascript:alert(1)")).rejects.toThrow(/only goes to pages on/);
      await s.goto(f.url + "/cart");
      expect(await s.title()).toBe("Cart");
    });
  });
});

describe("session: screenshots and sign-out", () => {
  const formRunner = newRunner("customer", "customer", { kind: "form", loginUrl: "/login" });

  it("a second session never overwrites an earlier screenshot", async () => {
    const dir = runDir();
    for (let i = 0; i < 2; i++) {
      const s = await openSession({ runDir: dir, runId: "r", runner: formRunner, cfg: loadConfig(dir), baseUrl: f.url, storageState: state });
      await s.goto("/cart");
      await s.shot("cart", "Cart " + i);
      await s.close();
    }
    expect(readdirSync(join(dir, "shots")).sort()).toEqual(["customer-cart-1.jpg", "customer-cart-2.jpg"]);
    expect(lines(join(dir, "shots.jsonl")).map((x: { path: string }) => x.path)).toEqual(["shots/customer-cart-1.jpg", "shots/customer-cart-2.jpg"]);
  });

  it("a click that lands on the sign-in page throws SignedOutError", async () => {
    const dir = runDir();
    const s = await openSession({ runDir: dir, runId: "r", runner: formRunner, cfg: loadConfig(dir), baseUrl: f.url, storageState: state });
    try {
      await s.goto("/admin");
      await expect(s.click({ role: "link", name: "Switch account" })).rejects.toBeInstanceOf(SignedOutError);
    } finally { await s.close(); }
  });
});

describe("session guard: trusted run state", () => {
  it("uses the config as of run new: a mid-run edit to the passed config can't upgrade a runner", async () => {
    const dir = runDir();
    const cfg = loadConfig(dir);
    writeFileSync(trustedFiles.config(dir), JSON.stringify({ ...cfg, runners: [look] }));
    writeFileSync(trustedFiles.run(dir), JSON.stringify({ runDir: dir, projectDir: dir, url: f.url, startedAt: new Date().toISOString() }));
    f.requests.length = 0;
    // The caller claims a create runner; Baseline's own snapshot says look only.
    const s = await openSession({ runDir: dir, runId: "r-test", runner: createRunner, cfg, baseUrl: f.url, storageState: state });
    try {
      await s.goto("/cart");
      await s.page.getByRole("button", { name: "Apply discount" }).click();
      await s.page.getByText("failed").waitFor();
    } finally { await s.close(); }
    expect(had("POST", "/api/cart")).toBe(false);
  });

  it("ignores a learned list written into the run folder", async () => {
    const dir = runDir();
    const host = new URL(f.url).host;
    mkdirSync(join(dir, "logs"), { recursive: true });
    writeFileSync(join(dir, "logs", "load-requests-customer.json"), JSON.stringify([requestKey("POST", `http://${host}/api/cart`, JSON.stringify({ code: "" }))]));
    f.requests.length = 0;
    const s = await openSession({ runDir: dir, runId: "r-test", runner: look, cfg: loadConfig(dir), baseUrl: f.url, storageState: state });
    try {
      await s.goto("/cart");
      await s.page.getByRole("button", { name: "Apply discount" }).click();
      await s.page.getByText("failed").waitFor();
    } finally { await s.close(); }
    expect(had("POST", "/api/cart")).toBe(false);
  });
});

describe("session actions", () => {
  it("drives the page through the action API without leaving the guard", async () => {
    f.requests.length = 0;
    await withSession(look, {}, async (s) => {
      await s.goto("/cart");
      expect(await s.url()).toBe(f.url + "/cart");
      expect(await s.title()).toBe("Cart");
      await s.fill({ label: "Discount code" }, "SAVE10");
      expect(await s.page.locator("#code").inputValue()).toBe("SAVE10");
      await s.press("Tab", { label: "Discount code" });
      await s.press("Tab"); // nothing to read from: must not wait for a focus timeout
      await s.hover({ role: "button", name: "Search" });
      await s.waitFor({ text: "Mug x1" }, { timeout: 0 }); // 0 is clamped, never "forever"
      await s.waitFor({ css: "#status" }, { state: "hidden", timeout: 2000 });
      expect(await s.snapshot()).toMatch(/Cart/);
      expect(await s.text({ text: "Mug x1" })).toBe("Mug x1");
      expect(await s.text()).toContain("Discount code");
      await s.goto("/checkout");
      await s.back();
      expect(await s.url()).toBe(f.url + "/cart");
      await s.click({ role: "button", name: "Apply discount" });
    });
    // A look-only click still can't write, whichever API sent it.
    expect(had("POST", "/api/cart")).toBe(false);
  });

  it("finds targets by placeholder, test id, css and nth", async () => {
    await withSession(look, {}, async (s) => {
      await s.goto("/cart");
      await s.page.evaluate(() => { document.querySelector("main")!.insertAdjacentHTML("beforeend", '<input placeholder="Gift note"><span data-testid="tag">sale</span><b class="x">one</b><b class="x">two</b>'); });
      await s.fill({ placeholder: "Gift note" }, "hi");
      expect(await s.text({ testId: "tag" })).toBe("sale");
      expect(await s.text({ css: "b.x", nth: 1 })).toBe("two");
    });
  });
});

describe("session guard: refuses runs Baseline didn't start", () => {
  it("won't open a browser without Baseline's own record of the run", async () => {
    const dir = runDir();
    await expect(rawOpenSession({ runDir: dir, runId: "r", runner: look, cfg: { ...loadConfig(dir), runners: [look] }, baseUrl: f.url, storageState: state })).rejects.toThrow(/no record of starting this run/);
  });

  it("won't open without the config saved at run new, and never falls back to the live config", async () => {
    const dir = runDir();
    writeFileSync(trustedFiles.run(dir), JSON.stringify({ runDir: dir, projectDir: dir, url: f.url, startedAt: new Date().toISOString() }));
    await expect(rawOpenSession({ runDir: dir, runId: "r", runner: look, cfg: { ...loadConfig(dir), runners: [look] }, baseUrl: f.url, storageState: state })).rejects.toThrow(/no saved config/);
  });

  it("won't open a runner that wasn't set up when the run started", async () => {
    const dir = runDir();
    trustRun({ runDir: dir, baseUrl: f.url, cfg: { ...loadConfig(dir), runners: [look] } });
    await expect(rawOpenSession({ runDir: dir, runId: "r", runner: newRunner("admin", "admin", { kind: "session" }), cfg: loadConfig(dir), baseUrl: f.url, storageState: state })).rejects.toThrow(/wasn't set up/);
  });

  it("browses the site from Baseline's record, not the URL the caller passes", async () => {
    const dir = runDir();
    trustRun({ runDir: dir, baseUrl: f.url, cfg: loadConfig(dir), runner: look });
    const s = await rawOpenSession({ runDir: dir, runId: "r", runner: look, cfg: loadConfig(dir), baseUrl: "https://evil.example", storageState: state });
    try {
      await s.goto("/cart");
      expect(new URL(await s.url()).origin).toBe(new URL(f.url).origin);
    } finally { await s.close(); }
  });
});

describe("session guard: typing into unlabelled fields", () => {
  it("an autosave or Enter-search from an unlabelled field isn't treated as a wordless click", async () => {
    const create = newRunner("customer", "customer", { kind: "session" });
    create.depth = "create";
    f.requests.length = 0;
    const dir = await withSession(create, {}, async (s) => {
      await s.goto("/notes");
      await s.fill({ css: "#n" }, "remember the milk");
      await s.page.getByText("done 200").waitFor();
      await s.page.evaluate(() => { document.getElementById("status")!.textContent = ""; });
      await s.press("Enter", { css: "#s" });
      await s.page.waitForFunction(() => /done|failed/.test(document.getElementById("status")?.textContent ?? ""));
    });
    expect(had("POST", "/api/notes/save")).toBe(true);
    expect(existsSync(join(dir, "blocked.jsonl"))).toBe(false);
    expect(had("POST", "/api/notes/find")).toBe(true);
  });
});

