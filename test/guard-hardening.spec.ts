import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixture } from "./fixture-app/server";
import { openSession } from "../src/browser/session";
import { decide, redactUrl, globMatch } from "../src/browser/guard";
import { loadConfig, newRunner, isProduction } from "../src/config/store";

let f: Awaited<ReturnType<typeof startFixture>>;
let state: string;
beforeAll(async () => {
  f = await startFixture();
  state = join(mkdtempSync(join(tmpdir(), "st-")), "state.json");
  writeFileSync(state, JSON.stringify({ cookies: [{ name: "sid", value: "ok", domain: new URL(f.url).hostname, path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] }));
});
afterAll(() => f.stop());

const look = newRunner("customer", "customer", { kind: "session" });
const create = { ...look, depth: "create" as const };
const had = (m: string, p: string) => f.requests.some((r) => r.method === m && r.path === p);
const blocked = (dir: string) => JSON.parse(readFileSync(join(dir, "blocked.json"), "utf8"));

async function run(runner: typeof look, fn: (s: Awaited<ReturnType<typeof openSession>>) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "run-"));
  const s = await openSession({ runDir: dir, runId: "r-t", runner, cfg: loadConfig(dir), baseUrl: f.url, storageState: state });
  try { await fn(s); } finally { await s.close(); }
  return dir;
}

describe("guard hardening (task 4 review)", () => {
  it("a POST learned on load does not unlock a different body to the same path (GraphQL)", async () => {
    f.requests.length = 0;
    const dir = await run(look, async (s) => {
      await s.goto("/gql");
      await s.click({ role: "button", name: "Rename" });
      await s.page.getByText("failed").waitFor();
    });
    expect(f.requests.filter((r) => r.path === "/graphql").length).toBe(1);
    expect(blocked(dir)).toContainEqual(expect.objectContaining({ path: "/graphql", category: "unknown-write" }));
  });

  it("a GET navigation to a protected URL pattern is blocked", async () => {
    f.requests.length = 0;
    const dir = await run(look, async (s) => {
      await s.goto("/admin");
      await s.click({ role: "link", name: "Remove member" }).catch(() => {});
    });
    expect(had("GET", "/users/7/delete")).toBe(false);
    expect(blocked(dir)).toContainEqual(expect.objectContaining({ category: "delete" }));
  });

  it("logout links are treated as auth and blocked", async () => {
    f.requests.length = 0;
    await run(look, async (s) => {
      await s.goto("/admin");
      await s.click({ role: "link", name: "Log out" }).catch(() => {});
    });
    expect(had("GET", "/logout")).toBe(false);
  });

  it("a confirm step does not launder a protected click on a create runner", async () => {
    f.requests.length = 0;
    const dir = await run(create, async (s) => {
      await s.goto("/admin");
      await s.click({ role: "button", name: "Delete project" });
      await s.click({ role: "button", name: "Confirm" });
      await s.page.getByText("failed").waitFor();
    });
    expect(had("DELETE", "/api/projects/3")).toBe(false);
    expect(blocked(dir)).toContainEqual(expect.objectContaining({ category: "delete" }));
  });

  it("icon buttons are read by their title", async () => {
    const r = { ...create };
    const dir = mkdtempSync(join(tmpdir(), "run-"));
    const cfg = loadConfig(dir);
    cfg.patterns.delete.words.push("archive");
    const s = await openSession({ runDir: dir, runId: "r-t", runner: r, cfg, baseUrl: f.url, storageState: state });
    f.requests.length = 0;
    try {
      await s.goto("/admin");
      await s.click({ role: "button", name: "Archive" });
      await s.page.getByText("failed").waitFor();
    } finally { await s.close(); }
    expect(had("POST", "/api/archive")).toBe(false);
  });
});

