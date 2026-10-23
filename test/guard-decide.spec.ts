import { describe, it, expect } from "vitest";
import { decide, globMatch, wsDecide, decodeMessage, redactUrl, requestKey, urlMatches } from "../src/browser/guard";
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
    expect(decide(req({ loading: true }), c)).toEqual({ action: "continue", learn: "POST staging.acme.dev/api/x" });
    c.learned.add("POST staging.acme.dev/api/x");
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
    c.learned.add("POST staging.acme.dev/api/x");
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

describe("query strings", () => {
  const c = cfg();
  const ctxOf = (runner: typeof look) => ({ runner, cfg: c, learned: new Set<string>(), baseHost: "staging.acme.dev" });
  it("a learned request does not unlock the same path with a different query", () => {
    const x = ctxOf(look);
    const load = decide(req({ url: base + "/api/rpc?op=getUser", loading: true }), x);
    expect(load.action).toBe("continue");
    if (load.action === "continue" && load.learn) x.learned.add(load.learn);
    expect(decide(req({ url: base + "/api/rpc?op=getUser" }), x).action).toBe("continue");
    expect(decide(req({ url: base + "/api/rpc?op=deleteUser" }), x)).toMatchObject({ action: "abort", category: "unknown-write" });
  });
  it("URL patterns can match the query", () => {
    const withQuery = { ...c, patterns: { ...c.patterns, delete: { ...c.patterns.delete, urls: [...c.patterns.delete.urls, "**?action=delete"] } } };
    const x = { runner: create, cfg: withQuery, learned: new Set<string>(), baseHost: "staging.acme.dev" };
    expect(decide(req({ url: base + "/api/items/7?action=delete" }), x)).toMatchObject({ action: "abort", category: "delete" });
    expect(decide(req({ url: base + "/api/items/7?action=view" }), x).action).toBe("continue");
  });
  it("query patterns match each param wherever it sits, in any order", () => {
    const u = (p: string) => new URL(base + p);
    expect(urlMatches("**?action=delete", u("/api/items/7?x=1&action=delete"))).toBe(true);
    expect(urlMatches("**?action=delete", u("/api/items/7?action=delete&y=2"))).toBe(true);
    expect(urlMatches("**?action=delete", u("/api/items/7?action=deleted"))).toBe(false);
    expect(urlMatches("/api/**?action=del*&confirm", u("/api/a?confirm=1&action=delete-all"))).toBe(true);
    expect(urlMatches("/api/**?action=del*&confirm", u("/api/a?action=delete-all"))).toBe(false);
    // A ; or / inside the query can't cut the path match short or hide a param.
    expect(urlMatches("**?action=delete", u("/api/x?a=;&action=delete"))).toBe(true);
    expect(urlMatches("**?action=delete", u("/api/x?next=/a;b&action=delete"))).toBe(true);
  });
  it("a pattern without ? matches the path only, so a query naming /logout isn't a logout", () => {
    expect(urlMatches("**/logout", new URL(base + "/signin?next=%2Flogout"))).toBe(false);
    expect(urlMatches("**/logout", new URL(base + "/app/logout?x=1"))).toBe(true);
  });
  it("cache-buster params don't stop a learned load request from matching again", () => {
    const x = ctxOf(look);
    const load = decide(req({ url: base + "/api/poll?_=1700000000000&feed=main", loading: true }), x);
    if (load.action === "continue" && load.learn) x.learned.add(load.learn);
    expect(decide(req({ url: base + "/api/poll?feed=main&_=1700000009999" }), x).action).toBe("continue");
    expect(decide(req({ url: base + "/api/poll?feed=other&_=1700000009999" }), x)).toMatchObject({ action: "abort" });
    expect(requestKey("POST", base + "/a?ts=123&cb=9&q=1")).toBe(requestKey("POST", base + "/a?q=1"));
  });
  it("never drops a parameter by its value alone: a long numeric id stays in the learned key", () => {
    expect(requestKey("POST", base + "/a?id=17000000000001")).not.toBe(requestKey("POST", base + "/a?id=17000000000002"));
    expect(requestKey("POST", base + "/a?order=17000000000001")).not.toBe(requestKey("POST", base + "/a"));
    // A cache-buster name with a value that isn't a timestamp or token is kept too.
    expect(requestKey("POST", base + "/a?t=delete")).not.toBe(requestKey("POST", base + "/a"));
  });
});

