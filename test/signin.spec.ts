import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixture, FIXTURE_USER } from "./fixture-app/server";
import { signIn, SignedOutError, captureSession, chooseSignInUrl, looksSignedOut } from "../src/browser/signin";
import { chooseChannel } from "../src/browser/launch";
import { openSession } from "../src/browser/session";
import { trustRun } from "./helpers/trust";
import { loadConfig, newRunner } from "../src/config/store";
import { setSecret, sessionPath } from "../src/config/secrets";

let f: Awaited<ReturnType<typeof startFixture>>;
beforeAll(async () => { f = await startFixture(); });
afterAll(() => f.stop());

const setup = (password = FIXTURE_USER.password, origin: string | null = f.url) => {
  const proj = realpathSync(mkdtempSync(join(tmpdir(), "proj-")));
  const data = realpathSync(mkdtempSync(join(tmpdir(), "data-")));
  const runner = newRunner("customer", "customer", { kind: "form", loginUrl: "/login" });
  const cfg = { ...loadConfig(proj), runners: [runner] };
  setSecret(data, proj, "customer", { username: FIXTURE_USER.username, password, ...(origin ? { origin } : {}) });
  return { proj, data, runner, cfg, runDir: realpathSync(mkdtempSync(join(tmpdir(), "run-"))) };
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
    trustRun({ runDir: s.runDir, runId: "r-x", baseUrl: f.url, cfg: s.cfg });
    const sess = await openSession({ runDir: s.runDir, runId: "r-x", runner: s.runner, cfg: s.cfg, baseUrl: f.url, storageState: state });
    try {
      await expect(sess.goto("/cart")).rejects.toBeInstanceOf(SignedOutError);
    } finally { await sess.close(); }
    // It never typed credentials anywhere while signed out.
    expect(f.requests.filter((r) => r.method === "POST" && r.path === "/login").length).toBe(0);
  }, 30000);
});

describe("where signin may type stored passwords", () => {
  const staging = "https://staging.acme.dev";
  it("during a run, only on the run's own site", () => {
    expect(chooseSignInUrl({ flagUrl: "https://evil.tld", activeUrl: staging })).toMatchObject({ ok: false, reason: expect.stringMatching(/run is active/) });
    expect(chooseSignInUrl({ flagUrl: "https://evil.tld", activeUrl: staging, lastUrl: "https://evil.tld" })).toMatchObject({ ok: false });
    expect(chooseSignInUrl({ flagUrl: staging + "/app", activeUrl: staging })).toEqual({ ok: true, url: staging + "/app" });
    expect(chooseSignInUrl({ activeUrl: staging, lastUrl: "https://old.acme.dev" })).toEqual({ ok: true, url: staging });
  });
  it("outside a run, a --url must be on the configured site", () => {
    expect(chooseSignInUrl({ flagUrl: "https://evil.tld", lastUrl: staging })).toMatchObject({ ok: false, reason: expect.stringMatching(/config set lastUrl/) });
    expect(chooseSignInUrl({ flagUrl: staging + "/x", lastUrl: staging })).toEqual({ ok: true, url: staging + "/x" });
    expect(chooseSignInUrl({ flagUrl: "http://staging.acme.dev", lastUrl: staging })).toMatchObject({ ok: false });
  });
  it("first setup (nothing configured) takes the --url; no URL at all is an error", () => {
    expect(chooseSignInUrl({ flagUrl: staging })).toEqual({ ok: true, url: staging });
    expect(chooseSignInUrl({ lastUrl: staging })).toEqual({ ok: true, url: staging });
    expect(chooseSignInUrl({})).toMatchObject({ ok: false });
    expect(chooseSignInUrl({ flagUrl: "not a url" })).toMatchObject({ ok: false });
  });
  it("an absolute login URL on another site is refused before anything is typed", async () => {
    const { proj, data, cfg } = setup();
    const runner = newRunner("customer", "customer", { kind: "form", loginUrl: "https://evil.tld/login" });
    const r = await signIn(runner, { ...cfg, runners: [runner] }, { projectDir: proj, data, baseUrl: f.url });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/different site/) });
  });
  it("saved details are typed only on the site they were saved for, whatever URL signin is given", async () => {
    const s = setup(FIXTURE_USER.password, "https://staging.acme.dev");
    f.requests.length = 0;
    const r = await signIn(s.runner, s.cfg, { projectDir: s.proj, data: s.data, baseUrl: f.url });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/for https:\/\/staging\.acme\.dev/) });
    expect(f.requests.length).toBe(0);
  });
  it("details saved before origins were recorded are refused until saved again", async () => {
    const s = setup(FIXTURE_USER.password, null);
    const r = await signIn(s.runner, s.cfg, { projectDir: s.proj, data: s.data, baseUrl: f.url });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Save them again/) });
  });
});

