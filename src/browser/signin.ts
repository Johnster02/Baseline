import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import type { ProjectConfig, Runner } from "../config/schema";
import { checkTarget } from "../config/store";
import { getSecret, originOf, projectHash, sessionPath } from "../config/secrets";
import { loadPlaywright } from "./session";
import { chooseChannel } from "./launch";

export class SignedOutError extends Error {
  constructor(public runner: string, public at: string) {
    super(`${runner} is signed out (landed on ${at}). Its saved session has expired; re-run setup to sign in again.`);
    this.name = "SignedOutError";
  }
}

export type SignInContext = { projectDir: string; data: string; baseUrl: string; runDir?: string; live?: boolean };
export type SignInResult = {
  key: string;
  ok: boolean;
  landed?: string;
  error?: string;
  /**
   * How the result was reached. "proved": something only a signed-in visitor sees was found (or
   * provably absent). "weak": nothing objected, but nothing proved it either — the runner has no
   * authedCheck. A weak result never claims proof; `note` says what could not be shown.
   */
  strength?: Strength;
  note?: string;
};

const PASSWORD = 'input[type="password"]';
const USERNAME = 'input[type="email"], input[autocomplete="username"], input[name*="user" i], input[name*="email" i], input[name*="login" i], input[type="text"]';

const origin = (u: string) => { try { return new URL(u).origin; } catch { return undefined; } };

/**
 * Which site `signin` may type credentials on. While a run is active only the run's own site
 * (from trusted state); otherwise a --url must be on the configured site (`lastUrl`) when one is set.
 */
export function chooseSignInUrl(o: { flagUrl?: string | undefined; lastUrl?: string | undefined; activeUrl?: string | undefined }): { ok: true; url: string } | { ok: false; reason: string } {
  if (o.flagUrl !== undefined && !origin(o.flagUrl)) return { ok: false, reason: `not a valid URL: ${o.flagUrl}` };
  if (o.activeUrl) {
    if (o.flagUrl && origin(o.flagUrl) !== origin(o.activeUrl)) return { ok: false, reason: `refusing to sign in at ${origin(o.flagUrl)}: a run is active on ${origin(o.activeUrl)}, and sign-in details are only typed on the site under test.` };
    return { ok: true, url: o.flagUrl ?? o.activeUrl };
  }
  if (o.flagUrl) {
    if (o.lastUrl && origin(o.lastUrl) && origin(o.flagUrl) !== origin(o.lastUrl)) return { ok: false, reason: `refusing to sign in at ${origin(o.flagUrl)}: the configured test site is ${origin(o.lastUrl)}. If the user chose a new site, save it first with \`baseline config set lastUrl <url>\`.` };
    return { ok: true, url: o.flagUrl };
  }
  if (o.lastUrl) return { ok: true, url: o.lastUrl };
  return { ok: false, reason: "no URL: pass --url <url>" };
}

const SIGN_IN_PATH = /\/(log-?in|sign-?in|auth|session|sso)(\/|$|\?)/i;

/**
 * Landed on a sign-in page: the runner's own login path or any step below it, or (for any runner)
 * a sign-in-looking path that asks for a password. A password field alone (change password,
 * confirm) is not it.
 *
 * The login path matches as a prefix because multi-step sign-ins (Clerk's /sign-in/factor-two,
 * an MFA code screen) are still the sign-in, and a code screen has no password field for the
 * other half of this check to catch. Comparing for equality is how a stalled sign-in used to
 * report success (spec 3.3).
 */
export function looksSignedOut(url: string, passwordVisible: boolean, runner: Runner): boolean {
  const u = new URL(url);
  if (runner.auth.kind === "form") {
    const login = new URL(runner.auth.loginUrl, url).pathname.replace(/\/+$/, "");
    if (u.pathname === login || u.pathname.startsWith(login + "/")) return true;
  }
  return passwordVisible && SIGN_IN_PATH.test(u.pathname + (u.search ? "?" : ""));
}

export async function isSignedOut(page: Page, runner: Runner): Promise<boolean> {
  const visible = (await page.locator(PASSWORD).first().isVisible().catch(() => false)) === true;
  return looksSignedOut(page.url(), visible, runner);
}

