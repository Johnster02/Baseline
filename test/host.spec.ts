import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stopHosts } from "../src/browser/host";
import { trustedFiles } from "../src/core/paths";

const ROOT = resolve(__dirname, "..");
const prevData = process.env.BASELINE_DATA;
const children: ChildProcess[] = [];
beforeAll(() => { execFileSync("node", ["scripts/build.mjs"], { cwd: ROOT }); });
afterAll(() => {
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
  if (prevData === undefined) delete process.env.BASELINE_DATA; else process.env.BASELINE_DATA = prevData;
});

function project() {
  const proj = mkdtempSync(join(tmpdir(), "hostproj-"));
  const data = mkdtempSync(join(tmpdir(), "hostdata-"));
  const env = { ...process.env, BASELINE_DATA: data };
  spawnSync("node", [join(ROOT, "dist/cli.cjs"), "config", "add-runner", "customer", "customer", "session"], { cwd: proj, env });
  // A real run: the host refuses run folders Baseline didn't start.
  const started = spawnSync("node", [join(ROOT, "dist/cli.cjs"), "run", "new", "--url", "http://127.0.0.1:9", "--label", "t", "--force"], { cwd: proj, env, encoding: "utf8" });
  const runDir = (JSON.parse(started.stdout) as { runDir: string }).runDir;
  return { proj, data, env, runDir };
}

const hostFiles = (data: string) => { try { return readdirSync(join(data, "hosts")).filter((x) => /^[0-9a-f]{16}\.json$/.test(x)); } catch { return []; } };

async function startHost(p: ReturnType<typeof project>, extraEnv: Record<string, string>) {
  const c = spawn("node", [join(ROOT, "dist/cli.cjs"), "browser-host", "customer", "--run", p.runDir], { cwd: p.proj, env: { ...p.env, BASELINE_HOST_WATCH_MS: "100", ...extraEnv }, stdio: "ignore" });
  children.push(c);
  await vi.waitFor(() => expect(hostFiles(p.data).length).toBe(1), { timeout: 10_000, interval: 50 });
  return c;
}
const exited = (c: ChildProcess, ms: number) => new Promise<boolean>((res) => {
  if (c.exitCode !== null) return res(true);
  const t = setTimeout(() => res(false), ms);
  c.once("exit", () => { clearTimeout(t); res(true); });
});

describe("browser host: only for runs Baseline started", () => {
  it("refuses a run folder that `run new` didn't record", () => {
    const p = project();
    const fake = join(p.proj, ".baseline", "sessions", "s", "runs", "r-fake");
    mkdirSync(fake, { recursive: true });
    writeFileSync(join(fake, "run.json"), JSON.stringify({ runId: "r-fake", url: "http://127.0.0.1:9" }));
    const r = spawnSync("node", [join(ROOT, "dist/cli.cjs"), "browser-host", "customer", "--run", fake], { cwd: p.proj, env: p.env, encoding: "utf8", timeout: 10_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no record of starting the run/);
    expect(hostFiles(p.data)).toEqual([]);
  });
});

describe("browser host lifecycle", () => {
  it("closes after an idle spell", async () => {
    const p = project();
    const c = await startHost(p, { BASELINE_HOST_IDLE_MS: "300" });
    expect(await exited(c, 5000)).toBe(true);
    expect(hostFiles(p.data)).toEqual([]);
  });

  it("stays open while a runner is BLOCKED waiting on the user", async () => {
    const p = project();
    mkdirSync(join(p.runDir, "explore", "customer"), { recursive: true });
    writeFileSync(join(p.runDir, "explore", "customer", "blocker.json"), "{}");
    const c = await startHost(p, { BASELINE_HOST_IDLE_MS: "300" });
    expect(await exited(c, 1200)).toBe(false);
    c.kill("SIGTERM");
    expect(await exited(c, 5000)).toBe(true);
  });

  it("closes when its run is marked finished", async () => {
    const p = project();
    const c = await startHost(p, {});
    process.env.BASELINE_DATA = p.data;
    writeFileSync(trustedFiles.finished(p.runDir), "now");
    expect(await exited(c, 5000)).toBe(true);
  });

  it("does not close when another run becomes the active one", async () => {
    const p = project();
    writeFileSync(join(p.proj, ".baseline", "active-run"), p.runDir);
    const c = await startHost(p, {});
    writeFileSync(join(p.proj, ".baseline", "active-run"), join(p.proj, ".baseline", "runs", "r-other"));
    expect(await exited(c, 1000)).toBe(false);
    c.kill("SIGTERM");
    expect(await exited(c, 5000)).toBe(true);
  });
});

describe("stopHosts", () => {
  it("never signals a process that isn't a Baseline host, and forgets its stale info file", () => {
    const p = project();
    process.env.BASELINE_DATA = p.data;
    mkdirSync(join(p.data, "hosts"), { recursive: true });
    const stale = join(p.data, "hosts", "0123456789abcdef.json");
    // This test process is alive but is not a host: a recycled PID.
    writeFileSync(stale, JSON.stringify({ token: "t", socket: join(tmpdir(), "nope.sock"), pid: process.pid, runDir: p.runDir }));
    expect(stopHosts(p.runDir)).toBe(0);
    expect(existsSync(stale)).toBe(false);
  });
});