describe("looksSignedOut", () => {
  it("a password field on a normal page is not 'signed out' for a session runner", () => {
    const runner = newRunner("a", "a", { kind: "session" });
    expect(looksSignedOut("https://s.acme.dev/settings/password", true, runner)).toBe(false);
    expect(looksSignedOut("https://s.acme.dev/login?next=/cart", true, runner)).toBe(true);
    const form = newRunner("b", "b", { kind: "form", loginUrl: "/auth/enter" });
    expect(looksSignedOut("https://s.acme.dev/auth/enter", false, form)).toBe(true);
    expect(looksSignedOut("https://s.acme.dev/account", true, form)).toBe(false);
  });

  it("an auth step below the login path counts as still on the sign-in page", () => {
    const form = newRunner("b", "b", { kind: "form", loginUrl: "/sign-in" });
    expect(looksSignedOut("https://s.acme.dev/sign-in/factor-one", false, form)).toBe(true);
    expect(looksSignedOut("https://s.acme.dev/sign-in/factor-two", false, form)).toBe(true);
    expect(looksSignedOut("https://s.acme.dev/dashboard", false, form)).toBe(false);
    // A different path that merely starts with the same letters is not an auth step.
    expect(looksSignedOut("https://s.acme.dev/sign-institute", false, form)).toBe(false);
  });
});

describe("proving a runner is signed in", () => {
  let pub: Awaited<ReturnType<typeof startFixture>>;
  beforeAll(async () => { pub = await startFixture(0, { publicHome: true }); });
  afterAll(() => pub.stop());

  const sessionRunner = (authedCheck?: import("../src/config/schema").AuthedCheck) =>
    newRunner("admin", "admin", { kind: "session" }, authedCheck);

  it("a home page that signed-out visitors can see is not proof of being signed in", async () => {
    const s = setup(FIXTURE_USER.password, pub.url);
    const runner = sessionRunner();
    const state = sessionPath(s.data, s.proj, "admin");
    mkdirSync(join(state, ".."), { recursive: true });
    writeFileSync(state, JSON.stringify({ cookies: [], origins: [] }));
    const r = await signIn(runner, { ...s.cfg, runners: [runner] }, { projectDir: s.proj, data: s.data, baseUrl: pub.url });
    expect(r.strength).toBe("weak");
    expect(r.note).toMatch(/could not prove/i);
  }, 30000);

  it("an authedCheck that finds its text proves the sign-in", async () => {
    const s = setup(FIXTURE_USER.password, pub.url);
    const runner = sessionRunner({ path: "/account", expect: { text: "Sign out" } });
    // Sign in for real first, so there is a session worth checking.
    const form = await signIn(s.runner, s.cfg, { projectDir: s.proj, data: s.data, baseUrl: pub.url });
    expect(form.ok).toBe(true);
    copyFileSync(sessionPath(s.data, s.proj, "customer"), sessionPath(s.data, s.proj, "admin"));
    const r = await signIn(runner, { ...s.cfg, runners: [runner] }, { projectDir: s.proj, data: s.data, baseUrl: pub.url });
    expect(r).toMatchObject({ ok: true, strength: "proved" });
  }, 30000);

  it("an authedCheck that does not find its text fails, and says which page it looked at", async () => {
    const s = setup(FIXTURE_USER.password, pub.url);
    const runner = sessionRunner({ path: "/account", expect: { text: "Sign out" } });
    const state = sessionPath(s.data, s.proj, "admin");
    mkdirSync(join(state, ".."), { recursive: true });
    writeFileSync(state, JSON.stringify({ cookies: [], origins: [] }));
    const r = await signIn(runner, { ...s.cfg, runners: [runner] }, { projectDir: s.proj, data: s.data, baseUrl: pub.url });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/\/account/);
  }, 30000);

  it("a form sign-in that stalls on a code screen reports failure, and saves no session", async () => {
    const s = setup(FIXTURE_USER.password, pub.url);
    const runner = newRunner("customer", "customer", { kind: "form", loginUrl: "/sign-in" });
    const r = await signIn(runner, { ...s.cfg, runners: [runner] }, { projectDir: s.proj, data: s.data, baseUrl: pub.url });
    expect(r.ok).toBe(false);
    expect(existsSync(sessionPath(s.data, s.proj, "customer"))).toBe(false);
  }, 30000);
});

describe("which browser a hand-driven sign-in uses", () => {
  it("prefers a real Chrome, then Edge, then bundled Chromium", () => {
    expect(chooseChannel((n) => n === "chrome").channel).toBe("chrome");
    expect(chooseChannel((n) => n === "msedge").channel).toBe("msedge");
    expect(chooseChannel((n) => n === "chrome" || n === "msedge").channel).toBe("chrome");
    expect(chooseChannel(() => false).channel).toBeUndefined();
  });

  it("never launches with the flags that mark the browser as automated", () => {
    for (const c of [chooseChannel(() => false), chooseChannel(() => true)]) {
      expect(c.ignoreDefaultArgs).toContain("--enable-automation");
      expect(c.args).toContain("--disable-blink-features=AutomationControlled");
    }
  });
});

