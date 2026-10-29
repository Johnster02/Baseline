import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import type { Browser, BrowserContext, Locator, Page, Request, Response, Route } from "playwright";
import { projectConfigSchema, type ProjectConfig, type Runner } from "../config/schema";
import { appendJsonl, errMsg, readJsonFile, readJsonl } from "../core/json";
import { dataDir, isInside, realPath, trustedFiles } from "../core/paths";
import { readTrustedRun } from "../core/trusted-run";
import { ClickAttribution } from "./click-attribution";
import { decide, redactUrl, wsDecide } from "./guard";
import { OwnedTracker, appendCreated, isPlaceholderUrl, ownedFile } from "./owned";
import { isSignedOut, SignedOutError } from "./signin";

export type BlockedEntry = {
  at: string; runner: string; method: string; host: string; path: string;
  category: string; reason: string; trigger?: string;
};

export type ShotEntry = { runner: string; name: string; path: string; caption: string; at: string };

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
  fixture(name: string): Promise<string>;
  upload(t: Target, paths: string[]): Promise<void>;
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
    try { return createRequire(b)("playwright") as typeof import("playwright"); } catch (e) { last = e; }
  }
  throw new Error("Playwright is not installed. Run /baseline:setup first. (" + errMsg(last) + ")");
}

/** The files `fixture()` serves, shipped with the plugin: <root>/fixtures, beside dist/. */
function shippedFixtures(): string {
  const roots: string[] = [];
  // Bundled, __dirname is <root>/dist; from source (tests) it is <root>/src/browser.
  if (typeof __dirname !== "undefined") roots.push(resolve(__dirname, ".."), resolve(__dirname, "..", ".."));
  roots.push(process.cwd());
  for (const r of roots) { const d = join(r, "fixtures"); if (existsSync(d)) return d; }
  return join(roots[0] ?? process.cwd(), "fixtures");
}

/** What the plugin ships, by name. A name only: `fixture()` never takes a path. */
function fixtureNames(): string[] {
  try { return readdirSync(shippedFixtures()).filter((n) => !n.startsWith(".")).sort(); } catch { return []; }
}

const FIXTURE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The paths an agent script may upload: inside the run folder, and nowhere else.
 *
 * A script's own file access is already limited to its run folder by Node's permission model
 * (`--allow-fs-read=<runDir>`, see runner-script.ts), which keeps saved sessions and credentials in
 * the data folder out of reach. This runs in the parent process, which has no such limit, so it
 * draws the same boundary itself — and does it before the page or the file input is touched, so a
 * refused path never reaches the browser. Absolute paths, `..` and symlinks out are all refused;
 * there is deliberately no way to upload from the data folder, the project or the user's home.
 */
