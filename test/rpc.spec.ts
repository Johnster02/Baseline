import { describe, it, expect } from "vitest";
import { parseRequest, parseReply } from "../src/browser/rpc";
import { createDispatcher, MAX_WAIT_MS } from "../src/browser/dispatch";
import type { Session } from "../src/browser/session";

describe("rpc message checks", () => {
  it("accepts a well-formed request and defaults args", () => {
    expect(parseRequest({ id: 1, method: "goto", args: ["/x"] })).toEqual({ id: 1, method: "goto", args: ["/x"] });
    expect(parseRequest({ id: 2, method: "url" })).toEqual({ id: 2, method: "url", args: [] });
  });
  it("rejects malformed requests", () => {
    for (const m of [null, "x", 5, {}, { id: "1", method: "url" }, { id: Infinity, method: "url" }, { id: 1, method: "url", args: "nope" }]) {
      expect(parseRequest(m)).toBeUndefined();
    }
  });
  it("checks replies", () => {
    expect(parseReply({ id: 1, ok: true, value: 3 })).toEqual({ id: 1, ok: true, value: 3 });
    expect(parseReply({ id: 1 })).toBeUndefined();
  });
});

function fakeSession() {
  const calls: { method: string; args: unknown[] }[] = [];
  let closed = 0;
  const rec = (method: string) => async (...args: unknown[]) => { calls.push({ method, args }); return method; };
  const s = new Proxy({}, { get: (_t, k: string) => (k === "then" ? undefined : k === "close" ? async () => { closed++; } : rec(k)) }) as unknown as Session;
  return { s, calls, closed: () => closed };
}

describe("dispatcher", () => {
  const info = { runner: "c", persona: "customer", depth: "look" };

  it("refuses unknown methods by name, and anything before open()", async () => {
    const f = fakeSession();
    const d = createDispatcher({ openSession: async () => f.s, info, keepOnClose: false });
    expect(await d.handle({ id: 1, method: "evaluate", args: [] })).toEqual({ id: 1, ok: false, error: '"evaluate" is not an allowed command' });
    expect(await d.handle({ id: 2, method: "url", args: [] })).toMatchObject({ id: 2, ok: false, error: "call open() first" });
    expect(await d.handle({ id: 3, method: "open", args: [] })).toEqual({ id: 3, ok: true, value: info });
    expect(await d.handle({ id: 4, method: "url", args: [] })).toEqual({ id: 4, ok: true, value: "url" });
  });

  it("clamps a wait-forever timeout", async () => {
    const f = fakeSession();
    const d = createDispatcher({ openSession: async () => f.s, info, keepOnClose: false });
    await d.handle({ id: 1, method: "open", args: [] });
    await d.handle({ id: 2, method: "waitFor", args: [{ text: "x" }, { timeout: 0 }] });
    await d.handle({ id: 3, method: "waitFor", args: [{ text: "x" }, { timeout: 10 ** 9, state: "hidden" }] });
    await d.handle({ id: 4, method: "waitFor", args: [{ text: "x" }, { timeout: 500 }] });
    expect(f.calls.map((c) => c.args[1])).toEqual([{ timeout: MAX_WAIT_MS }, { state: "hidden", timeout: MAX_WAIT_MS }, { timeout: 500 }]);
  });

  it("close keeps the browser for a host and closes it otherwise", async () => {
    const kept = fakeSession();
    const host = createDispatcher({ openSession: async () => kept.s, info, keepOnClose: true });
    await host.handle({ id: 1, method: "open", args: [] });
    await host.handle({ id: 2, method: "close", args: [] });
    expect(kept.closed()).toBe(0);
    const own = fakeSession();
    const solo = createDispatcher({ openSession: async () => own.s, info, keepOnClose: false });
    await solo.handle({ id: 1, method: "open", args: [] });
    await solo.handle({ id: 2, method: "close", args: [] });
    expect(own.closed()).toBe(1);
  });

  it("reports a signed-out runner", async () => {
    const seen: string[] = [];
    const s = { goto: async () => { const e = new Error("signed out at /login"); e.name = "SignedOutError"; throw e; }, close: async () => {} } as unknown as Session;
    const d = createDispatcher({ openSession: async () => s, info, keepOnClose: false, onSignedOut: (m) => seen.push(m) });
    await d.handle({ id: 1, method: "open", args: [] });
    expect(await d.handle({ id: 2, method: "goto", args: ["/"] })).toEqual({ id: 2, ok: false, error: "SignedOutError: signed out at /login" });
    expect(seen).toEqual(["signed out at /login"]);
  });
});
