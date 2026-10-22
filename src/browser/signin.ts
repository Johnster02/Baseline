import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Page } from "playwright";
import type { ProjectConfig, Runner } from "../config/schema";
import { checkTarget } from "../config/store";
import { getSecret, sessionPath } from "../config/secrets";
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

/** On a sign-in page: the runner's login path, or any page asking for a password. */
export async function isSignedOut(page: Page, runner: Runner): Promise<boolean> {
  const path = new URL(page.url()).pathname;
  if (runner.auth.kind === "form" && path === new URL(runner.auth.loginUrl, page.url()).pathname) return true;
  return (await page.locator(PASSWORD).first().isVisible().catch(() => false)) === true;
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
    const context = await browser.newContext({ baseURL: ctx.baseUrl });
    context.setDefaultTimeout(15000);
    const page = await context.newPage();
    const loginUrl = new URL(runner.auth.loginUrl, ctx.baseUrl);
    if (loginUrl.host !== new URL(ctx.baseUrl).host) return { key: runner.key, ok: false, error: "The login URL is on a different site from the test URL. Refusing to type credentials there." };
    await page.goto(loginUrl.toString(), { waitUntil: "load" });
    const user = page.locator(USERNAME).first();
    await user.fill(creds.username);
    const pw = page.locator(PASSWORD).first();
    if (!(await pw.isVisible().catch(() => false))) {
      // Two-step forms: username first, then the password page.
      await user.press("Enter");
      await pw.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    }
    if (new URL(page.url()).host !== loginUrl.host) return { key: runner.key, ok: false, error: "Sign-in left the site before the password step. Use a manual sign-in for this runner." };
    await pw.fill(creds.password);
    await Promise.all([page.waitForLoadState("load"), pw.press("Enter")]);
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    if (await isSignedOut(page, runner)) return { key: runner.key, ok: false, error: "Sign-in did not succeed: still on the sign-in page. Check the saved details in setup." };
    saveState(file, await context.storageState());
    return { key: runner.key, ok: true, landed: new URL(page.url()).pathname };
  } catch (e) {
    return { key: runner.key, ok: false, error: `Sign-in failed: ${(e as Error).name || "error"}` };
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
  await page.goto(runner.auth.kind === "form" ? new URL(runner.auth.loginUrl, ctx.baseUrl).toString() : ctx.baseUrl);
  let saved = false;
  const timer = setInterval(async () => {
    try { saveState(file, await context.storageState()); saved = true; } catch { /* window closing */ }
  }, 2000);
  await new Promise<void>((res) => { page.on("close", () => res()); browser.on("disconnected", () => res()); });
  clearInterval(timer);
  await browser.close().catch(() => {});
  return saved ? { key: runner.key, ok: true } : { key: runner.key, ok: false, error: "The window closed before a session was saved." };
}
