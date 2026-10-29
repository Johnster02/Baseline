// Per-command timings for a run, and `baseline timings`. The 14-minute run (spec 2.1) could not be
// explained from the outside; this is the evidence, and it must never record what was typed.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixture } from "./fixture-app/server";
import { openSession as rawOpenSession } from "../src/browser/session";
import { createDispatcher } from "../src/browser/dispatch";
import { readTimings, timingsFile } from "../src/run/timings";
import { trustRun } from "./helpers/trust";
import { loadConfig, newRunner } from "../src/config/store";
import { main } from "../src/cli";
import "../src/commands";

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
const runner = newRunner("customer", "customer", { kind: "session" });

/** Drive the real dispatcher, which is the layer every agent script goes through. */
async function withDispatcher(fn: (call: (method: string, ...args: unknown[]) => Promise<{ ok: boolean }>) => Promise<void>): Promise<string> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "run-")));
  const cfg = loadConfig(dir);
  mkdirSync(join(dir, "logs"), { recursive: true });
  const d = createDispatcher({
    runDir: dir,
    openSession: () => openSession({ runDir: dir, runId: "r-1", runner, cfg, baseUrl: f.url, storageState: state }),
    info: { runner: runner.key, persona: runner.persona, depth: runner.depth },
    keepOnClose: false,
  });
  let id = 0;
  const call = (method: string, ...args: unknown[]) => d.handle({ id: ++id, method, args });
  try {
    await call("open");
    await fn(call);
  } finally { await d.close(); }
  return dir;
}

describe("what each browser command cost", () => {
  it("records one line per command, with no argument values", async () => {
    const dir = await withDispatcher(async (call) => {
      await call("goto", "/cart");
      await call("fill", { label: "Discount code" }, "someone@example.test");
    });
    const lines = readTimings(dir);
    expect(lines.map((l) => l.method)).toEqual(["open", "goto", "fill"]);
    expect(lines.every((l) => l.ok)).toBe(true);
    expect(lines.every((l) => typeof l.ms === "number" && l.ms >= 0)).toBe(true);
    expect(lines.every((l) => l.runner === "customer")).toBe(true);
    // A fill's argument is a value typed into someone's site. It is never recorded.
    expect(JSON.stringify(lines)).not.toContain("someone@example.test");
    expect(JSON.stringify(lines)).not.toContain("Discount code");
  }, 30000);

  it("records a command that failed, so a timeout is visible as time spent", async () => {
    const dir = await withDispatcher(async (call) => {
      await call("goto", "/cart");
      const r = await call("waitFor", { text: "nothing like this is on the page" }, { timeout: 1000 });
      expect(r.ok).toBe(false);
    });
    const last = readTimings(dir).at(-1)!;
    expect(last).toMatchObject({ method: "waitFor", ok: false });
    expect(last.ms).toBeGreaterThanOrEqual(900);
  }, 30000);
});

describe("baseline timings", () => {
  let out = "";
  const write = (dir: string, rows: object[]) => {
    mkdirSync(join(dir, "logs"), { recursive: true });
    writeFileSync(timingsFile(dir, "customer"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  };

  it("names the slowest commands and what timeouts cost", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "run-")));
    write(dir, [
      { at: "2026-10-29T12:00:00.000Z", runner: "customer", method: "click", ms: 120, ok: true },
      { at: "2026-10-29T12:00:01.000Z", runner: "customer", method: "waitFor", ms: 8000, ok: false },
      { at: "2026-10-29T12:00:02.000Z", runner: "customer", method: "snapshot", ms: 40, ok: true },
    ]);
    out = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: any) => { out += String(s); return true; });
    try { expect(await main(["timings", "--run", dir])).toBe(0); } finally { spy.mockRestore(); }
    expect(out).toMatch(/waitFor/);
    expect(out).toMatch(/8\.0s|8000/);
    expect(out).toMatch(/1 (command )?timed out|1 failed/i);
    expect(out).toMatch(/8\.2s|8160/);
  });

  it("says so plainly when a run recorded no timings", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "run-")));
    out = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: any) => { out += String(s); return true; });
    try { expect(await main(["timings", "--run", dir])).toBe(0); } finally { spy.mockRestore(); }
    expect(out).toMatch(/no timings/i);
  });
});