describe("unlabelled controls", () => {
  const x = () => ({ runner: create, cfg: cfg(), learned: new Set<string>(), baseHost: "staging.acme.dev" });
  it("a write right after a click with no words is blocked for a create runner", () => {
    expect(decide(req({ url: base + "/api/items/7/remove", clickWordless: true }), x())).toMatchObject({ action: "abort", category: "unknown-write" });
  });
  it("is allowed when it is about the run's own record", () => {
    const id = "3f2a6c1e-8b4d-4e7a-9c15-2d6b8e0f4a71";
    expect(decide(req({ url: `${base}/api/items/${id}`, clickWordless: true }), { ...x(), createdPaths: [`/items/${id}`] }).action).toBe("continue");
  });
  it("leaves sign-in and error-reporting calls alone, and doesn't apply without a click", () => {
    expect(decide(req({ url: "https://o1.ingest.us.sentry.io/api/1/envelope/", clickWordless: true }), x()).action).toBe("continue");
    expect(decide(req({ url: base + "/api/items/7/remove" }), x()).action).toBe("continue");
  });
});

describe("decide: DELETE and the run's own records", () => {
  const c0 = loadConfig(mkdtempSync(join(tmpdir(), "c-")));
  const ctx = (runner: typeof look = create) => ({ runner, cfg: c0, learned: new Set<string>(), baseHost: "staging.acme.dev" });
  it("DELETE needs the delete permission even on a create runner", () => {
    expect(decide({ method: "DELETE", url: "https://staging.acme.dev/api/x/1", loading: false }, ctx())).toMatchObject({ action: "abort", category: "delete" });
  });
  it("DELETE of something the run created is allowed", () => {
    const c = { ...ctx(), createdPaths: ["/api/orders/9"] };
    expect(decide({ method: "DELETE", url: "https://staging.acme.dev/api/orders/9", loading: false }, c).action).toBe("continue");
  });
  it("a delete-word click on the run's own draft is allowed, on anyone else's it is not", () => {
    const id = "3f2a6c1e-8b4d-4e7a-9c15-2d6b8e0f4a71";
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
    const id = "3f2a6c1e-8b4d-4e7a-9c15-2d6b8e0f4a71";
    const del = (created: string[], path: string) => decide({ method: "POST", url: `https://staging.acme.dev${path}`, loading: false, clickText: "Delete project" }, { ...ctx(), createdPaths: created });
    expect(del([`/projects/${id}/summary`], "/settings/summary")).toMatchObject({ action: "abort" });
    expect(del(["/projects"], "/projects/aaaaaaaa-0000-0000-0000-000000000000")).toMatchObject({ action: "abort" });
    expect(del([`/projects/${id}`], `/projects/${id}/..%2f..%2fusers%2f7`)).toMatchObject({ action: "abort" });
    expect(del([`/projects/${id}`], `/projects/${id}/a/b/c`)).toMatchObject({ action: "abort" });
    expect(del([`/projects/${id}`], `/projects/${id}/delete`)).toMatchObject({ action: "abort", category: "delete" });
  });
  it("a list page's delete-selected is ours only when every id it names is one the run created", () => {
    const mine = "3f2a6c1e-8b4d-4e7a-9c15-2d6b8e0f4a71", theirs = "aaaaaaaa-0000-4000-8000-000000000000";
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
    expect(at("https://example-app-1.clerk.accounts.dev/v1/environment?_method=PATCH").action).toBe("continue");
    expect(at("https://o1.ingest.us.sentry.io/api/1/envelope/").action).toBe("continue");
    // The app's own API on another host is still judged by the click.
    expect(at("https://api.acme.dev/projects/7")).toMatchObject({ action: "abort", category: "delete" });
    expect(at("https://unknown.example/delete-things")).toMatchObject({ action: "abort", category: "delete" });
    // A provider's other endpoints, and the site under test on such a domain, are still judged.
    expect(at("https://example-app-1.clerk.accounts.dev/v1/users/u_1")).toMatchObject({ action: "abort", category: "delete" });
    const onSentry = { ...ctx(), baseHost: "o1.ingest.sentry.io" };
    expect(decide({ method: "POST", url: "https://o1.ingest.sentry.io/api/1/envelope/", loading: false, clickText: "Delete project" }, onSentry)).toMatchObject({ action: "abort", category: "delete" });
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

describe("decide: read-only POST allowlist", () => {
  const ctx = { runner: newRunner("c", "c", { kind: "session" }), cfg: { ...cfg(), readPosts: ["/graphql"] }, learned: new Set<string>(), baseHost: "s.acme.dev" };
  it("allows a GraphQL query but not a mutation", () => {
    expect(decide({ method: "POST", url: "https://s.acme.dev/graphql", loading: false, body: JSON.stringify({ query: "query { me { id } }" }) }, ctx).action).toBe("continue");
    expect(decide({ method: "POST", url: "https://s.acme.dev/graphql", loading: false, body: JSON.stringify({ query: "mutation Save { save(id: 1) }" }) }, ctx)).toMatchObject({ action: "abort", category: "unknown-write" });
    expect(decide({ method: "POST", url: "https://s.acme.dev/graphql", loading: false, body: '{"operationName":"Save","query":"\\n  mutation Save { x }"}' }, ctx)).toMatchObject({ action: "abort" });
  });
});

describe("redactUrl", () => {
  it("redacts long token-like path segments", () => {
    expect(redactUrl("https://x.dev/reset-password/9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c")).toBe("/reset-password/[redacted]");
    expect(redactUrl("https://x.dev/orders/123/items")).toBe("/orders/123/items");
  });
});

describe("wsDecide", () => {
  const plain = () => loadConfig(mkdtempSync(join(tmpdir(), "ws-")));
  const wsCfg = { ...plain(), productionUrls: ["https://shop.acme.dev"] };
  const wsCreate = { ...newRunner("a", "a", { kind: "session" }), depth: "create" as const };
  const wsLook = newRunner("c", "c", { kind: "session" });
  const msg = (m: string, c = wsCfg) => wsDecide({ url: "wss://s.acme.dev/ws", loading: false, message: m }, { runner: wsCreate, cfg: c });

  it("never connects to production without live", () => {
    expect(wsDecide({ url: "wss://shop.acme.dev/live", loading: true }, { runner: wsCreate, cfg: wsCfg })).toMatchObject({ action: "abort", category: "live" });
  });
  it("blocks a create runner's message that carries a protected action", () => {
    expect(wsDecide({ url: "wss://staging.acme.dev/ws", loading: false, message: '{"event":"send invoice","id":3}' }, { runner: wsCreate, cfg: wsCfg })).toMatchObject({ action: "abort", category: "email" });
    expect(wsDecide({ url: "wss://staging.acme.dev/ws", loading: false, message: '{"event":"cart:update"}' }, { runner: wsCreate, cfg: wsCfg }).action).toBe("continue");
  });
  it("look-only: messages only while loading", () => {
    expect(wsDecide({ url: "wss://staging.acme.dev/ws", loading: true, message: "subscribe" }, { runner: wsLook, cfg: wsCfg }).action).toBe("continue");
    expect(wsDecide({ url: "wss://staging.acme.dev/ws", loading: false, message: "x" }, { runner: wsLook, cfg: wsCfg })).toMatchObject({ action: "abort", category: "unknown-write" });
  });
  it("sees protected words through JSON escapes, camelCase and snake_case", () => {
    for (const m of ['{"event":"send\\u0020invoice"}', '{"action":"sendInvoice"}', '{"action":"send_invoice"}', '{"op":"delete-user"}'])
      expect(msg(m).action, m).toBe("abort");
  });
  it("applies protected URL patterns when the socket opens", () => {
    const c = { ...wsCfg, productionUrls: [] as string[], patterns: { ...wsCfg.patterns, finance: { ...wsCfg.patterns.finance, urls: [...wsCfg.patterns.finance.urls, "/ws/payments"] } } };
    expect(wsDecide({ url: "wss://s.acme.dev/ws/payments", loading: true }, { runner: wsCreate, cfg: c })).toMatchObject({ action: "abort", category: "finance" });
  });
  it("matches hyphenated and camelCase protected words, raw or normalised, with any spacing", () => {
    const b = plain();
    const c = { ...b, patterns: { ...b.patterns, finance: { ...b.patterns.finance, words: [...b.patterns.finance.words, "top-up", "buyCredits"] } } };
    for (const m of ['{"op":"top-up"}', '{"op":"topUp"}', '{"op":"top   up"}', '{"op":"buy_credits"}', "action=top%2Dup&x=%ZZ"])
      expect(msg(m, c).action, m).toBe("abort");
  });
  it("percent-decodes around bad bytes and through double encoding", () => {
    for (const m of ["%FF%73end%20invoice", "send%2520invoice"]) expect(msg(m, plain()).action, m).toBe("abort");
  });
  it("decodes five layers of percent encoding", () => {
    let m = "send invoice";
    for (let i = 0; i < 5; i++) m = encodeURIComponent(m);
    expect(msg(m, plain()).action).toBe("abort");
  });
  it("fails closed when a message still has escapes after decoding", () => {
    let m = "send invoice";
    for (let i = 0; i < 25; i++) m = encodeURIComponent(m);
    expect(msg(m, plain())).toMatchObject({ action: "abort", category: "unknown-write" });
  });
  it("checks leftover escapes before camelCase splitting can break them apart", () => {
    let m = "%2D"; // "2D" is what camelCase splitting would break into "2 D"
    for (let i = 0; i < 25; i++) m = encodeURIComponent(m);
    expect(decodeMessage(m).undecodable).toBe(true);
    expect(decodeMessage("%73end").undecodable).toBe(false);
  });
});