export type Strength = "proved" | "weak";
export type Verification = { ok: boolean; strength: Strength; reason?: string };

/**
 * Is this runner signed in? With an authedCheck, positively: load the page only a signed-in
 * visitor can use and look for what it shows. Without one, all Baseline can do is notice it is
 * not sitting on a sign-in page, which a site that serves its home page to everyone passes while
 * signed out — so that answer comes back "weak", never as proof.
 */
export async function verifySignedIn(page: Page, runner: Runner): Promise<Verification> {
  const check = runner.authedCheck;
  if (check) {
    const target = new URL(check.path, page.url());
    if (target.origin !== new URL(page.url()).origin) {
      return { ok: false, strength: "weak", reason: `the authedCheck path ${check.path} is on another site; it is not checked.` };
    }
    try {
      await page.goto(target.toString(), { waitUntil: "load" });
    } catch {
      return { ok: false, strength: "proved", reason: `${check.path} could not be opened, so this runner is not signed in.` };
    }
    const wanted = check.expect.role
      ? page.getByRole(check.expect.role as Parameters<Page["getByRole"]>[0], check.expect.name !== undefined ? { name: check.expect.name } : undefined).first()
      : page.getByText(check.expect.text ?? "").first();
    const found = await wanted.isVisible({ timeout: 5000 }).catch(() => false);
    const looking = check.expect.role ? `${check.expect.role}${check.expect.name ? ` "${check.expect.name}"` : ""}` : `"${check.expect.text}"`;
    return found
      ? { ok: true, strength: "proved" }
      : { ok: false, strength: "proved", reason: `signed out: ${check.path} did not show ${looking} (landed on ${new URL(page.url()).pathname}).` };
  }
  if (await isSignedOut(page, runner)) {
    return { ok: false, strength: "proved", reason: `signed out: landed on ${new URL(page.url()).pathname}, which is a sign-in page.` };
  }
  return {
    ok: true,
    strength: "weak",
    reason: `could not prove ${runner.key} is signed in: it is not on a sign-in page, but this site may show ${new URL(page.url()).pathname} to signed-out visitors too. Give this runner an authedCheck (a page and a word only a signed-in user sees) and Baseline can check properly.`,
  };
}

function saveState(file: string, state: unknown) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(dirname(file), 0o700);
  writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  chmodSync(file, 0o600);
}

/**
 * Sign one runner in and save its session. Form runners type their stored credentials on the
 * login page only; session runners just check that their saved session still works.
 * Results never contain the username or password.
 */
