// One browser per runner for the whole run. The first `baseline script` for a runner starts this
// host in the background; later scripts reuse its browser, so the page is where the last script
// left it and nobody pays for a fresh launch, session restore and page load every time.
//
// The guard still lives with the browser (openSession), here in the host. Agent scripts never talk
// to the host: `baseline script` relays their allowed commands over a local socket that needs a
// token kept in Baseline's data folder, which the script sandbox cannot read.
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { register } from "../cli";
import { loadConfig } from "../config/store";
import { dataDir, sessionPath } from "../config/secrets";
import { openSession } from "./session";
import type { Session } from "./session";
import { isCommand } from "./rpc";

const IDLE_MS = 10 * 60_000;
const IDLE_FINISHED_MS = 2 * 60_000;
const WATCH_MS = 3_000;
const START_MS = 30_000;

export type HostReply = { id: number; ok: boolean; value?: unknown; error?: string };
export type HostCall = (m: { id: number; method: string; args?: unknown[] }) => Promise<HostReply>;
type HostInfo = { token: string; socket: string; pid: number; runDir: string };

/** Short and per run+runner: socket paths are capped at ~104 characters on macOS. */
export function hostKey(runDir: string, runner: string): string {
  return createHash("sha256").update(resolve(runDir) + "\0" + runner).digest("hex").slice(0, 16);
}
const infoPath = (key: string) => join(dataDir(), "hosts", `${key}.json`);
const socketPath = (key: string) => (process.platform === "win32" ? `\\\\.\\pipe\\baseline-${key}` : join(tmpdir(), `baseline-${key}.sock`));

function readInfo(key: string): HostInfo | undefined {
  try { return JSON.parse(readFileSync(infoPath(key), "utf8")); } catch { return undefined; }
}

/** Close every runner's browser for a run (or all of them), now. Used by `run finish`. */
export function stopHosts(runDir?: string): number {
  const dir = join(dataDir(), "hosts");
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => /^[0-9a-f]{16}\.json$/.test(f)); } catch { return 0; }
  let stopped = 0;
  for (const f of files) {
    let info: HostInfo | undefined;
    try { info = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
    if (!info || (runDir && resolve(info.runDir) !== resolve(runDir))) continue;
    try { process.kill(info.pid, "SIGTERM"); stopped++; } catch { rmSync(join(dir, f), { force: true }); }
  }
  return stopped;
}

/** One request over the socket. Rejects if the host is gone. */
function request(info: HostInfo, msg: { id: number; method: string; args?: unknown[] }, timeoutMs?: number): Promise<HostReply> {
  return new Promise((res, rej) => {
    const sock = createConnection(info.socket);
    let buf = "";
    const timer = timeoutMs ? setTimeout(() => { sock.destroy(); rej(new Error("host timed out")); }, timeoutMs) : undefined;
    sock.on("connect", () => sock.write(JSON.stringify({ ...msg, token: info.token }) + "\n"));
    sock.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      if (timer) clearTimeout(timer);
      sock.end();
      try { res(JSON.parse(buf.slice(0, nl))); } catch (e) { rej(e as Error); }
    });
    sock.on("error", (e) => { if (timer) clearTimeout(timer); rej(e); });
  });
}

/**
 * A live host for this run and runner: reuses one that answers, otherwise starts one and waits
 * for it. Undefined when it can't start, so the caller falls back to a browser of its own.
 */
export async function connectHost(projectDir: string, runDir: string, runner: string, cliPath: string): Promise<HostCall | undefined> {
  if (process.env.BASELINE_SHARED_BROWSER === "0") return undefined;
  const key = hostKey(runDir, runner);
  const alive = async () => {
    const info = readInfo(key);
    if (!info || resolve(info.runDir) !== resolve(runDir)) return undefined;
    try { const r = await request(info, { id: 0, method: "ping" }, 2_000); return r.ok ? info : undefined; } catch { return undefined; }
  };
  let info = await alive();
  if (!info) {
    rmSync(infoPath(key), { force: true });
    if (!existsSync(cliPath)) return undefined;
    const child = spawn(process.execPath, [cliPath, "browser-host", runner, "--run", runDir], { cwd: projectDir, detached: true, stdio: "ignore" });
    child.unref();
    const until = Date.now() + START_MS;
    while (!info && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 250));
      info = await alive();
    }
  }
  if (!info) return undefined;
  const live = info;
  return (m) => request(live, m);
}