function uploadPaths(runDir: string, paths: readonly unknown[]): string[] {
  if (paths.length === 0) throw new Error("upload needs at least one path inside the run folder.");
  const root = realPath(runDir);
  return paths.map((p) => {
    if (typeof p !== "string" || p.trim() === "") throw new Error(`upload needs a path inside the run folder, not ${JSON.stringify(p)}.`);
    const refuse = (why: string) => new Error(`upload refuses "${p}": ${why} Give a path inside the run folder, such as the one s.fixture() returns.`);
    if (isAbsolute(p)) throw refuse("absolute paths are not allowed.");
    // Resolve "..' first, so an escape is refused before the file system is touched at all.
    const target = resolve(root, p);
    if (!isInside(root, target)) throw refuse("it leads outside the run folder.");
    let real: string;
    try { real = realpathSync.native(target); } catch { throw refuse("there is no such file in the run folder."); }
    // Now the real path: a symlink, or a symlinked folder on the way, must not reach out either.
    if (!isInside(root, real)) throw refuse("it points outside the run folder.");
    if (!statSync(real).isFile()) throw refuse("it is not a file.");
    return real;
  });
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const asShot = (v: unknown): ShotEntry => {
  if (!isRecord(v) || typeof v.path !== "string") throw new Error("not a shot");
  return { runner: String(v.runner ?? ""), name: String(v.name ?? ""), path: v.path, caption: String(v.caption ?? ""), at: String(v.at ?? "") };
};
const asBlocked = (v: unknown): BlockedEntry => {
  if (!isRecord(v) || typeof v.method !== "string" || typeof v.category !== "string") throw new Error("not a blocked entry");
  return v as BlockedEntry;
};

/** Every request the guard blocked in this run, from Baseline's own copy (agents can't edit it). */
export function readBlocked(runDir: string): BlockedEntry[] {
  return readJsonl(trustedFiles.blocked(runDir), asBlocked);
}

/** Screenshots taken in this run (JSONL, plus the older JSON-array file of runs from before JSONL). */
export function readShots(runDir: string): ShotEntry[] {
  const legacy = readJsonFile(join(runDir, "shots.json"), (v) => (Array.isArray(v) ? v : []), [] as unknown[]);
  return [...legacy.flatMap((v) => { try { return [asShot(v)]; } catch { return []; } }), ...readJsonl(join(runDir, "shots.jsonl"), asShot)];
}

const STATIC = new Set(["script", "stylesheet", "image", "font", "media", "manifest"]);
const SNAPSHOT_LIMIT = 12000;
/** The network log keeps the most recent requests only. */
const NETWORK_LIMIT = 2000;
/** Headers a site uses to send the browser somewhere after a write. Nothing else is read. */
const REDIRECT_HEADERS = ["location", "x-action-redirect", "hx-redirect", "hx-location", "refresh"];
/** Bodies bigger than this are not scanned for ids. */
const ID_SCAN_LIMIT = 3_000_000;
/** Longest an agent may wait on one element; Playwright's 0 ("forever") would hang the runner. */
const MAX_WAIT_MS = 60_000;

// What a control says: its accessible name, then its text, then (for icon buttons) an SVG title,
// an icon's <use> name or its class names, so an unlabelled trash icon still reads "trash".
const LABEL_JS = `(el) => {
  const attr = (n) => (el.getAttribute && el.getAttribute(n)) || '';
  const svgTitle = el.querySelector && el.querySelector('svg title');
  const use = el.querySelector && el.querySelector('svg use');
  const icon = use ? (use.getAttribute('href') || use.getAttribute('xlink:href') || '') : '';
  const words = (s) => String(s || '').replace(/^#/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_.#:/]+/g, ' ').split(/\\s+/).filter((w) => w.length > 2 && !/\\d/.test(w)).join(' ');
  const text = attr('aria-label') || attr('title') || el.innerText || el.value || (svgTitle && svgTitle.textContent) || words(icon) || words(attr('class'));
  return String(text || '').trim().slice(0, 200);
}`;
const INIT = `(() => {
  const label = ${LABEL_JS};
  const pick = (el) => el && el.closest && el.closest('button,a,[role=button],[role=link],[role=menuitem],[role=tab],[role=option],[onclick],input[type=submit],input[type=button],summary,label');
  document.addEventListener('click', (e) => { const el = pick(e.target); if (el) window.__baselineClick(label(el)); }, true);
  // A form sent by its button counts as that button's click. Enter in a field with no submit
  // button has no control to read, so it isn't recorded as an (unlabelled) click.
  document.addEventListener('submit', (e) => { if (e.submitter) window.__baselineClick(label(e.submitter)); }, true);
})();`;
const labelOf = new Function(`return (${LABEL_JS})`)() as (el: Element) => string;

type NetEntry = { at: string; method: string; host: string; path: string; type: string; outcome: string };

/** Everything the handlers share for one open session. */
type Ctx = {
  o: OpenOptions;
  runner: Runner;
  cfg: ProjectConfig;
  baseUrl: string;
  baseHost: string;
  learned: Set<string>;
  learnedPath: string;
  clicks: ClickAttribution;
  owned: OwnedTracker;
  state: { loading: boolean; agentNav: boolean };
  network: NetEntry[];
  page?: Page;
  block(entry: Omit<BlockedEntry, "runner" | "at">): void;
  logNet(entry: NetEntry): void;
};

/**
 * The guard's view of the run, only from Baseline's own copies made by `run new`: agents and
 * scripts can write the run folder and the project config, so neither is trusted. A run without
 * those copies can't open a browser.
 */
function guardState(o: OpenOptions) {
  const start = "Start a new run with /baseline:run.";
  const run = readTrustedRun(o.runDir);
  if (!run) throw new Error(`Baseline has no record of starting this run. ${start}`);
  const cfg = readJsonFile(trustedFiles.config(o.runDir), (v) => projectConfigSchema.parse(v), undefined);
  if (!cfg) throw new Error(`This run has no saved config. ${start}`);
  const runner = cfg.runners.find((r) => r.key === o.runner.key);
  if (!runner) throw new Error(`Runner "${o.runner.key}" wasn't set up when this run started. ${start}`);
  // Learned per runner, never shared: one account's page loads don't unlock another's writes.
  const learnedPath = trustedFiles.learned(o.runDir, runner.key);
  const learned = new Set(readJsonFile(learnedPath, (v) => (Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : []), []));
  return { cfg, runner, baseUrl: run.url, baseHost: new URL(run.url).host, learned, learnedPath };
}

const isWriteMethod = (m: string) => m !== "GET" && m !== "HEAD";

async function onRequest(c: Ctx, route: Route): Promise<void> {
  try {
    const r = route.request();
    const method = r.method();
    const u = new URL(r.url());
    const write = isWriteMethod(method);
    // Only requests from the main frame, after the new page committed, count as "the page loading".
    const page = c.page;
    const loading = c.state.loading && !!page && r.frame() === page.mainFrame() && (() => { try { return new URL(page.url()).host === c.baseHost; } catch { return false; } })();
    // A write on the site with no click yet waits a moment for a late click binding; other hosts don't.
    const clicks = write && !c.state.loading && u.host === c.baseHost ? await c.clicks.viewForWrite() : c.clicks.view();
    const body = r.postData() ?? undefined;
    c.owned.refresh();
    const d = decide(
      { method, url: r.url(), loading, clickText: clicks.text, clickWordless: clicks.wordless, body, document: r.isNavigationRequest() && r.resourceType() === "document" },
      { runner: c.runner, cfg: c.cfg, learned: c.learned, baseHost: c.baseHost, createdPaths: c.owned.paths },
    );
    if (write && !loading && u.host === c.baseHost) c.clicks.decided(clicks, d.action === "continue");
    const entry = { method, host: u.host, path: redactUrl(r.url()) };
    if (d.action === "abort") {
      c.block({ ...entry, category: d.category, reason: d.reason, ...(d.trigger ? { trigger: d.trigger } : {}) });
      c.logNet({ at: new Date().toISOString(), ...entry, type: r.resourceType(), outcome: `blocked:${d.category}` });
      return await route.abort("blockedbyclient");
    }
    if (d.learn) { c.learned.add(d.learn); writeFileSync(c.learnedPath, JSON.stringify([...c.learned], null, 2), { mode: 0o600 }); }
    if (u.host === c.baseHost) {
      // Static files still count as places an id was seen; only the sent log leaves them out.
      if (!write && STATIC.has(r.resourceType())) c.owned.seeUrl(r.url());
      else {
        const clean = c.owned.seeRequest(r.url(), body, write);
        if (write && !loading) c.owned.wrote(Date.now(), clean);
        else if (!clean) c.owned.markUnclear();
      }
      if (!STATIC.has(r.resourceType())) c.logNet({ at: new Date().toISOString(), ...entry, type: r.resourceType(), outcome: "allowed" });
    }
    return await route.continue();
  } catch {
    // Fail closed: if anything in the guard breaks, the request does not go out.
    return route.abort("failed").catch(() => {});
  }
}

/**
 * What this run created, as the site itself reported it: the Location of a 201 Created answer to a
 * write the guard allowed. Agents can't add to this; created() is only metadata for the report.
 * Every other same-site response is read for ids, so an id already on a page is never "new".
 */
async function onResponse(c: Ctx, res: Response): Promise<void> {
  let u: URL;
  try { u = new URL(res.url()); } catch { return; }
  if (u.host !== c.baseHost) return;
  const req: Request = res.request();
  const headers = res.headers();
  if (isWriteMethod(req.method())) {
    const loc = headers["location"];
    if (loc && res.status() === 201) { try { const l = new URL(loc, res.url()); if (l.host === c.baseHost) c.owned.add(l.pathname); } catch { /* ignore */ } }
    // Where the site sends the browser after a write is its reply too: a redirect's Location or
    // a framework's redirect header. Only those headers, only same-site, ids from the path only.
    else {
      for (const name of REDIRECT_HEADERS) {
        const raw = headers[name];
        if (!raw) continue;
        // htmx HX-Location may be JSON ({"path": ...}); Refresh is "0; url=...". Next adds ";push".
        let target = raw;
        try { const j: unknown = JSON.parse(raw); if (isRecord(j) && typeof j.path === "string") target = j.path; } catch { /* plain */ }
        target = (target.replace(/^\s*\d+\s*;\s*url=/i, "").split(";")[0] ?? "").trim();
        try { const t = new URL(target, res.url()); if (t.host === c.baseHost) c.owned.seeReplyPath(t.pathname); } catch { /* ignore */ }
      }
    }
  }
  if (STATIC.has(req.resourceType())) return;
  if (!/text|json|javascript|x-component/i.test(headers["content-type"] ?? "")) return;
  if (Number(headers["content-length"] ?? 0) > ID_SCAN_LIMIT) return;
  const body = await res.text().catch(() => "");
  if (body.length <= ID_SCAN_LIMIT) c.owned.seeText(body);
}

/** WebSockets: same rules as requests (see wsDecide). */
async function guardWebSockets(c: Ctx, context: BrowserContext): Promise<void> {
  await context.routeWebSocket(/.*/, (ws) => {
    const u = new URL(ws.url().replace(/^ws/i, "http"));
    const entry = { method: "WS", host: u.host, path: redactUrl(u.toString()) };
    const open = wsDecide({ url: ws.url(), loading: c.state.loading }, { runner: c.runner, cfg: c.cfg });
    if (open.action === "abort") { c.block({ ...entry, category: open.category, reason: open.reason }); ws.close(); return; }
    const server = ws.connectToServer();
    ws.onMessage((msg) => {
      // Binary frames are decoded so they are checked like text.
      const text = typeof msg === "string" ? msg : Buffer.from(msg).toString("utf8");
      const d = wsDecide({ url: ws.url(), loading: c.state.loading, message: text }, { runner: c.runner, cfg: c.cfg });
      if (d.action === "abort") { c.block({ ...entry, category: d.category, reason: d.reason, ...(d.trigger ? { trigger: d.trigger } : {}) }); return; }
      server.send(msg);
    });
  });
}

/** Pages the browser loaded (not client-side route changes), so landings can tell them apart. */
function watchLandings(c: Ctx, page: Page): void {
  const docLoads = new Set<string>();
  const noHash = (url: string) => url.split("#")[0] ?? url;
  page.on("request", (r) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) {
      if (docLoads.size > 50) docLoads.clear();
      docLoads.add(noHash(r.url()));
    }
  });
  // Where the browser lands right after a write: a new id there is a record this run created.
  page.on("framenavigated", (f) => {
    if (f !== page.mainFrame()) return;
    // A click whose write has already been judged ends when the page moves on: requests after
    // that (a list refreshing after a redirect) are the new page's own. A click whose write hasn't
    // gone out yet stays live, so a page that changes route before sending is still judged.
    c.clicks.navigated();
    const document = docLoads.delete(noHash(f.url()));
    try { if (new URL(f.url()).host === c.baseHost) c.owned.landed(f.url(), Date.now(), c.state.agentNav, { document }); } catch { /* ignore */ }
  });
}

