import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
afterAll(() => f.stop());

function project() {
  const proj = mkdtempSync(join(tmpdir(), "proj-"));
  const data = mkdtempSync(join(tmpdir(), "data-"));
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
  const runDir = join(proj, ".baseline", "runs", "r-test");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId: "r-test", url: f.url }));
  return { proj, env, runDir };
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
