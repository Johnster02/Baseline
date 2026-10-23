import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OwnedTracker, LANDING_WINDOW_MS } from "../src/browser/owned";

const SITE = "https://app.example.test";
const NEW_ID = "f764b3d9-2ed5-4d46-af8f-63171fd88b4c";
const OLD_ID = "15f1b5d3-9d93-46bb-bdcc-9dc439525f60";

describe("OwnedTracker", () => {
  it("owns a new id the site's reply sends the browser to right after a write", () => {
    const t = new OwnedTracker();
    t.wrote(1000);
    t.seeText(`/orders/${NEW_ID}/edit`);
    expect(t.landed(`${SITE}/orders/${NEW_ID}/edit`, 1500)).toBe(`/orders/${NEW_ID}`);
    expect(t.paths).toEqual([`/orders/${NEW_ID}`]);
  });

  it("owns an id named only in a write's reply headers (a framework redirect header)", () => {
    const t = new OwnedTracker();
    t.wrote(1000);
    t.seeText(["text/x-component", `/projects/${NEW_ID}?brief=new;push`].join("\n"));
    t.seeUrl(`${SITE}/projects/${NEW_ID}?brief=new`);
    expect(t.landed(`${SITE}/projects/${NEW_ID}?brief=new`, 1400)).toBe(`/projects/${NEW_ID}`);
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
    const file = join(mkdtempSync(join(tmpdir(), "owned-")), "owned.json");
    const a = new OwnedTracker(file);
    a.add("/orders/" + NEW_ID);
    const b = new OwnedTracker(file);
    expect(b.paths).toContain("/orders/" + NEW_ID);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(["/orders/" + NEW_ID]);
  });
});
