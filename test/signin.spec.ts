import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixture, FIXTURE_USER } from "./fixture-app/server";
import { signIn, SignedOutError } from "../src/browser/signin";
import { openSession } from "../src/browser/session";
import { loadConfig, newRunner } from "../src/config/store";
import { setSecret, sessionPath } from "../src/config/secrets";

let f: Awaited<ReturnType<typeof startFixture>>;
beforeAll(async () => { f = await startFixture(); });
afterAll(() => f.stop());

const setup = (password = FIXTURE_USER.password) => {
  const proj = mkdtempSync(join(tmpdir(), "proj-"));
  const data = mkdtempSync(join(tmpdir(), "data-"));
  const runner = newRunner("customer", "customer", { kind: "form", loginUrl: "/login" });
  const cfg = { ...loadConfig(proj), runners: [runner] };
  setSecret(data, proj, "customer", { username: FIXTURE_USER.username, password });
  return { proj, data, runner, cfg, runDir: mkdtempSync(join(tmpdir(), "run-")) };
};

describe("signIn", () => {
  it("form sign-in saves a session", async () => {
    const s = setup();
    const r = await signIn(s.runner, s.cfg, { projectDir: s.proj, data: s.data, baseUrl: f.url, runDir: s.runDir });
    expect(r).toMatchObject({ key: "customer", ok: true });
    expect(r.landed).toContain("/cart");
    expect(existsSync(sessionPath(s.data, s.proj, "customer"))).toBe(true);
  }, 30000);

  it("a wrong password fails without echoing credentials", async () => {
    const s = setup("wrong-pass-123");
    const r = await signIn(s.runner, s.cfg, { projectDir: s.proj, data: s.data, baseUrl: f.url, runDir: s.runDir });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("wrong-pass-123");
    expect(JSON.stringify(r)).not.toContain(FIXTURE_USER.username);
  }, 30000);

  it("a session runner with no saved session reports it needs a manual sign-in", async () => {
    const s = setup();
    const runner = newRunner("admin", "admin", { kind: "session" });
    const r = await signIn(runner, { ...s.cfg, runners: [runner] }, { projectDir: s.proj, data: s.data, baseUrl: f.url, runDir: s.runDir });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/sign in by hand/i);
  });
});

describe("signed-out detection", () => {
  it("goto throws SignedOutError when the saved session has expired", async () => {
    const s = setup();
    f.requests.length = 0;
    const state = join(s.runDir, "expired.json");
    writeFileSync(state, JSON.stringify({ cookies: [], origins: [] }));
    const sess = await openSession({ runDir: s.runDir, runId: "r-x", runner: s.runner, cfg: s.cfg, baseUrl: f.url, storageState: state });
    try {
      await expect(sess.goto("/cart")).rejects.toBeInstanceOf(SignedOutError);
    } finally { await sess.close(); }
    // It never typed credentials anywhere while signed out.
    expect(f.requests.filter((r) => r.method === "POST" && r.path === "/login").length).toBe(0);
  }, 30000);
});
