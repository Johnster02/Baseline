// Retakes the README screenshots in docs/screenshots from a made-up sample run.
// Uses the built CLI (dist/), so run `pnpm build` first; `pnpm screenshots` does both.
// Needs Playwright's Chromium (`pnpm exec playwright install chromium`) and a network
// connection for the report's Google Fonts.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.cjs");
const OUT = join(ROOT, "docs", "screenshots");
const WIDTH = 1440, SCALE = 1.5;

const work = mkdtempSync(join(tmpdir(), "baseline-shots-"));
const project = join(work, "acme-shop");
const session = join(project, ".baseline", "sessions", "sample");
const browser = await chromium.launch();

try {
  // 1. An evidence screenshot of the sample shop, as an explorer would take it.
  const shop = await browser.newPage({ viewport: { width: 980, height: 520 }, deviceScaleFactor: 2 });
  await shop.goto("file://" + join(ROOT, "scripts", "screenshots", "sample-cart.html"));
  const evidence = await shop.screenshot({ type: "jpeg", quality: 85 });

  // 2. A session with two runs of the same PR.
  writeSession(evidence);
  execFileSync("node", [CLI, "report", session], { cwd: project, stdio: "ignore" });
  const report = join(session, "report.html");

  // 3. The report in each theme, with the first finding open, cut just below the second.
  for (const skin of ["br2049", "light", "dark"]) {
    const p = await browser.newPage({ viewport: { width: WIDTH, height: 1000 }, deviceScaleFactor: SCALE, reducedMotion: "reduce" });
    await p.goto("file://" + report);
    await p.waitForLoadState("networkidle");
    await p.evaluate(() => document.fonts.ready);
    await p.click(`button[data-skin="${skin}"]`);
    await p.evaluate(() => { document.querySelector("section.run:not([hidden]) details.f").open = true; });
    await p.waitForTimeout(600);
    const bottom = await p.evaluate(() => Math.ceil(document.querySelectorAll("section.run:not([hidden]) details.f")[1].getBoundingClientRect().bottom + scrollY + 4));
    await p.setViewportSize({ width: WIDTH, height: bottom });
    await p.screenshot({ path: join(OUT, `report-${skin}.png`), clip: { x: 0, y: 0, width: WIDTH, height: bottom } });
  }

  // 4. The terminal: the live band mid-run, and the end-of-run summary.
  const env = { ...process.env, COLORTERM: "truecolor" };
  delete env.NO_COLOR;
  const done = join(session, "runs", "r-20261023-1414");
  const summary = execFileSync("node", [CLI, "summary", done, "--link", "https://claude.ai/artifact/7f3c…"], { cwd: project, env, encoding: "utf8" });
  const live = join(session, "runs", "live");
  mkdirSync(live, { recursive: true });
  cpSync(join(done, "run.json"), join(live, "run.json"));
  writeFileSync(join(live, "progress.json"), JSON.stringify(liveProgress()));
  writeFileSync(join(project, ".baseline", "active-run"), live);
  const view = execFileSync("node", [CLI, "view"], { cwd: project, env, encoding: "utf8" });
  const term = join(work, "terminal.html");
  // Show a tidy local path instead of this temp folder. "// " is the header, not a path.
  writeFileSync(term, terminalPage(ansiToHtml(view), ansiToHtml(summary.replace(/(m)\/(?!\/)[^\x1b\n]+/g, "$1~/acme-shop/.baseline/sessions/…/report.html"))));
  const t = await browser.newPage({ viewport: { width: WIDTH, height: 600 }, deviceScaleFactor: SCALE });
  await t.goto("file://" + term);
  await t.waitForLoadState("networkidle");
  await t.evaluate(() => document.fonts.ready);
  await t.locator("body").screenshot({ path: join(OUT, "terminal.png") });

  console.log("screenshots written to docs/screenshots");
} finally {
  await browser.close();
  rmSync(work, { recursive: true, force: true });
}

