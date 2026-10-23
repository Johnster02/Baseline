import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startFixture } from "./fixture-app/server";
import { sessionPath } from "../src/config/secrets";

const ROOT = resolve(__dirname, "..");
let f: Awaited<ReturnType<typeof startFixture>>;
beforeAll(async () => {
  execFileSync("node", ["scripts/build.mjs"], { cwd: ROOT });
  f = await startFixture();
});
// Every project's shared-browser hosts, so none outlive the tests.
const dataDirs: string[] = [];
afterAll(() => {
  for (const d of dataDirs) {
    let files: string[] = [];
    try { files = readdirSync(join(d, "hosts")).filter((x) => /^[0-9a-f]{16}\.json$/.test(x)); } catch { files = []; }
    for (const x of files) { try { process.kill(JSON.parse(readFileSync(join(d, "hosts", x), "utf8")).pid, "SIGTERM"); } catch { /* gone */ } }
  }
  f.stop();
});

function project() {
  const proj = mkdtempSync(join(tmpdir(), "proj-"));
  const data = mkdtempSync(join(tmpdir(), "data-"));
  dataDirs.push(data);
  const env = { ...process.env, BASELINE_DATA: data };
  const cli = (args: string[]) => spawnSync("node", [join(ROOT, "dist/cli.cjs"), ...args], { cwd: proj, env, encoding: "utf8" });
  cli(["config", "add-runner", "customer", "customer", "session"]);
  cli(["config", "add-runner", "admin", "admin", "session"]);
  cli(["config", "depth", "admin", "workflow"]);
  for (const k of ["customer", "admin"]) {
    const sp = sessionPath(data, proj, k);
    mkdirSync(join(sp, ".."), { recursive: true });
    writeFileSync(sp, JSON.stringify({ cookies: [{ name: "sid", value: "ok", domain: new URL(f.url).hostname, path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] }));
  }
  // A real run: Baseline only opens browsers for runs it recorded starting.
  const started = cli(["run", "new", "--url", f.url, "--label", "test"]);
  const runDir = (JSON.parse(started.stdout) as { runDir: string }).runDir;
  return { proj, env, runDir, cli };
}

const runScript = (p: ReturnType<typeof project>, body: string, extra: string[] = ["--run", p.runDir]) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((res) => {
    const file = join(p.runDir, `walk-${Math.random().toString(36).slice(2)}.cjs`);
    writeFileSync(file, `const B = require("baseline");\n(async () => {\n${body}\n})().catch((e) => { console.error("ERR " + e.message); process.exit(1); });`);
    // Async: the fixture runs in this process, so a blocking spawn would deadlock it.
    const c = spawn("node", [join(ROOT, "dist/cli.cjs"), "script", "customer", file, ...extra], { cwd: p.proj, env: p.env });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (code) => res({ code, stdout, stderr }));
  });

