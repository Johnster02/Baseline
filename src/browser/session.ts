import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import type { ProjectConfig, Runner } from "../config/schema";
import { decide, redactUrl } from "./guard";

export type BlockedEntry = {
  at: string; runner: string; method: string; host: string; path: string;
  category: string; reason: string; trigger?: string;
};

export type Session = {
  page: Page;
  goto(path: string): Promise<void>;
  shot(name: string, caption: string): Promise<string>;
  created(kind: string, label: string, url?: string): void;
  close(): Promise<void>;
};

export type OpenOptions = {
  runDir: string; runId: string; runner: Runner; cfg: ProjectConfig; baseUrl: string;
  storageState?: string; headless?: boolean;
};

/** Playwright is installed by setup into the plugin data dir and reached through NODE_PATH. */
export function loadPlaywright(): typeof import("playwright") {
  const bases = [join(process.cwd(), "noop.js")];
  if (typeof __filename !== "undefined") bases.push(__filename);
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
const CLICK_WINDOW_MS = 3000;

const INIT = `(() => {
  const pick = (el) => el && el.closest && el.closest('button,a,[role=button],[role=menuitem],input[type=submit],input[type=button],summary,label');
  const text = (el) => ((el.getAttribute && el.getAttribute('aria-label')) || el.innerText || el.value || '').trim().slice(0, 200);
  document.addEventListener('click', (e) => { const el = pick(e.target); if (el) window.__baselineClick(text(el)); }, true);
  document.addEventListener('submit', (e) => { const el = e.submitter || e.target; window.__baselineClick(text(el)); }, true);
})();`;

export async function openSession(o: OpenOptions): Promise<Session> {
  for (const d of ["logs", "shots"]) mkdirSync(join(o.runDir, d), { recursive: true });
  const loadPath = join(o.runDir, "logs", "load-requests.json");
  const learned = new Set<string>(readJson<string[]>(loadPath, []));
  const state = { loading: false, clickText: "", clickAt: 0 };
  const network: { at: string; method: string; host: string; path: string; type: string; outcome: string }[] = [];
  const baseHost = new URL(o.baseUrl).host;

  const { chromium } = loadPlaywright();
  const browser: Browser = await chromium.launch({ headless: o.headless ?? true });
  const context: BrowserContext = await browser.newContext({
    baseURL: o.baseUrl,
    storageState: o.storageState && existsSync(o.storageState) ? o.storageState : undefined,
  });
  context.setDefaultTimeout(15000);
  await context.exposeBinding("__baselineClick", (_src, t: string) => { state.clickText = String(t || ""); state.clickAt = Date.now(); });
  await context.addInitScript({ content: INIT });

  await context.route("**/*", async (route) => {
    const r = route.request();
    const method = r.method();
    let clickText = Date.now() - state.clickAt < CLICK_WINDOW_MS ? state.clickText : undefined;
    if (method !== "GET" && method !== "HEAD" && !state.loading && !clickText) {
      // The click binding can land a moment after the request it caused.
      await new Promise((res) => setTimeout(res, 40));
      clickText = Date.now() - state.clickAt < CLICK_WINDOW_MS ? state.clickText : undefined;
    }
    const d = decide({ method, url: r.url(), loading: state.loading, clickText }, { runner: o.runner, cfg: o.cfg, learned });
    const u = new URL(r.url());
    const entry = { at: new Date().toISOString(), method, host: u.host, path: redactUrl(r.url()) };
    if (d.action === "abort") {
      const b: BlockedEntry = { ...entry, runner: o.runner.key, category: d.category, reason: d.reason, ...(d.trigger ? { trigger: d.trigger } : {}) };
      appendJson(join(o.runDir, "blocked.json"), b);
      network.push({ ...entry, type: r.resourceType(), outcome: `blocked:${d.category}` });
      return route.abort("blockedbyclient");
    }
    if (d.learn) { learned.add(d.learn); writeFileSync(loadPath, JSON.stringify([...learned], null, 2)); }
    if (u.host === baseHost && !STATIC.has(r.resourceType())) network.push({ ...entry, type: r.resourceType(), outcome: "allowed" });
    return route.continue();
  });

  const page = await context.newPage();
  // Direct API calls skip the route guard, so their methods are disabled. (Playwright still
  // needs the object itself for clean-up, so the getter stays.)
  const deny = async () => { throw new Error("Baseline: direct API requests are not allowed. Drive the page instead."); };
  for (const api of new Set([context.request, page.request])) {
    for (const m of ["fetch", "get", "post", "put", "patch", "delete", "head"] as const) (api as any)[m] = deny;
  }

  let shots = 0;
  return {
    page,
    async goto(path: string) {
      state.loading = true;
      try {
        await page.goto(new URL(path, o.baseUrl).toString(), { waitUntil: "load" });
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      } finally {
        state.loading = false;
      }
    },
    async shot(name: string, caption: string) {
      const safe = name.replace(/[^a-z0-9-]+/gi, "-").slice(0, 60) || "shot";
      const file = join(o.runDir, "shots", `${o.runner.key}-${safe}-${++shots}.png`);
      await page.screenshot({ path: file, fullPage: false });
      appendJson(join(o.runDir, "shots.json"), { runner: o.runner.key, name: safe, path: file, caption, at: new Date().toISOString() });
      return file;
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