register("browser-host", "(internal) keep one browser open for a runner during a run: browser-host <runner> --run <dir>", async (args) => {
  const runner = args[0];
  const runIdx = args.indexOf("--run");
  const runDir = runIdx >= 0 ? resolve(args[runIdx + 1] ?? "") : "";
  const projectDir = process.cwd();
  const cfg = loadConfig(projectDir);
  const r = cfg.runners.find((x) => x.key === runner);
  if (!r || !runDir || !existsSync(join(runDir, "run.json"))) return 2;
  const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as { runId: string; url: string };
  const key = hostKey(runDir, r.key);
  const sock = socketPath(key);
  const token = randomBytes(24).toString("hex");
  const activePointer = join(projectDir, ".baseline", "active-run");

  let session: Session | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  let last = Date.now();
  let closing = false;

  const handle = (line: string, conn: Socket) => {
    let m: { id: number; method: string; args?: unknown[]; token?: string };
    try { m = JSON.parse(line); } catch { conn.destroy(); return; }
    if (m.token !== token) { conn.destroy(); return; }
    last = Date.now();
    const reply = (x: Omit<HostReply, "id">) => { if (!conn.destroyed) conn.end(JSON.stringify({ id: m.id, ...x }) + "\n"); };
    if (m.method === "ping") return reply({ ok: true });
    chain = chain.then(async () => {
      if (!isCommand(m.method)) return reply({ ok: false, error: `"${String(m.method)}" is not an allowed command` });
      try {
        if (m.method === "open") {
          session ??= await openSession({ runDir, runId: run.runId, runner: r, cfg, baseUrl: run.url, storageState: sessionPath(dataDir(), projectDir, r.key) });
          return reply({ ok: true, value: { runner: r.key, persona: r.persona, depth: r.depth } });
        }
        if (!session) return reply({ ok: false, error: "call open() first" });
        // A script finishing is not the run finishing: keep the browser for the next script.
        if (m.method === "close") return reply({ ok: true });
        const fn = (session as unknown as Record<string, (...a: unknown[]) => unknown>)[m.method]!;
        return reply({ ok: true, value: await fn(...(m.args ?? [])) });
      } catch (e) {
        return reply({ ok: false, error: `${(e as Error).name}: ${(e as Error).message.split("\n")[0]}` });
      }
    });
  };

  const server = createServer((conn) => {
    let buf = "";
    conn.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) { handle(buf.slice(0, nl), conn); buf = ""; }
    });
    conn.on("error", () => {});
  });

  const shutdown = async () => {
    if (closing) return;
    closing = true;
    server.close();
    // Never wait forever on a command that hangs: give it and the browser ten seconds, then go.
    const tidy = (async () => {
      await chain.catch(() => {});
      if (session) await session.close().catch(() => {});
    })();
    await Promise.race([tidy, new Promise((r) => setTimeout(r, 10_000))]);
    rmSync(infoPath(key), { force: true });
    if (process.platform !== "win32") rmSync(sock, { force: true });
    process.exit(0);
  };

  if (process.platform !== "win32") rmSync(sock, { force: true });
  await new Promise<void>((res, rej) => { server.once("error", rej); server.listen(sock, () => res()); });
  if (process.platform !== "win32") chmodSync(sock, 0o600);
  mkdirSync(join(dataDir(), "hosts"), { recursive: true, mode: 0o700 });
  writeFileSync(infoPath(key), JSON.stringify({ token, socket: sock, pid: process.pid, runDir } satisfies HostInfo), { mode: 0o600 });

  // Close with the run: when it was the active run and stops being it, or another run starts.
  // A host for a finished run (`--run <dir>`, e.g. a cleanup pass) closes after a short idle.
  const pointer = () => { try { return readFileSync(activePointer, "utf8").trim(); } catch { return ""; } };
  const startedActive = !!pointer() && resolve(pointer()) === runDir;
  setInterval(() => {
    const current = pointer();
    const isActive = !!current && resolve(current) === runDir;
    const ended = startedActive ? !isActive : !!current && !isActive;
    if (ended || Date.now() - last > (startedActive ? IDLE_MS : IDLE_FINISHED_MS)) void shutdown();
  }, WATCH_MS);
  for (const s of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(s, () => void shutdown());
  await new Promise(() => {});
  return 0;
});
