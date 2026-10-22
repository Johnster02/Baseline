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

describe("baseline script", () => {
  it("runs an agent script with require('baseline') bound to the runner, behind the guard", async () => {
    const proj = mkdtempSync(join(tmpdir(), "proj-"));
    const data = mkdtempSync(join(tmpdir(), "data-"));
    const env = { ...process.env, BASELINE_DATA: data };
    const cli = (args: string[], input?: string) => spawnSync("node", [join(ROOT, "dist/cli.cjs"), ...args], { cwd: proj, env, encoding: "utf8", input });
    expect(cli(["config", "add-runner", "customer", "customer", "session"]).status).toBe(0);
    const host = new URL(f.url).hostname;
    const sp = sessionPath(data, proj, "customer");
    mkdirSync(join(sp, ".."), { recursive: true });
    writeFileSync(sp, JSON.stringify({ cookies: [{ name: "sid", value: "ok", domain: host, path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] }));
    const runDir = join(proj, ".baseline", "runs", "r-test");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId: "r-test", url: f.url }));
    const script = join(runDir, "walk.cjs");
    writeFileSync(script, `const B = require("baseline");
(async () => { const s = await B.open(); await s.goto("/cart"); console.log("TITLE " + await s.page.title());
  await s.page.getByRole("button", { name: "Apply discount" }).click(); await s.page.getByText("failed").waitFor(); await s.close(); })()
  .catch((e) => { console.error(e); process.exit(1); });`);
    f.requests.length = 0;
    // Async: the fixture runs in this process, so a blocking spawn would deadlock it.
    const r = await new Promise<{ stdout: string; stderr: string }>((res) => {
      const p = spawn("node", [join(ROOT, "dist/cli.cjs"), "script", "customer", script, "--run", runDir], { cwd: proj, env });
      let stdout = "", stderr = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      p.on("close", () => res({ stdout, stderr }));
    });
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("TITLE Cart");
    expect(f.requests.some((x) => x.method === "POST" && x.path === "/api/cart")).toBe(false);
  }, 60000);

  it("refuses an unknown runner", () => {
    const proj = mkdtempSync(join(tmpdir(), "proj-"));
    const r = spawnSync("node", [join(ROOT, "dist/cli.cjs"), "script", "ghost", "x.cjs", "--run", proj], { cwd: proj, encoding: "utf8", env: { ...process.env, BASELINE_DATA: proj } });
    expect(r.status).toBe(2);
  });
});
