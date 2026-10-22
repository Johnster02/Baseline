import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Browser, BrowserContext, Locator, Page } from "playwright";
import type { ProjectConfig, Runner } from "../config/schema";
import { dataDir } from "../config/secrets";
import { decide, redactUrl, wsDecide } from "./guard";
import { isSignedOut, SignedOutError } from "./signin";

export type BlockedEntry = {
  at: string; runner: string; method: string; host: string; path: string;
  category: string; reason: string; trigger?: string;
};

/** How an agent names an element. Role + name first, like a person would. */
export type Target =
  | { role: string; name?: string; exact?: boolean; nth?: number }
  | { text: string; exact?: boolean; nth?: number }
  | { label: string; nth?: number }
  | { placeholder: string; nth?: number }
  | { testId: string; nth?: number }
  | { css: string; nth?: number };

export type Session = {
  /** Parent-process only. Agent scripts never receive this. */
  page: Page;
  goto(path: string): Promise<void>;
  click(t: Target): Promise<void>;
  fill(t: Target, value: string): Promise<void>;
  press(key: string, t?: Target): Promise<void>;
  select(t: Target, value: string): Promise<void>;
  check(t: Target): Promise<void>;
  hover(t: Target): Promise<void>;
  back(): Promise<void>;
  waitFor(t: Target, opts?: { state?: "visible" | "hidden"; timeout?: number }): Promise<void>;
  snapshot(): Promise<string>;
  text(t?: Target): Promise<string>;
  url(): Promise<string>;
  title(): Promise<string>;
  shot(name: string, caption: string): Promise<string>;
  created(kind: string, label: string, url?: string): void;
  close(): Promise<void>;
};

export type OpenOptions = {
  runDir: string; runId: string; runner: Runner; cfg: ProjectConfig; baseUrl: string;
  storageState?: string; headless?: boolean;
};

/** Playwright is installed by setup into the plugin data dir. */
export function loadPlaywright(): typeof import("playwright") {
  // The plugin's own pinned copy first; the project's copy last, so a project can't swap in its own.
  const data = dataDir();
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(join(data, "browsers"))) process.env.PLAYWRIGHT_BROWSERS_PATH = join(data, "browsers");
  const bases = [join(data, "noop.js")];
  if (typeof __filename !== "undefined") bases.push(__filename);
  bases.push(join(process.cwd(), "noop.js"));
  let last: unknown;
  for (const b of bases) {
    try { return createRequire(b)("playwright"); } catch (e) { last = e; }
  }
  throw new Error("Playwright is not installed. Run /baseline:setup first. (" + String((last as Error)?.message || last) + ")");
}

function readJson<T>(p: string, fallback: T): T {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; }
}
export function appendJson(p: string, item: unknown): void {
  const list = readJson<unknown[]>(p, []);
  list.push(item);
  writeFileSync(p, JSON.stringify(list, null, 2));
}

const STATIC = new Set(["script", "stylesheet", "image", "font", "media", "manifest"]);
const CLICK_WINDOW_MS = 4000;
const SNAPSHOT_LIMIT = 12000;

const LABEL_JS = `(el) => {
  const svgTitle = el.querySelector && el.querySelector('svg title');
  return ((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || el.innerText || el.value || (svgTitle && svgTitle.textContent) || '').trim().slice(0, 200);
}`;
const INIT = `(() => {
  const label = ${LABEL_JS};
  const pick = (el) => el && el.closest && el.closest('button,a,[role=button],[role=link],[role=menuitem],[role=tab],[role=option],[onclick],input[type=submit],input[type=button],summary,label');
  document.addEventListener('click', (e) => { const el = pick(e.target); if (el) window.__baselineClick(label(el)); }, true);
  document.addEventListener('submit', (e) => { const el = e.submitter || e.target; window.__baselineClick(label(el)); }, true);
})();`;