export async function signIn(runner: Runner, cfg: ProjectConfig, ctx: SignInContext): Promise<SignInResult> {
  const target = checkTarget(ctx.baseUrl, cfg, ctx.live ?? runner.allow.includes("live"));
  if (!target.ok) return { key: runner.key, ok: false, error: `refusing to sign in: ${ctx.baseUrl} is ${target.reason === "production" ? "marked as production" : "not a valid URL"}` };
  const file = sessionPath(ctx.data, ctx.projectDir, runner.key);
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  try {
    if (runner.auth.kind === "session") {
      if (!existsSync(file)) return { key: runner.key, ok: false, error: "No saved session. Sign in by hand once: baseline signin " + runner.key + " --manual" };
      const context = await browser.newContext({ baseURL: ctx.baseUrl, storageState: file });
      const page = await context.newPage();
      await page.goto(ctx.baseUrl, { waitUntil: "load" });
      const v = await verifySignedIn(page, runner);
      if (!v.ok) return { key: runner.key, ok: false, strength: v.strength, error: `${v.reason} Sign in by hand again: baseline signin ${runner.key} --manual` };
      return { key: runner.key, ok: true, strength: v.strength, landed: new URL(page.url()).pathname, ...(v.reason ? { note: v.reason } : {}) };
    }
    const creds = getSecret(ctx.data, ctx.projectDir, runner.key);
    if (!creds) return { key: runner.key, ok: false, error: "No sign-in details saved for this runner. Re-run setup." };
    // Saved details are typed only on the site they were saved for. Nothing an agent can pass
    // (--url, lastUrl, a run's URL) changes that site.
    const home = originOf(creds.origin);
    if (!home) return { key: runner.key, ok: false, error: `These sign-in details were saved before Baseline recorded which site they're for. Save them again: baseline config secret ${runner.key} --form --url <test site URL>` };
    if (originOf(ctx.baseUrl) !== home) return { key: runner.key, ok: false, error: `Refusing to sign in: these sign-in details are for ${home}, not ${originOf(ctx.baseUrl) ?? ctx.baseUrl}.` };
    const context = await browser.newContext({ baseURL: home });
    context.setDefaultTimeout(15000);
    const page = await context.newPage();
    const loginUrl = new URL(runner.auth.loginUrl, home);
    if (loginUrl.origin !== home) return { key: runner.key, ok: false, error: "The login URL is on a different site from the one these sign-in details are for. Refusing to type credentials there." };
    await page.goto(loginUrl.toString(), { waitUntil: "load" });
    const user = page.locator(USERNAME).first();
    await user.fill(creds.username);
    const pw = page.locator(PASSWORD).first();
    if (!(await pw.isVisible().catch(() => false))) {
      // Two-step forms: username first, then the password page.
      await user.press("Enter");
      await pw.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    }
    if (new URL(page.url()).origin !== home) return { key: runner.key, ok: false, error: "Sign-in left the site before the password step. Use a manual sign-in for this runner." };
    await pw.fill(creds.password);
    // An SPA sign-in never fires `load` again, so waiting on it proves nothing. Let the network
    // settle instead, then ask the page whether the runner is actually in.
    await pw.press("Enter");
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    const v = await verifySignedIn(page, runner);
    if (!v.ok) {
      return { key: runner.key, ok: false, strength: v.strength, error: `Sign-in did not succeed: ${v.reason} If this site asks for a code or a second factor, use a manual sign-in: baseline signin ${runner.key} --manual` };
    }
    saveState(file, await context.storageState());
    return { key: runner.key, ok: true, strength: v.strength, landed: new URL(page.url()).pathname, ...(v.reason ? { note: v.reason } : {}) };
  } catch (e) {
    return { key: runner.key, ok: false, error: `Sign-in failed: ${(e instanceof Error && e.name) || "error"}` };
  } finally {
    await browser.close();
  }
}

export type CaptureOptions = {
  /** Visible by default: the whole point is that a person drives it. Tests override. */
  headless?: boolean;
  /**
   * Called once the window is open, with the live context and a promise that settles when the
   * last window goes. Lets a caller do something while the sign-in is in progress and tell
   * whether the window is still there.
   */
  onReady?: (context: BrowserContext, windowClosed: Promise<void>) => Promise<void> | void;
};

/**
 * Opens a browser; the user signs in by hand and closes it.
 *
 * Three things here were defects (spec 3.2). It used Playwright's bundled Chromium with its
 * automation flags, which some identity providers refuse to sign in under — so it now prefers a
 * real Chrome or Edge with those flags off, in a persistent profile, so a popup-based OAuth flow
 * behaves the way it does in the user's own browser. It ended on the FIRST page close, so an
 * OAuth popup closing ended the capture — it now ends when the last window goes. And it reported
 * success whenever the save timer had written anything at all, signed in or not — the captured
 * state is now checked in a fresh context before it is kept at all.
 */
