// `s.created()`: what a run says it made, and how much of that Baseline will vouch for. The
// cleaner navigates from these entries, so a placeholder address here sends it to the wrong
// record (spec 3.7).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DRAFT_ID, startFixture } from "./fixture-app/server";
import { openSession as rawOpenSession, type Session } from "../src/browser/session";
import { readCreated } from "../src/browser/owned";
import { trustRun } from "./helpers/trust";
import { loadConfig, newRunner } from "../src/config/store";

let f: Awaited<ReturnType<typeof startFixture>>;
let state: string;

beforeAll(async () => {
  process.env.BASELINE_DATA = realpathSync(mkdtempSync(join(tmpdir(), "data-")));
  f = await startFixture();
  state = join(realpathSync(mkdtempSync(join(tmpdir(), "st-"))), "state.json");
  const host = new URL(f.url).hostname;
  writeFileSync(state, JSON.stringify({ cookies: [{ name: "sid", value: "ok", domain: host, path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] }));
});
afterAll(() => f.stop());

const openSession: typeof rawOpenSession = (o) => { trustRun(o); return rawOpenSession(o); };
const runner = { ...newRunner("customer", "customer", { kind: "session" }), depth: "create" as const };

async function withSession(fn: (s: Session, dir: string) => Promise<void>): Promise<string> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "run-")));
  const cfg = loadConfig(dir);
  const s = await openSession({ runDir: dir, runId: "r-1", runner, cfg, baseUrl: f.url, storageState: state });
  try { await fn(s, dir); } finally { await s.close(); }
  return dir;
}

const last = (dir: string) => readCreated(dir).at(-1)!;

describe("recording what a run created", () => {
  it("records the page the browser is actually on when no url is given", async () => {
    const dir = await withSession(async (s) => {
      await s.goto("/cart");
      s.created("order", "Baseline r-1 order");
    });
    expect(last(dir)).toMatchObject({ pageUrl: `${f.url}/cart`, url: "/cart", labelled: true });
  }, 30000);

  it("keeps a record whose url is on another site, without trusting the address (I6)", async () => {
    // Throwing lost the record entirely, so the cleaner never heard about something the runner
    // really did create. Keep it, and mark the address unusable.
    const dir = await withSession(async (s) => {
      await s.goto("/cart");
      s.created("order", "Baseline r-1 order", "https://evil.test/orders/1");
    });
    expect(readCreated(dir)).toHaveLength(1);
    expect(last(dir)).toMatchObject({ urlUnusable: true, confirmed: false, pageUrl: `${f.url}/cart` });
    expect(last(dir).url).toBeUndefined();
  }, 30000);

  it("treats framework-style placeholders as unusable too (minor 4)", async () => {
    const dir = await withSession(async (s) => {
      await s.goto("/cart");
      for (const bad of ["/projects/[id]", "/projects/$id", "/projects/${id}", "/projects/%7Bid%7D"]) {
        s.created("project", "Baseline r-1 project", bad);
      }
    });
    for (const e of readCreated(dir)) {
      expect(e.urlUnusable, JSON.stringify(e)).toBe(true);
      expect(e.url).toBeUndefined();
    }
  }, 30000);

  it("stores a placeholder url as unusable rather than as an address", async () => {
    const dir = await withSession(async (s) => {
      await s.goto("/cart");
      for (const bad of ["/projects/<id>", "/projects/{id}", "/projects/:id", "/projects/*"]) {
        s.created("project", "Baseline r-1 project", bad);
      }
    });
    for (const e of readCreated(dir)) {
      expect(e.urlUnusable).toBe(true);
      expect(e.url).toBeUndefined();
      // The real page is still recorded, so the cleaner has somewhere to go.
      expect(e.pageUrl).toBe(`${f.url}/cart`);
    }
  }, 30000);

  it("keeps a real same-site url, relative or absolute", async () => {
    const dir = await withSession(async (s) => {
      await s.goto("/cart");
      s.created("order", "Baseline r-1 order", "/orders/7");
      s.created("order", "Baseline r-1 order two", `${f.url}/orders/8`);
    });
    const [a, b] = readCreated(dir);
    expect(a).toMatchObject({ url: "/orders/7", urlUnusable: false });
    expect(b).toMatchObject({ url: "/orders/8", urlUnusable: false });
  }, 30000);

  it("marks an entry confirmed only when the browser independently owns that path", async () => {
    const dir = await withSession(async (s) => {
      await s.goto("/cart");
      s.created("order", "Baseline r-1 order", "/orders/7");
    });
    // Nothing was created through a write the guard watched, so nothing is confirmed.
    expect(last(dir).confirmed).toBe(false);
  }, 30000);

  it("a label that does not start with the run id is recorded as unlabelled", async () => {
    const dir = await withSession(async (s) => {
      await s.goto("/cart");
      s.created("order", "My test order");
    });
    expect(last(dir).labelled).toBe(false);
  }, 30000);
});

describe("confirming a record against what the browser saw", () => {
  it("a record the site reported with 201 and a Location is confirmed", async () => {
    const dir = await withSession(async (s) => {
      await s.goto("/drafts");
      await s.click({ role: "button", name: "Create draft" });
      await s.waitFor({ text: "done 201" });
      s.created("draft", "Baseline r-1 draft", `/drafts/${DRAFT_ID}`);
    });
    expect(last(dir)).toMatchObject({ url: `/drafts/${DRAFT_ID}`, confirmed: true });
  }, 30000);

  it("a different path on the same site is not confirmed, even next to a real one", async () => {
    const dir = await withSession(async (s) => {
      await s.goto("/drafts");
      await s.click({ role: "button", name: "Create draft" });
      await s.waitFor({ text: "done 201" });
      s.created("draft", "Baseline r-1 someone else's draft", "/drafts/00000000-0000-4000-8000-000000000000");
    });
    expect(last(dir).confirmed).toBe(false);
  }, 30000);
});
