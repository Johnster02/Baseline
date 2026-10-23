// Every allowed command reaches the Session method it names, with its arguments.
import { describe, it, expect } from "vitest";
import { createDispatcher, MAX_WAIT_MS } from "../src/browser/dispatch";
import { COMMANDS } from "../src/browser/rpc";
import type { Session } from "../src/browser/session";

function fakeSession() {
  const calls: [string, unknown[]][] = [];
  let closed = 0;
  const s = new Proxy({} as Record<string, unknown>, {
    // Not a thenable: `await openSession()` must resolve to the session itself.
    get: (_t, k: string) => k === "then" ? undefined : k === "close" ? async () => { closed++; } : async (...a: unknown[]) => { calls.push([k, a]); return `${k}-result`; },
  }) as unknown as Session;
  return { s, calls, closed: () => closed };
}

const info = { runner: "customer", persona: "customer", depth: "look" };
let id = 0;
const req = (method: string, ...args: unknown[]) => ({ id: ++id, method, args });

describe("createDispatcher", () => {
  it("maps every command to its Session method", async () => {
    const f = fakeSession();
    const d = createDispatcher({ openSession: async () => f.s, info, keepOnClose: true });
    expect(await d.handle(req("open"))).toMatchObject({ ok: true, value: info });
    const t = { role: "button", name: "Go" };
    const cases: [string, unknown[], unknown[]][] = [
      ["goto", ["/cart"], ["/cart"]],
      ["click", [t], [t]],
      ["fill", [t, "x"], [t, "x"]],
      ["press", ["Enter"], ["Enter", undefined]],
      ["press", ["Enter", t], ["Enter", t]],
      ["select", [t, "a"], [t, "a"]],
      ["check", [t], [t]],
      ["hover", [t], [t]],
      ["back", [], []],
      ["snapshot", [], []],
      ["text", [], [undefined]],
      ["text", [t], [t]],
      ["url", [], []],
      ["title", [], []],
      ["shot", ["cart", "Cart"], ["cart", "Cart"]],
      ["created", ["order", "Baseline r-1 order"], ["order", "Baseline r-1 order", undefined]],
      ["created", ["order", "Baseline r-1 order", "/orders/1"], ["order", "Baseline r-1 order", "/orders/1"]],
    ];
    for (const [method, args, expected] of cases) {
      f.calls.length = 0;
      expect(await d.handle(req(method, ...args)), method).toMatchObject({ ok: true, value: `${method}-result` });
      expect(f.calls, method).toEqual([[method, expected]]);
    }
    const covered = new Set(cases.map((c) => c[0]).concat(["open", "close", "waitFor"]));
    expect(COMMANDS.filter((c) => !covered.has(c))).toEqual([]);
  });
  it("clamps waitFor timeouts: 0 and huge become the max, small ones pass through", async () => {
    const f = fakeSession();
    const d = createDispatcher({ openSession: async () => f.s, info, keepOnClose: true });
    await d.handle(req("open"));
    const t = { text: "Done" };
    for (const [opts, expected] of [
      [{ timeout: 0 }, { timeout: MAX_WAIT_MS }],
      [{ timeout: 10 ** 9 }, { timeout: MAX_WAIT_MS }],
      [{ timeout: 500, state: "hidden" }, { state: "hidden", timeout: 500 }],
      [{ timeout: "soon" }, { timeout: MAX_WAIT_MS }],
      [{}, {}],
      [undefined, undefined],
    ] as const) {
      f.calls.length = 0;
      await d.handle(req("waitFor", t, opts));
      expect(f.calls[0]?.[1], JSON.stringify(opts)).toEqual([t, expected]);
    }
  });
  it("refuses commands before open and unknown methods", async () => {
    const d = createDispatcher({ openSession: async () => fakeSession().s, info, keepOnClose: true });
    expect(await d.handle(req("goto", "/"))).toMatchObject({ ok: false, error: "call open() first" });
    expect(await d.handle(req("evaluate", "1"))).toMatchObject({ ok: false, error: expect.stringMatching(/not an allowed command/) });
  });
  it("a script's close keeps the host's browser but closes the fallback's", async () => {
    const host = fakeSession();
    const h = createDispatcher({ openSession: async () => host.s, info, keepOnClose: true });
    await h.handle(req("open"));
    await h.handle(req("close"));
    expect(host.closed()).toBe(0);
    expect(await h.handle(req("url"))).toMatchObject({ ok: true });
    await h.close();
    expect(host.closed()).toBe(1);

    const own = fakeSession();
    const o = createDispatcher({ openSession: async () => own.s, info, keepOnClose: false });
    await o.handle(req("open"));
    await o.handle(req("close"));
    expect(own.closed()).toBe(1);
    expect(await o.handle(req("url"))).toMatchObject({ ok: false, error: "call open() first" });
  });
  it("reports errors by name, first line only, and tells the host about sign-outs", async () => {
    const signedOut: string[] = [];
    const s = { goto: async () => { const e = new Error("landed on /login\nstack"); e.name = "SignedOutError"; throw e; }, close: async () => {} } as unknown as Session;
    const d = createDispatcher({ openSession: async () => s, info, keepOnClose: true, onSignedOut: (m) => signedOut.push(m) });
    await d.handle(req("open"));
    expect(await d.handle(req("goto", "/admin"))).toMatchObject({ ok: false, error: "SignedOutError: landed on /login" });
    expect(signedOut).toHaveLength(1);
  });
  it("runs commands one at a time, in order", async () => {
    const order: string[] = [];
    const s = {
      goto: async () => { await new Promise((r) => setImmediate(r)); order.push("goto"); },
      url: async () => { order.push("url"); return "u"; },
      close: async () => {},
    } as unknown as Session;
    const d = createDispatcher({ openSession: async () => s, info, keepOnClose: true });
    await d.handle(req("open"));
    await Promise.all([d.handle(req("goto", "/")), d.handle(req("url"))]);
    expect(order).toEqual(["goto", "url"]);
  });
});
