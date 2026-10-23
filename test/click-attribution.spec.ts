import { describe, it, expect } from "vitest";
import { ClickAttribution, CLICK_WINDOW_MS } from "../src/browser/click-attribution";
import { decide } from "../src/browser/guard";
import { loadConfig, newRunner } from "../src/config/store";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const clock = () => { let t = 1000; return { now: () => t, tick: (ms: number) => { t += ms; } }; };
const cfg = loadConfig(mkdtempSync(join(tmpdir(), "ca-")));
const create = { ...newRunner("c", "customer", { kind: "session" }), depth: "create" as const };
const ctx = { runner: create, cfg, learned: new Set<string>(), baseHost: "staging.acme.dev" };
const base = "https://staging.acme.dev";

/** What the session does for one same-site write: view the clicks, decide, record the outcome. */
function write(c: ClickAttribution, path: string) {
  const v = c.view();
  const d = decide({ method: "POST", url: base + path, loading: false, clickText: v.text, clickWordless: v.wordless }, ctx);
  c.decided(v, d.action === "continue");
  return d;
}

describe("ClickAttribution", () => {
  it("a telemetry call the click's words block doesn't end the click: the real delete after a route change is still judged", () => {
    const k = clock();
    const c = new ClickAttribution(k.now);
    c.record("Delete project");
    expect(write(c, "/api/telemetry")).toMatchObject({ action: "abort", category: "delete" });
    k.tick(50);
    c.navigated(); // router.push
    expect(write(c, "/api/items/7/remove")).toMatchObject({ action: "abort", category: "delete" });
  });

  it("an allowed write ends its click at the next navigation, so the new page's requests are its own", () => {
    const k = clock();
    const c = new ClickAttribution(k.now);
    c.record("Save");
    expect(write(c, "/api/items").action).toBe("continue");
    c.navigated();
    expect(c.view().text).toBeUndefined();
  });

  it("a click whose write hasn't gone out stays live across a route change", () => {
    const k = clock();
    const c = new ClickAttribution(k.now);
    c.record("Delete project");
    c.navigated();
    expect(c.view().text).toBe("Delete project");
  });

  it("a click made after the write was decided is not judged by it", () => {
    const k = clock();
    const c = new ClickAttribution(k.now);
    c.record("Save");
    const v = c.view();
    k.tick(10);
    c.record("Delete");
    c.decided(v, true);
    c.navigated();
    expect(c.view().text).toBe("Delete");
  });

  it("clicks expire after the window", () => {
    const k = clock();
    const c = new ClickAttribution(k.now);
    c.record("Delete project");
    k.tick(CLICK_WINDOW_MS + 1);
    expect(c.view()).toMatchObject({ text: undefined, wordless: false });
  });

  it("a click with no words is reported as wordless, and its write is blocked", () => {
    const c = new ClickAttribution(clock().now);
    c.record("  ");
    expect(c.view().wordless).toBe(true);
    expect(write(c, "/api/items/7/remove")).toMatchObject({ action: "abort", category: "unknown-write" });
  });

  it("waits once for a late click binding", async () => {
    const k = clock();
    const c = new ClickAttribution(k.now);
    const v = await c.viewForWrite(async (ms) => { k.tick(ms); c.record("Send invoice"); });
    expect(v.text).toBe("Send invoice");
  });
});