/** The agent's actions on the page. The parent records what is clicked before the click happens. */
function actions(c: Ctx, page: Page, browser: Browser): Session {
  const { o } = c;
  const loc = (t: Target): Locator => {
    let l: Locator;
    if ("role" in t) l = page.getByRole(t.role as Parameters<Page["getByRole"]>[0], t.name !== undefined ? { name: t.name, ...(t.exact !== undefined ? { exact: t.exact } : {}) } : undefined);
    else if ("text" in t) l = page.getByText(t.text, t.exact !== undefined ? { exact: t.exact } : undefined);
    else if ("label" in t) l = page.getByLabel(t.label);
    else if ("placeholder" in t) l = page.getByPlaceholder(t.placeholder);
    else if ("testId" in t) l = page.getByTestId(t.testId);
    else l = page.locator(t.css);
    return t.nth !== undefined ? l.nth(t.nth) : l.first();
  };
  /**
   * Note what the agent is about to act on. A click always counts as a click (even an unlabelled
   * one: the wordless rule judges it). Typing, choosing and pressing keys only lend their words
   * when the control has some: an unlabelled search box must not make its autosave "wordless".
   */
  const noteTarget = async (l: Locator, kind: "click" | "input" = "click") => {
    const label = String((await l.evaluate(labelOf, undefined, { timeout: 5000 }).catch(() => "")) || "").trim();
    if (kind === "input" && !label) return;
    c.clicks.record(label);
    if (kind === "click") c.owned.clicked();
  };
  const afterNav = async () => {
    if (await isSignedOut(page, c.runner)) throw new SignedOutError(c.runner.key, new URL(page.url()).pathname);
  };
  // After an action: give a navigation a moment to land, then check the runner is still signed in.
  const settle = async () => {
    await page.waitForLoadState("domcontentloaded", { timeout: 2000 }).catch(() => {});
    await afterNav();
  };
  /** A navigation the agent asked for: its page load may learn writes, and nothing it lands on is "created". */
  const agentNavigation = async (go: () => Promise<unknown>) => {
    try {
      c.state.agentNav = true;
      await go();
      c.state.loading = true;
      await page.waitForLoadState("load");
      await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
    } finally {
      c.state.loading = false;
      c.state.agentNav = false;
    }
    // Never let an agent sign in again on its own: a signed-out runner stops here.
    await afterNav();
  };

  let shots = 0;
  return {
    page,
    async goto(path: string) {
      const base = new URL(c.baseUrl);
      let target: URL | undefined;
      try { target = path.startsWith("//") ? undefined : new URL(path, base); } catch { target = undefined; }
      if (!target || !/^https?:$/.test(target.protocol) || target.origin !== base.origin) {
        throw new Error(`goto only goes to pages on ${base.origin}. Use a path like /cart.`);
      }
      const url = target.toString();
      await agentNavigation(() => page.goto(url, { waitUntil: "commit" }));
    },
    async click(t) { const l = loc(t); await noteTarget(l); await l.click(); await settle(); },
    async fill(t, value) { const l = loc(t); await noteTarget(l, "input"); await l.fill(value); },
    async press(key, t) {
      if (t) { const l = loc(t); await noteTarget(l, "input"); await l.press(key); }
      else {
        // Only note a focused element: with nothing focused there is nothing to read (and waiting
        // for ":focus" would take the full timeout).
        const focused = await page.evaluate(() => !!document.activeElement && document.activeElement !== document.body).catch(() => false);
        if (focused) await noteTarget(page.locator(":focus"), "input");
        await page.keyboard.press(key);
      }
      await settle();
    },
    async select(t, value) { const l = loc(t); await noteTarget(l, "input"); await l.selectOption(value); },
    async check(t) { const l = loc(t); await noteTarget(l, "input"); await l.check(); },
    async hover(t) { await loc(t).hover(); },
    async back() { await agentNavigation(() => page.goBack({ waitUntil: "commit" })); },
    async waitFor(t, opts) {
      const ms = opts?.timeout;
      const timeout = ms === undefined ? undefined : ms > 0 ? Math.min(ms, MAX_WAIT_MS) : MAX_WAIT_MS;
      await loc(t).waitFor({ state: opts?.state ?? "visible", ...(timeout !== undefined ? { timeout } : {}) });
    },
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
      appendJsonl(join(o.runDir, "shots.jsonl"), { runner: o.runner.key, name: safe, path: rel, caption, at: new Date().toISOString() } satisfies ShotEntry);
      return rel;
    },
    async fixture(name: string) {
      const available = fixtureNames();
      if (typeof name !== "string" || !FIXTURE_NAME.test(name) || !available.includes(name)) {
        throw new Error(`There is no fixture called ${JSON.stringify(String(name))}. Fixtures: ${available.join(", ") || "none"}.`);
      }
      // Into the run folder, so the script's own read permission covers the file it gets back.
      mkdirSync(join(o.runDir, "fixtures"), { recursive: true });
      copyFileSync(join(shippedFixtures(), name), join(o.runDir, "fixtures", name));
      return join("fixtures", name);
    },
    async upload(t, paths) {
      // Refuse first: a path outside the run folder never reaches the page or the input at all.
      uploadPaths(o.runDir, paths);
      const l = loc(t);
      await noteTarget(l, "input");
      // Then check again, right before the browser reads them. The script is a separate process
      // that may write its run folder while this call is in flight, so a path that was inside the
      // folder a moment ago (before the round-trip above) is not proof enough on its own.
      await l.setInputFiles(uploadPaths(o.runDir, paths));
    },
    /**
     * What this runner says it created. The cleaner navigates from these entries, so an address
     * here has to be real: the page the browser is actually on is always recorded as `pageUrl`,
     * a `url` on another site is refused outright, and a template (`/projects/<id>`) is kept as
     * `urlUnusable` rather than stored as somewhere to go (spec 3.7).
     */
    created(kind: string, label: string, url?: string) {
      const pageUrl = page.url();
      const base = new URL(c.baseUrl);
      let address: string | undefined;
      let unusable = false;
      if (url === undefined) {
        // Nothing given: the page it is on is the best answer, and it is ours, not the agent's.
        try { const u = new URL(pageUrl); if (u.origin === base.origin) address = u.pathname + u.search; } catch { /* no address */ }
      } else if (isPlaceholderUrl(url)) {
        unusable = true;
      } else {
        let u: URL | undefined;
        try { u = new URL(url, base); } catch { u = undefined; }
        if (!u || u.origin !== base.origin) {
          throw new Error(`created() refuses "${url}": it is on another site, not ${base.origin}. Pass the record's own path, or leave it out and Baseline records the page you are on.`);
        }
        address = u.pathname + u.search;
      }
      // Labels start with "Baseline <runId>" (see agents/cleaner.md).
      const entry = {
        runner: o.runner.key, kind, label,
        ...(address ? { url: address } : {}),
        urlUnusable: unusable,
        pageUrl,
        // Only true when the browser itself watched the site create this path.
        confirmed: !!address && c.owned.paths.includes(address.split("?")[0] ?? address),
        labelled: label.trim().startsWith(`Baseline ${o.runId}`),
        at: new Date().toISOString(),
      };
      appendJsonl(join(o.runDir, "created.jsonl"), entry);
      // Baseline's own copy, out of agents' reach: `baseline created` reads this one.
      appendCreated(o.runDir, entry);
    },
    async close() {
      writeFileSync(join(o.runDir, "logs", `${o.runner.key}-network.json`), JSON.stringify(c.network, null, 2));
      appendFileSync(join(o.runDir, "logs", "sessions.log"), `${new Date().toISOString()} closed ${o.runner.key}\n`);
      await browser.close();
    },
  };
}

