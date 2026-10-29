import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OwnedTracker, LANDING_WINDOW_MS, isPlaceholderUrl } from "../src/browser/owned";

const SITE = "https://app.example.test";
const NEW_ID = "7c9e1b42-5a3f-4d68-b2e1-9f0a6c3d8e25";
const OLD_ID = "3f2a6c1e-8b4d-4e7a-9c15-2d6b8e0f4a71";

describe("OwnedTracker", () => {
  it("owns a new id the site's reply sends the browser to right after a write", () => {
    const t = new OwnedTracker();
    t.wrote(1000);
    t.seeText(`/orders/${NEW_ID}/edit`);
    expect(t.landed(`${SITE}/orders/${NEW_ID}/edit`, 1500)).toBe(`/orders/${NEW_ID}`);
    expect(t.paths).toEqual([`/orders/${NEW_ID}`]);
  });

  it("still owns a new record when the browser then loads its page (the real sequence)", () => {
    const t = new OwnedTracker();
    t.wrote(1000, t.seeRequest(`${SITE}/home`, '["new project"]'));
    t.seeReplyPath(`/projects/${NEW_ID}`);
    t.seeRequest(`${SITE}/projects/${NEW_ID}?brief=new`, undefined, false);
    expect(t.landed(`${SITE}/projects/${NEW_ID}?brief=new`, 1300)).toBe(`/projects/${NEW_ID}`);
  });

  it("a page load is only 'following the reply' at the exact redirect target, and its query still counts", () => {
    const t = new OwnedTracker();
    t.wrote(1000, t.seeRequest(`${SITE}/orders`, "{}"));
    t.seeReplyPath(`/orders/${NEW_ID}`);
    // Same path, but a disguised other id in the query: the query goes in the sent log.
    t.seeRequest(`${SITE}/orders/${NEW_ID}?also=${OLD_ID.replace(/-/g, "")}`, undefined, false);
    expect(t.landed(`${SITE}/orders/${NEW_ID}`, 1200)).toBe(`/orders/${NEW_ID}`);
    t.wrote(1300, t.seeRequest(`${SITE}/orders`, "{}"));
    t.seeReplyPath(`/orders/${OLD_ID}`);
    expect(t.landed(`${SITE}/orders/${OLD_ID}`, 1400)).toBeUndefined();
  });

  it("a page load that can't be decoded blocks ownership for the window", () => {
    const t = new OwnedTracker();
    t.wrote(1000, t.seeRequest(`${SITE}/orders`, "{}"));
    t.markUnclear(1050);
    t.seeReplyPath(`/orders/${NEW_ID}`);
    expect(t.landed(`${SITE}/orders/${NEW_ID}`, 1200)).toBeUndefined();
  });

  it("owns an id named only in a write's reply headers (a framework redirect header)", () => {
    const t = new OwnedTracker();
    t.wrote(1000);
    t.seeReplyPath(`/projects/${NEW_ID}`);
    t.seeUrl(`${SITE}/projects/${NEW_ID}?brief=new`);
    expect(t.landed(`${SITE}/projects/${NEW_ID}?brief=new`, 1400)).toBe(`/projects/${NEW_ID}`);
  });

  it("never owns an id the write itself named, even when the reply redirects to it", () => {
    const t = new OwnedTracker();
    t.seeRequest(`${SITE}/orders/copy?from=${OLD_ID}`, JSON.stringify({ source: OLD_ID }));
    t.wrote(1000);
    t.seeReplyPath(`/orders/${OLD_ID}`);
    expect(t.landed(`${SITE}/orders/${OLD_ID}`, 1200)).toBeUndefined();
  });

  it("catches ids a write hides by encoding, escaping or gluing them to text", () => {
    const hidden = [
      { url: `${SITE}/orders/copy`, body: `from=${encodeURIComponent(OLD_ID).replace(/-/g, "%2D")}` },
      { url: `${SITE}/orders/copy`, body: JSON.stringify({ s: OLD_ID }).replace(/-/g, "\\u002d") },
      { url: `${SITE}/orders/copy?x=ref${OLD_ID}tail`, body: undefined },
    ];
    for (const h of hidden) {
      const t = new OwnedTracker();
      t.wrote(1000, t.seeRequest(h.url, h.body));
      t.seeReplyPath(`/orders/${OLD_ID}`);
      expect(t.landed(`${SITE}/orders/${OLD_ID}`, 1200)).toBeUndefined();
    }
  });

  it("an id sent in any disguise never counts as created", () => {
    const disguises = [
      OLD_ID.replace(/-/g, ""),
      encodeURIComponent(encodeURIComponent(OLD_ID)),
      OLD_ID.replace(/-/g, "&#45;"),
      OLD_ID.toUpperCase().replace(/1/g, "I"),
    ];
    for (const d of disguises) {
      const t = new OwnedTracker();
      t.wrote(1000, t.seeRequest(`${SITE}/orders/copy`, `ref=${d}`));
      t.seeReplyPath(`/orders/${OLD_ID}`);
      expect(t.landed(`${SITE}/orders/${OLD_ID}`, 1200)).toBeUndefined();
    }
  });

  it("an id the agent loaded in a page before never counts, even if a reply names it later", () => {
    const t = new OwnedTracker();
    t.seeRequest(`${SITE}/search?q=${OLD_ID.replace(/-/g, "")}`, undefined, false);
    t.wrote(1000, t.seeRequest(`${SITE}/orders/new`, "{}"));
    t.seeReplyPath(`/orders/${OLD_ID}`);
    expect(t.landed(`${SITE}/orders/${OLD_ID}`, 1200)).toBeUndefined();
  });

  it("a write still encoded after five rounds of decoding is unclear", () => {
    let deep = OLD_ID;
    for (let i = 0; i < 7; i++) deep = encodeURIComponent(deep).replace(/-/g, "%2D");
    const t = new OwnedTracker();
    expect(t.seeRequest(`${SITE}/orders/copy`, `ref=${deep}`)).toBe(false);
  });

  it("an unclear write keeps blocking for its whole window, even after a clean one", () => {
    const t = new OwnedTracker();
    t.wrote(1000, t.seeRequest(`${SITE}/orders/new`, "%E0%A4%A"));
    t.wrote(1100, t.seeRequest(`${SITE}/orders/new`, "{}"));
    t.seeReplyPath(`/orders/${NEW_ID}`);
    expect(t.landed(`${SITE}/orders/${NEW_ID}`, 1200)).toBeUndefined();
  });

  it("a write it can't decode makes nothing after it count as created", () => {
    const t = new OwnedTracker();
    t.wrote(1000, t.seeRequest(`${SITE}/orders/new`, "%E0%A4%A"));
    t.seeReplyPath(`/orders/${NEW_ID}`);
    expect(t.landed(`${SITE}/orders/${NEW_ID}`, 1200)).toBeUndefined();
  });

  it("never owns an id that was on a page before the write", () => {
    const t = new OwnedTracker();
    t.seeText(`<a href="/orders/${OLD_ID}">Someone's order</a>`);
    t.wrote(1000);
    expect(t.landed(`${SITE}/orders/${OLD_ID}`, 1200)).toBeUndefined();
  });

  it("never owns an id from the write's own URL (saving an existing record)", () => {
    const t = new OwnedTracker();
    t.seeUrl(`${SITE}/orders/${OLD_ID}/rename`);
    t.wrote(1000);
    expect(t.landed(`${SITE}/orders/${OLD_ID}`, 1100)).toBeUndefined();
  });

  it("owns an id that first appears in the write's response", () => {
    const t = new OwnedTracker();
    t.wrote(1000);
    t.seeText(`{"id":"${NEW_ID}"}`);
    expect(t.landed(`${SITE}/orders/${NEW_ID}`, 1300)).toBe(`/orders/${NEW_ID}`);
  });

  it("needs a recent write and a real id", () => {
    const t = new OwnedTracker();
    expect(t.landed(`${SITE}/orders/${NEW_ID}`, 1000)).toBeUndefined();
    t.wrote(1000);
    expect(t.landed(`${SITE}/orders/summary`, 1100)).toBeUndefined();
    const late = new OwnedTracker();
    late.wrote(1000);
    late.seeText(NEW_ID);
    expect(late.landed(`${SITE}/orders/${NEW_ID}`, 1000 + LANDING_WINDOW_MS + 1)).toBeUndefined();
  });

  it("knowing an id and going to it never makes it ours", () => {
    const t = new OwnedTracker();
    t.wrote(1000);
    // The agent opens someone's record by an id it was told: only the URL ever named it.
    t.seeUrl(`${SITE}/orders/${OLD_ID}`);
    expect(t.landed(`${SITE}/orders/${OLD_ID}`, 1100)).toBeUndefined();
    // Even if that page's reply then mentions the id, it was seen in the URL first.
    t.seeText(OLD_ID);
    expect(t.landed(`${SITE}/orders/${OLD_ID}`, 1200)).toBeUndefined();
    // And a page the agent opened itself never counts.
    const u = new OwnedTracker();
    u.wrote(1000);
    u.seeText(NEW_ID);
    expect(u.landed(`${SITE}/orders/${NEW_ID}`, 1100, true)).toBeUndefined();
  });

  it("shares what it owns with other runners through its file", () => {
    const file = join(realpathSync(mkdtempSync(join(tmpdir(), "owned-"))), "owned.jsonl");
    const a = new OwnedTracker(file);
    a.add("/orders/" + NEW_ID);
    const b = new OwnedTracker(file);
    expect(b.paths).toContain("/orders/" + NEW_ID);
    expect(readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l))).toEqual(["/orders/" + NEW_ID]);
  });

  it("two runners adding at the same time never lose each other's records (append-only)", () => {
    const file = join(realpathSync(mkdtempSync(join(tmpdir(), "owned-"))), "owned.jsonl");
    const a = new OwnedTracker(file), b = new OwnedTracker(file);
    // Both opened before either wrote: a read-merge-write would let the second write drop the first.
    a.add("/orders/" + NEW_ID);
    b.add("/orders/01ARZ3NDEKTSV4RRFFQ69G5FAV");
    const c = new OwnedTracker(file);
    expect(c.paths.sort()).toEqual(["/orders/" + NEW_ID, "/orders/01ARZ3NDEKTSV4RRFFQ69G5FAV"].sort());
  });
});