function writeSession(evidence) {
  const permissions = [
    { runner: "customer", can: ["browse and read", "create and tidy test orders"], cannot: ["send email", "take payment"] },
    { runner: "guest", can: ["browse and read"], cannot: ["submit forms"] },
  ];
  const kept = (note) => ({ kept: true, note });
  const findings = [
    { id: "R-01", title: "Expired discount code still takes 10% off", verdict: "spec-built", severity: "high", personas: ["customer"], route: "/cart",
      specced: { text: "Expired codes are rejected at checkout with a clear message.", ref: "PR #412 · R2" },
      built: { text: "Expiry is only checked when the code is created, never when it is applied.", ref: "src/cart/discount.ts:88" },
      observed: { text: "SPRING24 expired on 30 Sep, but applied cleanly and took $6.00 off the cart.", shots: ["shots/customer-cart-1.jpg"], steps: ["Sign in as customer", "Open /cart with two items", "Enter SPRING24", "Press Apply"] },
      refuter: kept("Reproduced twice on a fresh cart; the code's end date is in the past.") },
    { id: "R-02", title: "Order confirmation email leaves out the discount", verdict: "built-observed", severity: "medium", personas: ["customer"], route: "/orders",
      specced: { text: "Receipts show each discount as its own line.", ref: "PR #412 · R4" },
      built: { text: "The receipt template renders a discount line.", ref: "emails/receipt.tsx:41" },
      observed: { text: "The order page preview shows the total after discount, with no discount line.", steps: ["Place an order with SPRING10", "Open /orders/latest"] },
      refuter: kept("The template has the line, but the order payload never sends the discount.") },
    { id: "U-customer-1", title: "Discount field greys out with no reason given", verdict: "product", severity: "medium", personas: ["customer"], route: "/cart", checklistItem: "U-02",
      specced: { text: "Not covered by the spec.", ref: "product checklist U-02" },
      observed: { text: "After one failed code the field is disabled and nothing says why or for how long.", steps: ["Enter WRONG1", "Press Apply"] },
      refuter: kept("Disabled state has no message or tooltip.") },
    { id: "R-03", title: "Guests are asked to sign in before using a code", verdict: "unverified", severity: "low", personas: ["guest"], route: "/cart",
      specced: { text: "Guests must sign in to apply a discount code.", ref: "PR #412 · R5" },
      built: { text: "The apply route requires a session.", ref: "src/cart/routes.ts:23" },
      observed: { text: "The guest runner is look-only, so the code was never submitted." } },
    ...[
      ["R-04", "Valid codes apply at checkout", "Valid codes take the right amount off."],
      ["R-05", "Codes are not case-sensitive", "spring10 and SPRING10 behave the same."],
      ["R-06", "Only one code per order", "A second code replaces the first."],
      ["R-07", "Removing a code restores the total", "Removing the code puts the total back."],
      ["R-08", "Free shipping stays with a code", "Shipping is still free over $50."],
      ["R-09", "Discount shows on the order summary", "The checkout summary lists the discount."],
    ].map(([id, title, text]) => ({ id, title, verdict: "match", severity: "low", personas: ["customer"], route: "/cart",
      // Each needs its own spec ref, or the report merges them as duplicates.
      specced: { text, ref: `PR #412 · ${id.replace("R-0", "R")}` }, built: { text: "Implemented as specced.", ref: "src/cart/discount.ts" },
      observed: { text: "Seen working on the site.", steps: [] } })),
  ];
  const run = (id, label, start, end, list) => {
    const d = join(session, "runs", id);
    mkdirSync(join(d, "shots"), { recursive: true });
    writeFileSync(join(d, "shots", "customer-cart-1.jpg"), evidence);
    writeFileSync(join(d, "run.json"), JSON.stringify({ runId: id, url: "https://staging.acme.dev", label, startedAt: start, permissions }));
    writeFileSync(join(d, "inputs.json"), JSON.stringify({ items: [{ ref: { kind: "github-pr", ref: "412" } }] }));
    writeFileSync(join(d, "progress.json"), JSON.stringify({ size: "pr", agents: 3, startedAt: start, finishedAt: end }));
    writeFileSync(join(d, "commit.json"), JSON.stringify({ codeRead: true, commitRead: "a41c9e2", mismatch: false }));
    writeFileSync(join(d, "findings.json"), JSON.stringify(list));
  };
  run("r-20261023-1414", "PR #412 · Discount codes", "2026-10-23T14:14:00Z", "2026-10-23T14:18:54Z", findings);
  run("r-20261023-1302", "PR #412 · first pass", "2026-10-23T13:02:00Z", "2026-10-23T13:07:10Z", [...findings.slice(0, 3), ...findings.slice(4, 7)]);
}