export async function openSession(o: OpenOptions): Promise<Session> {
  for (const d of ["logs", "shots"]) mkdirSync(join(o.runDir, d), { recursive: true });
  // Learned per runner, never shared: one account's page loads don't unlock another's writes.
  const loadPath = join(o.runDir, "logs", `load-requests-${o.runner.key}.json`);
  const learned = new Set<string>(readJson<string[]>(loadPath, []));
  const clicks: { text: string; at: number }[] = [];
  const state = { loading: false };
  const network: { at: string; method: string; host: string; path: string; type: string; outcome: string }[] = [];
  const createdPaths: string[] = [];
  const baseHost = new URL(o.baseUrl).host;

  const recentClicks = () => {
    const now = Date.now();
    while (clicks.length && now - clicks[0]!.at > CLICK_WINDOW_MS) clicks.shift();
    return clicks.map((c) => c.text).filter(Boolean).join(" | ") || undefined;
  };
  const block = (entry: Omit<BlockedEntry, "runner" | "at">) => {
    appendJson(join(o.runDir, "blocked.json"), { at: new Date().toISOString(), runner: o.runner.key, ...entry });
  };

  const { chromium } = loadPlaywright();
  const browser: Browser = await chromium.launch({ headless: o.headless ?? true });
  const context: BrowserContext = await browser.newContext({
    baseURL: o.baseUrl,
    serviceWorkers: "block",
    storageState: o.storageState && existsSync(o.storageState) ? o.storageState : undefined,
  });
  context.setDefaultTimeout(15000);
  await context.exposeBinding("__baselineClick", (_src, t: string) => { clicks.push({ text: String(t || ""), at: Date.now() }); });
  await context.addInitScript({ content: INIT });

  let page!: Page;
  await context.route("**/*", async (route) => {
    try {
      const r = route.request();
      const method = r.method();
      let clickText = recentClicks();
      if (method !== "GET" && method !== "HEAD" && !state.loading && !clickText) {
        await new Promise((res) => setTimeout(res, 40)); // the click binding can land just after its request
        clickText = recentClicks();
      }
      // Only requests from the main frame, after the new page committed, count as "the page loading".
      const loading = state.loading && !!page && r.frame() === page.mainFrame() && (() => { try { return new URL(page.url()).host === baseHost; } catch { return false; } })();
      const d = decide(
        { method, url: r.url(), loading, clickText, body: r.postData() ?? undefined, document: r.isNavigationRequest() && r.resourceType() === "document" },
        { runner: o.runner, cfg: o.cfg, learned, baseHost, createdPaths },
      );
      const u = new URL(r.url());
      const entry = { method, host: u.host, path: redactUrl(r.url()) };
      if (d.action === "abort") {
        block({ ...entry, category: d.category, reason: d.reason, ...(d.trigger ? { trigger: d.trigger } : {}) });
        network.push({ at: new Date().toISOString(), ...entry, type: r.resourceType(), outcome: `blocked:${d.category}` });
        return await route.abort("blockedbyclient");
      }
      if (d.learn) { learned.add(d.learn); writeFileSync(loadPath, JSON.stringify([...learned], null, 2)); }
      if (u.host === baseHost && !STATIC.has(r.resourceType())) network.push({ at: new Date().toISOString(), ...entry, type: r.resourceType(), outcome: "allowed" });
      return await route.continue();
    } catch {
      // Fail closed: if anything in the guard breaks, the request does not go out.
      return route.abort("failed").catch(() => {});
    }
  });

  // WebSockets: same rules as requests (see wsDecide).
  await context.routeWebSocket(/.*/, (ws) => {
    const u = new URL(ws.url().replace(/^ws/i, "http"));
    const entry = { method: "WS", host: u.host, path: redactUrl(u.toString()) };
    const open = wsDecide({ url: ws.url(), loading: state.loading }, { runner: o.runner, cfg: o.cfg });
    if (open.action === "abort") { block({ ...entry, category: open.category, reason: open.reason }); ws.close(); return; }
    const server = ws.connectToServer();
    ws.onMessage((msg) => {
      const d = wsDecide({ url: ws.url(), loading: state.loading, message: typeof msg === "string" ? msg : "" }, { runner: o.runner, cfg: o.cfg });
      if (d.action === "abort") { block({ ...entry, category: d.category, reason: d.reason, ...(d.trigger ? { trigger: d.trigger } : {}) }); return; }
      server.send(msg);
    });
  });

  // What this run created, as the site itself reported it: the Location of a 201 Created answer to a
  // write the guard allowed. Agents can't add to this; created() is only metadata for the report.
  context.on("response", (res) => {
    const m = res.request().method();
    if (m === "GET" || m === "HEAD" || res.status() !== 201) return;
    const loc = res.headers()["location"];
    if (!loc) return;
    try {
      const u = new URL(loc, res.url());
      if (u.host === baseHost) createdPaths.push(u.pathname);
    } catch { /* ignore */ }
  });

  page = await context.newPage();
  const deny = async () => { throw new Error("Baseline: direct API requests are not allowed. Drive the page instead."); };
  for (const api of new Set([context.request, page.request])) {
    for (const m of ["fetch", "get", "post", "put", "patch", "delete", "head"] as const) (api as any)[m] = deny;
  }

  const loc = (t: Target): Locator => {
    let l: Locator;
    if ("role" in t) l = page.getByRole(t.role as Parameters<Page["getByRole"]>[0], t.name !== undefined ? { name: t.name, exact: t.exact } : undefined);
    else if ("text" in t) l = page.getByText(t.text, { exact: t.exact });
    else if ("label" in t) l = page.getByLabel(t.label);
    else if ("placeholder" in t) l = page.getByPlaceholder(t.placeholder);
    else if ("testId" in t) l = page.getByTestId(t.testId);
    else l = page.locator(t.css);
    return t.nth !== undefined ? l.nth(t.nth) : l.first();
  };
  // The parent knows what is being clicked before the click happens: record it first.
  const noteTarget = async (l: Locator) => {
    const label = await l.evaluate(new Function(`return (${LABEL_JS})`)() as (el: Element) => string).catch(() => "");
    clicks.push({ text: String(label || ""), at: Date.now() });
  };
  // After an action: give a navigation a moment to land, then check the runner is still signed in.
  const settle = async () => {
    await page.waitForLoadState("domcontentloaded", { timeout: 2000 }).catch(() => {});
    await afterNav();
  };
  const afterNav = async () => {
    if (await isSignedOut(page, o.runner)) throw new SignedOutError(o.runner.key, new URL(page.url()).pathname);
  };

  let shots = 0;
  return {
    page,
    async goto(path: string) {
      const base = new URL(o.baseUrl);
      let target: URL | undefined;
      try { target = path.startsWith("//") ? undefined : new URL(path, base); } catch { target = undefined; }
      if (!target || !/^https?:$/.test(target.protocol) || target.origin !== base.origin) {
        throw new Error(`goto only goes to pages on ${base.origin}. Use a path like /cart.`);
      }
      const url = target.toString();
      try {
        await page.goto(url, { waitUntil: "commit" });
        state.loading = true;
        await page.waitForLoadState("load");
        await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
      } finally {
        state.loading = false;
      }
      // Never let an agent sign in again on its own: a signed-out runner stops here.
      await afterNav();
    },
    async click(t) { const l = loc(t); await noteTarget(l); await l.click(); await settle(); },
    async fill(t, value) { await loc(t).fill(value); },
    async press(key, t) { if (t) { const l = loc(t); await noteTarget(l); await l.press(key); } else await page.keyboard.press(key); await settle(); },
    async select(t, value) { await loc(t).selectOption(value); },
    async check(t) { const l = loc(t); await noteTarget(l); await l.check(); },
    async hover(t) { await loc(t).hover(); },
    async back() { await page.goBack(); },
    async waitFor(t, opts) { await loc(t).waitFor({ state: opts?.state ?? "visible", timeout: opts?.timeout }); },
    async snapshot() { const s = await page.locator("body").ariaSnapshot(); return s.length > SNAPSHOT_LIMIT ? s.slice(0, SNAPSHOT_LIMIT) + "\n… (truncated)" : s; },
    async text(t) { const s = t ? await loc(t).innerText() : await page.locator("body").innerText(); return s.slice(0, SNAPSHOT_LIMIT); },
    async url() { return page.url(); },
    async title() { return page.title(); },
    async shot(name: string, caption: string) {
      const safe = name.replace(/[^a-z0-9-]+/gi, "-").slice(0, 60) || "shot";
      // Never reuse a name: earlier scripts in this run may have taken the same one.
      let file: string, rel: string;
      do {
        rel = join("shots", `${o.runner.key}-${safe}-${++shots}.jpg`);
        file = join(o.runDir, rel);
      } while (existsSync(file));
      await page.screenshot({ path: file, fullPage: false, type: "jpeg", quality: 70 });
      appendJson(join(o.runDir, "shots.json"), { runner: o.runner.key, name: safe, path: rel, caption, at: new Date().toISOString() });
      return rel;
    },
    created(kind: string, label: string, url?: string) {
      appendJson(join(o.runDir, "created.json"), {
        runner: o.runner.key, kind, label, url, labelled: label.includes(`Baseline ${o.runId}`), at: new Date().toISOString(),
      });
    },
    async close() {
      writeFileSync(join(o.runDir, "logs", `${o.runner.key}-network.json`), JSON.stringify(network, null, 2));
      appendFileSync(join(o.runDir, "logs", "sessions.log"), `${new Date().toISOString()} closed ${o.runner.key}\n`);
      await browser.close();
    },
  };
}