describe("OwnedTracker across runners and client-side routes", () => {
  it("a tracker opened earlier sees records another runner's tracker added later", () => {
    const file = join(realpathSync(mkdtempSync(join(tmpdir(), "owned-"))), "owned.jsonl");
    const early = new OwnedTracker(file);
    expect(early.paths).toEqual([]);
    new OwnedTracker(file).add("/orders/" + NEW_ID);
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later); // a different mtime, without waiting for the clock
    early.refresh();
    expect(early.paths).toContain("/orders/" + NEW_ID);
  });

  it("a client-side landing after a later click (a row in a refreshed list) is not ours", () => {
    const t = new OwnedTracker();
    t.clicked();
    t.wrote(1000);
    t.seeText(NEW_ID);
    t.clicked(); // the agent clicks a row the list now shows
    expect(t.landed(`${SITE}/orders/${NEW_ID}`, 1200, false, { document: false })).toBeUndefined();
  });

  it("a client-side landing straight after the write, or at the reply's redirect target, is ours", () => {
    const a = new OwnedTracker();
    a.clicked();
    a.wrote(1000);
    a.seeText(NEW_ID);
    expect(a.landed(`${SITE}/orders/${NEW_ID}`, 1200, false, { document: false })).toBe(`/orders/${NEW_ID}`);
    const b = new OwnedTracker();
    b.wrote(1000);
    b.seeReplyPath(`/orders/${NEW_ID}`);
    b.clicked();
    expect(b.landed(`${SITE}/orders/${NEW_ID}`, 1200, false, { document: false })).toBe(`/orders/${NEW_ID}`);
  });
});

describe("telling a template apart from a real address (review M-1)", () => {
  it("treats framework templates as placeholders", () => {
    for (const u of ["/projects/<id>", "/projects/{id}", "/projects/:id", "/projects/*",
      "/projects/[id]", "/posts/[...slug]", "/projects/${id}", "/projects/%7Bid%7D"]) {
      expect(isPlaceholderUrl(u), u).toBe(true);
    }
  });

  it("keeps a genuine address whose query string uses brackets or dollars", () => {
    // Dropping these left a record the runner really created with no address at all.
    for (const u of [
      "/articles?filter[status]=published",
      "/orders?ids[]=1&ids[]=2",
      "/api/v1/items?$top=10&$select=name",
      "/odata/$metadata",
      "/files/a$b.txt",
      "/notes/cost-%24100-report",
      "/t/%5Bdraft%5D-notes",
      // A bare $segment is ambiguous — /odata/$metadata is real — so it is kept. `confirmed`
      // is what stops the cleaner acting on an address Baseline did not watch being created.
      "/projects/$id",
      "/orders/7",
      "/drafts/4b1e7a90-2c6d-4f83-9a51-7e0d3b8c6f12",
    ]) expect(isPlaceholderUrl(u), u).toBe(false);
  });
});
