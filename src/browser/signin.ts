import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Page } from "playwright";
import type { ProjectConfig, Runner } from "../config/schema";
import { checkTarget } from "../config/store";
import { getSecret, originOf, sessionPath } from "../config/secrets";
import { loadPlaywright } from "./session";

export class SignedOutError extends Error {
  constructor(public runner: string, public at: string) {
    super(`${runner} is signed out (landed on ${at}). Its saved session has expired; re-run setup to sign in again.`);
    this.name = "SignedOutError";
  }
}

export type SignInContext = { projectDir: string; data: string; baseUrl: string; runDir?: string; live?: boolean };
export type SignInResult = { key: string; ok: boolean; landed?: string; error?: string };

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
 * Landed on a sign-in page: the runner's own login path, or (for any runner) a sign-in-looking
 * path that asks for a password. A password field alone (change password, confirm) is not it.
 */
export function looksSignedOut(url: string, passwordVisible: boolean, runner: Runner): boolean {
  const u = new URL(url);
  if (runner.auth.kind === "form" && u.pathname === new URL(runner.auth.loginUrl, url).pathname) return true;
  return passwordVisible && SIGN_IN_PATH.test(u.pathname + (u.search ? "?" : ""));
}

export async function isSignedOut(page: Page, runner: Runner): Promise<boolean> {
  const visible = (await page.locator(PASSWORD).first().isVisible().catch(() => false)) === true;
  return looksSignedOut(page.url(), visible, runner);
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
      if (await isSignedOut(page, runner)) return { key: runner.key, ok: false, error: "Saved session has expired. Sign in by hand again: baseline signin " + runner.key + " --manual" };
      return { key: runner.key, ok: true, landed: new URL(page.url()).pathname };
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
    await Promise.all([page.waitForLoadState("load"), pw.press("Enter")]);
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    if (await isSignedOut(page, runner)) return { key: runner.key, ok: false, error: "Sign-in did not succeed: still on the sign-in page. Check the saved details in setup." };
    saveState(file, await context.storageState());
    return { key: runner.key, ok: true, landed: new URL(page.url()).pathname };
  } catch (e) {
    return { key: runner.key, ok: false, error: `Sign-in failed: ${(e instanceof Error && e.name) || "error"}` };
  } finally {
    await browser.close();
  }
}

/** Opens a visible browser; the user signs in by hand and closes it. The session is saved as they go. */
export async function captureSession(runner: Runner, cfg: ProjectConfig, ctx: SignInContext): Promise<SignInResult> {
  const target = checkTarget(ctx.baseUrl, cfg, ctx.live ?? runner.allow.includes("live"));
  if (!target.ok) return { key: runner.key, ok: false, error: "refusing: that URL is marked as production or is invalid" };
  const file = sessionPath(ctx.data, ctx.projectDir, runner.key);
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ baseURL: ctx.baseUrl });
  const page = await context.newPage();
  const start = runner.auth.kind === "form" ? new URL(runner.auth.loginUrl, ctx.baseUrl) : new URL(ctx.baseUrl);
  if (start.host !== new URL(ctx.baseUrl).host) { await browser.close(); return { key: runner.key, ok: false, error: "The login URL is on a different site from the test URL. Refusing to open it." }; }
  await page.goto(start.toString());
  let saved = false;
  const timer = setInterval(async () => {
    try { saveState(file, await context.storageState()); saved = true; } catch { /* window closing */ }
  }, 2000);
  await new Promise<void>((res) => { page.on("close", () => res()); browser.on("disconnected", () => res()); });
  clearInterval(timer);
  await browser.close().catch(() => {});
  return saved ? { key: runner.key, ok: true } : { key: runner.key, ok: false, error: "The window closed before a session was saved." };
}