export async function openSession(o: OpenOptions): Promise<Session> {
  for (const d of ["logs", "shots"]) mkdirSync(join(o.runDir, d), { recursive: true });
  const g = guardState(o);
  const blockedTrusted = trustedFiles.blocked(o.runDir);
  const c: Ctx = {
    o, runner: g.runner, cfg: g.cfg, baseUrl: g.baseUrl, baseHost: g.baseHost, learned: g.learned, learnedPath: g.learnedPath,
    clicks: new ClickAttribution(),
    // What this run created, shared by every runner in the run (see owned.ts).
    owned: new OwnedTracker(ownedFile(o.runDir)),
    state: { loading: false, agentNav: false },
    network: [],
    block(entry) {
      const item = { at: new Date().toISOString(), runner: o.runner.key, ...entry };
      appendJsonl(blockedTrusted, item, 0o600); // the report reads this one
      appendJsonl(join(o.runDir, "blocked.jsonl"), item); // the agents' copy
    },
    logNet(entry) {
      if (c.network.length >= NETWORK_LIMIT) c.network.shift();
      c.network.push(entry);
    },
  };

  const { chromium } = loadPlaywright();
  const browser: Browser = await chromium.launch({ headless: o.headless ?? true });
  try {
    const context: BrowserContext = await browser.newContext({
      baseURL: g.baseUrl,
      serviceWorkers: "block",
      ...(o.storageState && existsSync(o.storageState) ? { storageState: o.storageState } : {}),
    });
    context.setDefaultTimeout(15000);
    await context.exposeBinding("__baselineClick", (_src, t: unknown) => { c.clicks.record(String(t || "")); });
    await context.addInitScript({ content: INIT });
    await context.route("**/*", (route) => onRequest(c, route));
    await guardWebSockets(c, context);
    context.on("response", (res) => { void onResponse(c, res).catch(() => {}); });

    const page = await context.newPage();
    c.page = page;
    watchLandings(c, page);
    // Nothing may skip the guard: Playwright's own request APIs are switched off.
    const deny = async () => { throw new Error("Baseline: direct API requests are not allowed. Drive the page instead."); };
    const denied = Object.fromEntries(["fetch", "get", "post", "put", "patch", "delete", "head"].map((m) => [m, deny]));
    for (const api of new Set([context.request, page.request])) Object.assign(api, denied);
    return actions(c, page, browser);
  } catch (e) {
    // Never leave a browser running when the session could not be set up.
    await browser.close().catch(() => {});
    throw e;
  }
}