describe("decide hardening", () => {
  const cfg = loadConfig(mkdtempSync(join(tmpdir(), "c-")));
  const ctx = (runner: typeof look = create) => ({ runner, cfg, learned: new Set<string>(), baseHost: "staging.acme.dev" });
  it("DELETE needs the delete permission even on a create runner", () => {
    expect(decide({ method: "DELETE", url: "https://staging.acme.dev/api/x/1", loading: false }, ctx())).toMatchObject({ action: "abort", category: "delete" });
  });
  it("DELETE of something the run created is allowed", () => {
    const c = { ...ctx(), createdPaths: ["/api/orders/9"] };
    expect(decide({ method: "DELETE", url: "https://staging.acme.dev/api/orders/9", loading: false }, c).action).toBe("continue");
  });
  it("a delete-word click on the run's own draft is allowed, on anyone else's it is not", () => {
    const id = "15f1b5d3-9d93-46bb-bdcc-9dc439525f60";
    const c = { ...ctx(), createdPaths: [`/projects/${id}`] };
    const click = (path: string) => decide({ method: "POST", url: `https://staging.acme.dev${path}`, loading: false, clickText: "Delete project" }, c);
    expect(click(`/projects/${id}`).action).toBe("continue");
    expect(click(`/projects/${id}/summary`).action).toBe("continue");
    expect(click(`/api/projects/${id}`).action).toBe("continue");
    expect(click("/projects/aaaaaaaa-0000-0000-0000-000000000000")).toMatchObject({ action: "abort", category: "delete" });
    const short = { ...ctx(), createdPaths: ["/projects/1"] };
    expect(decide({ method: "POST", url: "https://staging.acme.dev/x/1", loading: false, clickText: "Delete project" }, short)).toMatchObject({ action: "abort", category: "delete" });
  });
  it("owning a record is strict: real ids only, no collections, no encoded tricks, URL patterns still apply", () => {
    const id = "15f1b5d3-9d93-46bb-bdcc-9dc439525f60";
    const del = (created: string[], path: string) => decide({ method: "POST", url: `https://staging.acme.dev${path}`, loading: false, clickText: "Delete project" }, { ...ctx(), createdPaths: created });
    expect(del([`/projects/${id}/summary`], "/settings/summary")).toMatchObject({ action: "abort" });
    expect(del(["/projects"], "/projects/aaaaaaaa-0000-0000-0000-000000000000")).toMatchObject({ action: "abort" });
    expect(del([`/projects/${id}`], `/projects/${id}/..%2f..%2fusers%2f7`)).toMatchObject({ action: "abort" });
    expect(del([`/projects/${id}`], `/projects/${id}/a/b/c`)).toMatchObject({ action: "abort" });
    expect(del([`/projects/${id}`], `/projects/${id}/delete`)).toMatchObject({ action: "abort", category: "delete" });
  });
  it("a list page's delete-selected is ours only when every id it names is one the run created", () => {
    const mine = "15f1b5d3-9d93-46bb-bdcc-9dc439525f60", theirs = "aaaaaaaa-0000-4000-8000-000000000000";
    const c = { ...ctx(), createdPaths: [`/projects/${mine}`] };
    const bulk = (body: string) => decide({ method: "POST", url: "https://staging.acme.dev/projects", loading: false, clickText: "Delete project", body }, c);
    expect(bulk(JSON.stringify([{ ids: [mine] }])).action).toBe("continue");
    expect(bulk(JSON.stringify([{ ids: [mine, theirs] }]))).toMatchObject({ action: "abort", category: "delete" });
    expect(bulk(JSON.stringify([{ all: true }]))).toMatchObject({ action: "abort", category: "delete" });
    expect(bulk(JSON.stringify([{ ids: [mine, 42] }]))).toMatchObject({ action: "abort", category: "delete" });
    expect(bulk(`ids=${mine}`)).toMatchObject({ action: "abort", category: "delete" });
    expect(bulk(JSON.stringify([{ ids: [mine], scope: "all" }]))).toMatchObject({ action: "abort", category: "delete" });
    expect(bulk(JSON.stringify([{ ids: [mine], [theirs]: null }]))).toMatchObject({ action: "abort", category: "delete" });
    expect(bulk(JSON.stringify([mine, "$undefined"])).action).toBe("continue");
    const onTheirs = decide({ method: "POST", url: `https://staging.acme.dev/projects/${theirs}`, loading: false, clickText: "Delete project", body: JSON.stringify([mine]) }, c);
    expect(onTheirs).toMatchObject({ action: "abort", category: "delete" });
  });
  it("a click's words don't block other services' requests made in the same moment", () => {
    const c = ctx();
    const at = (url: string) => decide({ method: "POST", url, loading: false, clickText: "Delete project" }, c);
    expect(at("https://staging.acme.dev/projects")).toMatchObject({ action: "abort", category: "delete" });
    expect(at("https://wired-buffalo-11.clerk.accounts.dev/v1/environment?_method=PATCH").action).toBe("continue");
    expect(at("https://o1.ingest.us.sentry.io/api/1/envelope/").action).toBe("continue");
    // The app's own API on another host is still judged by the click.
    expect(at("https://api.acme.dev/projects/7")).toMatchObject({ action: "abort", category: "delete" });
    expect(at("https://unknown.example/delete-things")).toMatchObject({ action: "abort", category: "delete" });
  });
  it("never learns a request to another host", () => {
    expect(decide({ method: "POST", url: "https://analytics.example/collect", loading: true }, ctx(look))).toEqual({ action: "continue" });
  });
  it("normalises paths before glob matching", () => {
    expect(globMatch("**/delete", "/users/7/delete/")).toBe(true);
    expect(globMatch("**/delete", "/users/7/%64elete")).toBe(true);
    expect(globMatch("**/delete", "/users/7/delete;jsessionid=1")).toBe(true);
  });
});

describe("other review fixes", () => {
  it("redacts long token-like path segments", () => {
    expect(redactUrl("https://x.dev/reset-password/9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c")).toBe("/reset-password/[redacted]");
    expect(redactUrl("https://x.dev/orders/123/items")).toBe("/orders/123/items");
  });
  it("subdomains of a production host are production too", () => {
    const cfg = { ...loadConfig(mkdtempSync(join(tmpdir(), "c-"))), productionUrls: ["https://acme.dev"] };
    expect(isProduction("https://api.acme.dev/x", cfg)).toBe(true);
    expect(isProduction("https://notacme.dev/x", cfg)).toBe(false);
  });
});

describe("security review: created paths and goto targets", () => {
  it("created() cannot whitelist a DELETE: only paths the site itself returned count", async () => {
    f.requests.length = 0;
    const dir = await run(create, async (s) => {
      await s.goto("/admin");
      s.created("project", "Baseline r-t project", "/api/projects/3");
      await s.click({ role: "button", name: "Tidy up" });
      await s.page.getByText("failed").waitFor();
    });
    expect(had("DELETE", "/api/projects/3")).toBe(false);
    expect(blocked(dir)).toContainEqual(expect.objectContaining({ category: "delete" }));
  });

  it("goto refuses another origin, a scheme-relative URL and non-http schemes", async () => {
    await run(look, async (s) => {
      await expect(s.goto("https://example.com/")).rejects.toThrow(/only goes to pages on/);
      await expect(s.goto("//example.com/x")).rejects.toThrow(/only goes to pages on/);
      await expect(s.goto("javascript:alert(1)")).rejects.toThrow(/only goes to pages on/);
      await s.goto(f.url + "/cart");
      expect(await s.title()).toBe("Cart");
    });
  });
});