describe("capturing a hand-driven sign-in", () => {
  let pub: Awaited<ReturnType<typeof startFixture>>;
  beforeAll(async () => { pub = await startFixture(0, { publicHome: true }); });
  afterAll(() => pub.stop());

  const runner = () => newRunner("admin", "admin", { kind: "session" }, { path: "/account", expect: { text: "Sign out" } });

  it("a window closed while still signed out reports failure and saves no session", async () => {
    const s = setup(FIXTURE_USER.password, pub.url);
    const r = await captureSession(runner(), { ...s.cfg, runners: [runner()] }, { projectDir: s.proj, data: s.data, baseUrl: pub.url }, {
      headless: true,
      onReady: async (ctx) => { for (const p of ctx.pages()) await p.close(); },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/signed out|did not show/i);
    expect(existsSync(sessionPath(s.data, s.proj, "admin"))).toBe(false);
  }, 60000);

  it("a signed-in window that is closed saves the session and proves it", async () => {
    const s = setup(FIXTURE_USER.password, pub.url);
    const r = await captureSession(runner(), { ...s.cfg, runners: [runner()] }, { projectDir: s.proj, data: s.data, baseUrl: pub.url }, {
      headless: true,
      onReady: async (ctx) => {
        const page = ctx.pages()[0]!;
        await page.goto(pub.url + "/login");
        await page.fill('input[type="email"]', FIXTURE_USER.username);
        await page.fill('input[type="password"]', FIXTURE_USER.password);
        await page.press('input[type="password"]', "Enter");
        await page.waitForURL(/\/cart/);
        await page.close();
      },
    });
    expect(r).toMatchObject({ ok: true, strength: "proved" });
    expect(existsSync(sessionPath(s.data, s.proj, "admin"))).toBe(true);
  }, 60000);

  it("refuses to keep a hand-driven session it cannot prove, signed out or not (C2)", async () => {
    // The configuration every existing project is in after upgrade: no authedCheck. Closing the
    // window while signed out used to report ok and leave a signed-out session behind.
    const s = setup(FIXTURE_USER.password, pub.url);
    const bare = newRunner("admin", "admin", { kind: "session" });
    const r = await captureSession(bare, { ...s.cfg, runners: [bare] }, { projectDir: s.proj, data: s.data, baseUrl: pub.url }, {
      headless: true,
      onReady: async (ctx) => { for (const p of ctx.pages()) await p.close(); },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/set-authed-check/);
    expect(existsSync(sessionPath(s.data, s.proj, "admin"))).toBe(false);
  }, 60000);

  it("refuses even when the sign-in really worked, because it cannot tell (C2)", async () => {
    const s = setup(FIXTURE_USER.password, pub.url);
    const bare = newRunner("admin", "admin", { kind: "session" });
    const r = await captureSession(bare, { ...s.cfg, runners: [bare] }, { projectDir: s.proj, data: s.data, baseUrl: pub.url }, {
      headless: true,
      onReady: async (ctx) => {
        const page = ctx.pages()[0]!;
        await page.goto(pub.url + "/login");
        await page.fill('input[type="email"]', FIXTURE_USER.username);
        await page.fill('input[type="password"]', FIXTURE_USER.password);
        await page.press('input[type="password"]', "Enter");
        await page.waitForURL(/\/cart/);
        await page.close();
      },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/can't tell|cannot tell|set-authed-check/);
    expect(existsSync(sessionPath(s.data, s.proj, "admin"))).toBe(false);
  }, 60000);

  it("a popup closing does not end the capture (I7)", async () => {
    const s = setup(FIXTURE_USER.password, pub.url);
    let ended = false;
    let stillOpenAfterPopup: boolean | undefined;
    const p = captureSession(runner(), { ...s.cfg, runners: [runner()] }, { projectDir: s.proj, data: s.data, baseUrl: pub.url }, {
      headless: true,
      onReady: async (ctx, windowClosed) => {
        const popup = await ctx.newPage();
        await popup.goto(pub.url + "/login");
        await popup.close();
        // Ask the capture itself whether the window has gone. An OAuth popup closing must not
        // end it; only the last window does.
        const settled = Symbol("settled");
        const race = await Promise.race([windowClosed.then(() => settled), new Promise((r2) => setTimeout(r2, 400))]);
        stillOpenAfterPopup = race !== settled;
        for (const page of ctx.pages()) await page.close();
        await windowClosed;
        ended = true;
      },
    });
    const r = await p;
    expect(stillOpenAfterPopup).toBe(true);
    expect(ended).toBe(true);
    expect(r.ok).toBe(false);
  }, 60000);
});