export async function captureSession(runner: Runner, cfg: ProjectConfig, ctx: SignInContext, opts: CaptureOptions = {}): Promise<SignInResult> {
  const target = checkTarget(ctx.baseUrl, cfg, ctx.live ?? runner.allow.includes("live"));
  if (!target.ok) return { key: runner.key, ok: false, error: "refusing: that URL is marked as production or is invalid" };
  const file = sessionPath(ctx.data, ctx.projectDir, runner.key);
  const pending = `${file}.capturing`;
  const start = runner.auth.kind === "form" ? new URL(runner.auth.loginUrl, ctx.baseUrl) : new URL(ctx.baseUrl);
  if (start.host !== new URL(ctx.baseUrl).host) return { key: runner.key, ok: false, error: "The login URL is on a different site from the test URL. Refusing to open it." };

  const { chromium } = loadPlaywright();
  const choice = chooseChannel();
  // A persistent profile, per project and runner, kept in the data folder with everything else
  // an agent may not read.
  const profile = join(ctx.data, "profiles", projectHash(ctx.projectDir), runner.key);
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const context = await chromium.launchPersistentContext(profile, {
    headless: opts.headless ?? false,
    ...(choice.channel ? { channel: choice.channel } : {}),
    args: choice.args,
    ignoreDefaultArgs: choice.ignoreDefaultArgs,
    baseURL: ctx.baseUrl,
  });

  let saved = false;
  const save = async () => { try { saveState(pending, await context.storageState()); saved = true; } catch { /* window closing */ } };
  // Set the end condition up before anything can close, so a fast close is not missed.
  const closed = new Promise<void>((res) => {
    context.on("close", () => res());
    const watch = (p: Page) => p.on("close", () => { if (context.pages().length === 0) res(); });
    context.on("page", watch);
    context.pages().forEach(watch);
  });

  const timer = setInterval(() => { void save(); }, 2000);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(start.toString()).catch(() => { /* the user can navigate themselves */ });
    // Alongside, not before: the window closing is what ends this, and a caller watching from
    // outside has to be able to see that a popup closing did not.
    const ready = (async () => { await opts.onReady?.(context, closed); })();
    await closed;
    await ready.catch(() => {});
  } finally {
    clearInterval(timer);
    await save();
    await context.close().catch(() => {});
  }

  if (!saved || !existsSync(pending)) {
    rmSync(pending, { force: true });
    return { key: runner.key, ok: false, error: "The window closed before a session was saved. Run it again and sign in before closing the window." };
  }
  // Nothing is kept until it is checked: a window closed while signed out must not leave a
  // session behind for a run to pick up. A failure to even launch the checking browser must not
  // leave the half-captured file behind either (review finding M-2).
  let v: Verification;
  try {
    v = await verifyCaptured(runner, ctx, pending);
  } catch (e) {
    rmSync(pending, { force: true });
    return { key: runner.key, ok: false, error: `The captured session could not be checked (${(e instanceof Error && e.name) || "error"}), so nothing was saved.` };
  }
  if (!v.ok) {
    rmSync(pending, { force: true });
    return { key: runner.key, ok: false, strength: v.strength, error: `${v.reason} Nothing was saved. Run it again and finish signing in before closing the window.` };
  }
  // A hand-driven sign-in is the one place a person is standing there, so it is the one place
  // Baseline can insist on being able to check its work. Keeping a session it cannot vouch for is
  // what let a signed-out account start a run (spec 3.2); a weak pass is not good enough here.
  if (v.strength !== "proved") {
    rmSync(pending, { force: true });
    return {
      key: runner.key,
      ok: false,
      strength: v.strength,
      error: `Baseline can't tell whether ${runner.key} is signed in, so it did not keep the session. Give it a page and a word only a signed-in user sees, then sign in again:\n  baseline config set-authed-check ${runner.key} <path> --text "<word>"\n  baseline signin ${runner.key} --manual --url ${ctx.baseUrl}`,
    };
  }
  renameSync(pending, file);
  chmodSync(file, 0o600);
  return { key: runner.key, ok: true, strength: v.strength, ...(v.reason ? { note: v.reason } : {}) };
}

/** Load the captured state in a fresh, headless context and ask the site who we are. */
async function verifyCaptured(runner: Runner, ctx: SignInContext, state: string): Promise<Verification> {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  try {
    const check = await browser.newContext({ baseURL: ctx.baseUrl, storageState: state });
    const page = await check.newPage();
    await page.goto(ctx.baseUrl, { waitUntil: "load" });
    return await verifySignedIn(page, runner);
  } catch (e) {
    return { ok: false, strength: "weak", reason: `the captured session could not be checked (${(e instanceof Error && e.name) || "error"}).` };
  } finally {
    await browser.close().catch(() => {});
  }
}