/** Explore about three quarters done, timed relative to now so the estimate lands near 72%. */
function liveProgress() {
  const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
  return {
    runId: "r-20261023-1414", label: "PR #412 · Discount codes", size: "pr", agents: 3, startedAt: ago(161),
    phases: [
      { name: "gather", status: "done", note: "PR #412, 6 files" },
      { name: "read-code", status: "done", note: "discount.ts, routes.ts" },
      { name: "explore", status: "active", pct: 50, pctAt: ago(40), since: ago(75) },
      { name: "verdicts", status: "pending" }, { name: "refute", status: "pending" }, { name: "clean-up", status: "pending" },
    ],
    active: [{ persona: "customer", doing: "applying SPRING24 at checkout" }],
    counts: { checked: 3, passed: 2, passRate: 67, conflicts: 1, product: 1, unverified: 0, unspecced: 0, skipped: 0 },
  };
}

function ansiToHtml(text) {
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  let color, out = "";
  for (const part of text.split(/(\x1b\[[0-9;]*m)/)) {
    const m = part.match(/^\x1b\[38;2;(\d+);(\d+);(\d+)m$/);
    if (m) { color = `rgb(${m[1]},${m[2]},${m[3]})`; continue; }
    if (part.startsWith("\x1b[")) { color = undefined; continue; }
    if (part) out += color ? `<span style="color:${color}">${esc(part)}</span>` : esc(part);
  }
  return out.replace(/\n+$/, "");
}

function terminalPage(view, summary) {
  const win = (caption, body) => `<div class="col"><div class="cap">${caption}</div><div class="win"><div class="bar"><i></i><i></i><i></i><span>claude — acme-shop</span></div><pre>${body}</pre></div></div>`;
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Inter:wght@500&display=swap">
<style>
*{box-sizing:border-box;margin:0}
body{background:radial-gradient(120% 90% at 30% 0%,#2a2820 0%,#121109 55%,#0b0a07 100%);padding:48px 52px;width:${WIDTH}px;font-family:Inter,sans-serif;display:inline-block}
.wrap{display:flex;gap:36px;align-items:flex-start}.col{flex:1}
.cap{color:#a39b8a;font-size:15px;letter-spacing:.08em;text-transform:uppercase;margin:0 0 14px 4px}
.win{background:#16150f;border:1px solid #34312a;border-radius:12px;box-shadow:0 30px 60px rgba(0,0,0,.55);overflow:hidden}
.bar{height:38px;display:flex;align-items:center;gap:8px;padding:0 14px;background:#1e1c16;border-bottom:1px solid #2b2922;position:relative}
.bar i{width:12px;height:12px;border-radius:50%;background:#ff5f57}.bar i:nth-child(2){background:#febc2e}.bar i:nth-child(3){background:#28c840}
.bar span{position:absolute;left:0;right:0;text-align:center;color:#847c6d;font-size:13px}
pre{font:500 16px/1.62 "IBM Plex Mono",monospace;color:#eee8d8;padding:22px 24px 26px;white-space:pre}
.p{color:#847c6d}
</style></head><body><div class="wrap">
${win("While it runs", `<span class="p">&gt; </span>/baseline:run #412\n<span class="p">  PR run, 3 agents</span>\n\n${view}`)}
${win("When it ends", summary)}
</div></body></html>`;
}