describe("baseline script (browser in the parent, script talks over IPC)", () => {
  it("drives the page through the command API and the guard still blocks writes", async () => {
    const p = project();
    f.requests.length = 0;
    const r = await runScript(p, `const s = await B.open(); await s.goto("/cart"); console.log("TITLE " + await s.title());
      const snap = await s.snapshot(); console.log("SNAP " + snap.includes("Apply discount"));
      await s.click({ role: "button", name: "Apply discount" }); await s.waitFor({ text: "failed" }); await s.close();`);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("TITLE Cart");
    expect(r.stdout).toContain("SNAP true");
    expect(f.requests.some((x) => x.method === "POST" && x.path === "/api/cart")).toBe(false);
  });

  it("the script gets no Playwright page, context or browser", async () => {
    const p = project();
    const r = await runScript(p, `const s = await B.open(); console.log("KEYS " + ["page","context","browser","request"].filter((k) => k in s).join(",")); await s.close();`);
    expect(r.stdout).toContain("KEYS \n");
  });

  it("changing env inside the script cannot switch to another runner", async () => {
    const p = project();
    const r = await runScript(p, `process.env.BASELINE_RUNNER = "admin"; const s = await B.open(); console.log("RUNNER " + s.runner); await s.close();`);
    expect(r.stdout).toContain("RUNNER customer");
  });

  it("an unknown command is refused", async () => {
    const p = project();
    const r = await runScript(p, `const s = await B.open(); await s.call("evaluate", "fetch('/api/cart',{method:'POST'})");`);
    expect(r.stderr).toMatch(/not an allowed command/);
  });

  it("finds the run from .baseline/active-run when --run is not given", async () => {
    const p = project();
    writeFileSync(join(p.proj, ".baseline", "active-run"), p.runDir);
    const r = await runScript(p, `const s = await B.open(); console.log("OK"); await s.close();`, []);
    expect(r.stdout).toContain("OK");
  });

  it("keeps one browser per runner: the next script starts where the last one left off", async () => {
    const p = project();
    writeFileSync(join(p.proj, ".baseline", "active-run"), p.runDir);
    const hostPids = () => readdirSync(join(p.env.BASELINE_DATA as string, "hosts")).filter((x) => /^[0-9a-f]{16}\.json$/.test(x))
      .map((x) => JSON.parse(readFileSync(join(p.env.BASELINE_DATA as string, "hosts", x), "utf8")).pid);
    const a = await runScript(p, `const s = await B.open(); await s.goto("/cart"); await s.close();`);
    expect(a.stderr).toBe("");
    const first = hostPids();
    expect(first).toHaveLength(1);
    const b = await runScript(p, `const s = await B.open(); console.log("AT " + new URL(await s.url()).pathname); await s.close();`);
    expect(b.stdout).toContain("AT /cart");
    expect(hostPids()).toEqual(first);
  });

  it("a script that never calls close(), or throws first, still exits", async () => {
    const p = project();
    const started = Date.now();
    const r = await runScript(p, `const s = await B.open(); await s.goto("/cart"); console.log("DONE");`);
    expect(r.stdout).toContain("DONE");
    expect(r.code).toBe(0);
    const p2 = project();
    writeFileSync(join(p2.proj, ".baseline", "active-run"), p2.runDir);
    const file = join(p2.runDir, "throws.cjs");
    writeFileSync(file, `const B = require("baseline"); B.open().then(() => { throw new Error("boom"); });`);
    const c = spawn("node", [join(ROOT, "dist/cli.cjs"), "script", "customer", file], { cwd: p2.proj, env: p2.env });
    const code = await new Promise<number | null>((res) => c.on("close", res));
    expect(code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(25_000);
  });

  it("a script can't open its own network connections", async () => {
    const p = project();
    const r = await runScript(p, `const out = [];
      for (const [n, f] of [["http", () => require("http").get(${JSON.stringify("http://127.0.0.1:9/")})], ["net", () => require("net").connect(9, "127.0.0.1")], ["fetch", () => fetch("http://127.0.0.1:9/")]]) {
        try { await f(); out.push(n + ":open"); } catch (e) { out.push(n + ":" + (/network connections/.test(e.message) ? "blocked" : e.message)); }
      }
      console.log("NET " + out.join(" "));
      const s = await B.open(); console.log("TITLE " + (await (async () => { await s.goto("/cart"); return s.title(); })())); await s.close();`);
    expect(r.stdout).toContain("NET http:blocked net:blocked fetch:blocked");
    expect(r.stdout).toContain("TITLE Cart");
  });

  it("run finish closes the run's browsers, and a finished run never keeps one", async () => {
    const p = project();
    writeFileSync(join(p.proj, ".baseline", "active-run"), p.runDir);
    await runScript(p, `const s = await B.open(); await s.goto("/cart"); await s.close();`);
    const hosts = () => { try { return readdirSync(join(p.env.BASELINE_DATA as string, "hosts")).filter((x) => /^[0-9a-f]{16}\.json$/.test(x)).length; } catch { return 0; } };
    expect(hosts()).toBe(1);
    spawnSync("node", [join(ROOT, "dist/cli.cjs"), "run", "finish"], { cwd: p.proj, env: p.env, encoding: "utf8" });
    await vi.waitFor(() => expect(hosts()).toBe(0), { timeout: 15_000, interval: 100 });
    // A script against the finished run gets its own browser and leaves nothing running.
    const r = await runScript(p, `const s = await B.open(); console.log("AT " + await s.url()); await s.close();`);
    expect(r.stdout).toContain("AT about:blank");
    expect(hosts()).toBe(0);
  });

  it("falls back to a browser of its own when the shared one is turned off", async () => {
    const p = project();
    const env = { ...p.env, BASELINE_SHARED_BROWSER: "0" };
    await runScript({ ...p, env }, `const s = await B.open(); await s.goto("/cart"); await s.close();`);
    const r = await runScript({ ...p, env }, `const s = await B.open(); console.log("AT " + await s.url()); await s.close();`);
    expect(r.stdout).toContain("AT about:blank");
  });

  it("refuses a run folder Baseline didn't start, so a script can't be sandboxed in a folder of its choosing", async () => {
    const p = project();
    // A look-alike outside .baseline/sessions (the project root, standing in for a home folder).
    writeFileSync(join(p.proj, "run.json"), JSON.stringify({ runId: "x", url: f.url }));
    const outside = await runScript(p, `console.log("RAN");`, ["--run", p.proj]);
    expect(outside.code).toBe(2);
    expect(outside.stdout).not.toContain("RAN");
    expect(outside.stderr).toMatch(/not a run folder of this project/);
    // Inside .baseline/sessions but never started by `run new`.
    const fake = join(p.proj, ".baseline", "sessions", "s", "runs", "r-fake");
    mkdirSync(fake, { recursive: true });
    writeFileSync(join(fake, "run.json"), JSON.stringify({ runId: "r-fake", url: f.url }));
    const unrecorded = await runScript(p, `console.log("RAN");`, ["--run", fake]);
    expect(unrecorded.code).toBe(2);
    expect(unrecorded.stderr).toMatch(/no record of starting the run/);
  });

  it("refuses an unknown runner", () => {
    const proj = mkdtempSync(join(tmpdir(), "proj-"));
    const r = spawnSync("node", [join(ROOT, "dist/cli.cjs"), "script", "ghost", "x.cjs", "--run", proj], { cwd: proj, encoding: "utf8", env: { ...process.env, BASELINE_DATA: proj } });
    expect(r.status).toBe(2);
  });
});

describe("run from anywhere inside the project (dogfood)", () => {
  it("works from inside the run folder with a relative script path", async () => {
    const p = project();
    const sub = join(p.runDir, "explore", "customer");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(p.proj, ".baseline", "active-run"), p.runDir);
    writeFileSync(join(sub, "walk.cjs"), `const B = require("baseline"); (async () => { const s = await B.open(); console.log("RUNNER " + s.runner); await s.close(); })();`);
    const r = await new Promise<{ stdout: string; stderr: string }>((res) => {
      const c = spawn("node", [join(ROOT, "dist/cli.cjs"), "script", "customer", "walk.cjs"], { cwd: sub, env: p.env });
      let stdout = "", stderr = "";
      c.stdout.on("data", (d) => (stdout += d)); c.stderr.on("data", (d) => (stderr += d));
      c.on("close", () => res({ stdout, stderr }));
    });
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("RUNNER customer");
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(p.runDir, ".baseline"))).toBe(false);
  });
});

describe("agent scripts are sandboxed (security review)", () => {
  it("cannot read the saved session file or start another process", async () => {
    const p = project();
    const secretFile = join(p.env.BASELINE_DATA as string, "sessions");
    const r = await runScript(p, `const fs = require("fs");
      let read = "no"; try { fs.readdirSync(${JSON.stringify(secretFile)}); read = "yes"; } catch (e) {}
      let spawned = "no"; try { require("child_process").execSync("echo hi"); spawned = "yes"; } catch (e) {}
      const s = await B.open(); await s.goto("/cart"); const t = await s.title(); await s.close();
      console.log("READ " + read + " SPAWN " + spawned + " TITLE " + t);`);
    expect(r.stdout).toContain("READ no SPAWN no TITLE Cart");
  });
});
