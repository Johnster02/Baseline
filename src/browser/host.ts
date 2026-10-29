// One browser per runner for the whole run. The first `baseline script` for a runner starts this
// host in the background; later scripts reuse its browser, so the page is where the last script
// left it and nobody pays for a fresh launch, session restore and page load every time.
//
// The guard still lives with the browser (openSession), here in the host. Agent scripts never talk
// to the host: `baseline script` relays their allowed commands over a local socket that needs a
// token kept in Baseline's data folder, which the script sandbox cannot read.
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { register } from "../cli";
import { loadConfig } from "../config/store";
import { sessionPath } from "../config/secrets";
import { dataDir, realPath, trustedFiles } from "../core/paths";
import { readJsonFile } from "../core/json";
import { checkRunDir } from "../core/trusted-run";
import { parseFlags } from "../core/args";
import { openSession } from "./session";
import { parseReply, parseRequest } from "./rpc";
import type { RpcReply, RpcRequest } from "./rpc";
import { createDispatcher } from "./dispatch";

const IDLE_MS = 10 * 60_000;
const IDLE_FINISHED_MS = 2 * 60_000;
const WATCH_MS = 3_000;
const START_MS = 30_000;
const START_POLL_MS = 75;
/** No command waits on the host longer than this (BASELINE_HOST_TIMEOUT_MS overrides). */
const requestTimeoutMs = () => Number(process.env.BASELINE_HOST_TIMEOUT_MS) || 120_000;

export type HostReply = RpcReply;
export type HostConnection = {
  call(m: { id: number; method: string; args?: unknown[] }): Promise<HostReply>;
  /** Drop the socket. The host and its browser stay up for the next script. */
  close(): void;
};
type HostInfo = { token: string; socket: string; pid: number; runDir: string };
const parseInfo = (v: unknown): HostInfo => {
  const o = v as Partial<HostInfo>;
  if (typeof o?.token !== "string" || typeof o.socket !== "string" || typeof o.runDir !== "string" || !Number.isInteger(o.pid) || (o.pid as number) <= 0) throw new Error("bad host info");
  return o as HostInfo;
};

/** Short and per run+runner: socket paths are capped at ~104 characters on macOS. */
export function hostKey(runDir: string, runner: string): string {
  return createHash("sha256").update(realPath(runDir) + "\0" + runner).digest("hex").slice(0, 16);
}
const hostsDir = () => join(dataDir(), "hosts");
const infoPath = (key: string) => join(hostsDir(), `${key}.json`);
const socketPath = (key: string) => (process.platform === "win32" ? `\\\\.\\pipe\\baseline-${key}` : join(tmpdir(), `baseline-${key}.sock`));
const readInfo = (file: string) => readJsonFile<HostInfo | undefined>(file, parseInfo, undefined);

/** The command line of a process, or undefined when it can't be read on this system. */
function commandLine(pid: number): string | undefined {
  if (process.platform === "linux") {
    // /proc first: busybox `ps` (Alpine) has no -p.
    try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " "); } catch { /* fall through */ }
  }
  if (process.platform === "win32") return undefined;
  try { return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return undefined; }
}

/**
 * True only if `pid` is alive and is a Baseline browser host, so a recycled PID is never signalled.
 * Where the command line can't be read (Windows), nothing counts: such hosts close on the run's
 * finished marker or after an idle spell instead.
 */
export function isHostProcess(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  const cmd = commandLine(pid);
  return !!cmd && /\bbrowser-host\b/.test(cmd);
}

/** Close every runner's browser for a run (or all of them), now. Used by `run finish`. */
export function stopHosts(runDir?: string): number {
  let files: string[] = [];
  try { files = readdirSync(hostsDir()).filter((f) => /^[0-9a-f]{16}\.json$/.test(f)); } catch { return 0; }
  let stopped = 0;
  for (const f of files) {
    const file = join(hostsDir(), f);
    const info = readInfo(file);
    if (!info) { rmSync(file, { force: true }); continue; }
    if (runDir && realPath(info.runDir) !== realPath(runDir)) continue;
    if (process.platform === "win32") continue; // can't verify the PID here: the host closes on the finished marker
    if (!isHostProcess(info.pid)) {
      // Died without tidying up (crash, SIGKILL): forget it, and never signal whoever has the PID now.
      rmSync(file, { force: true });
      rmSync(info.socket, { force: true });
      continue;
    }
    try { process.kill(info.pid, "SIGTERM"); stopped++; } catch { rmSync(file, { force: true }); }
  }
  return stopped;
}

/** One request on a fresh connection. Used for the liveness ping. */
function requestOnce(info: HostInfo, msg: { id: number; method: string }, timeoutMs: number): Promise<HostReply> {
  return new Promise((res, rej) => {
    const sock = createConnection(info.socket);
    let buf = "";
    const timer = setTimeout(() => { sock.destroy(); rej(new Error("host timed out")); }, timeoutMs);
    sock.on("connect", () => sock.write(JSON.stringify({ ...msg, token: info.token }) + "\n"));
    sock.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      sock.end();
      let r: HostReply | undefined;
      try { r = parseReply(JSON.parse(buf.slice(0, nl))); } catch { r = undefined; }
      if (r) res(r); else rej(new Error("bad reply from host"));
    });
    sock.on("error", (e) => { clearTimeout(timer); rej(e); });
  });
}

/** One socket for a whole `baseline script`, with replies matched to requests by id. */
function persistent(info: HostInfo): HostConnection {
  const pending = new Map<number, { res: (r: HostReply) => void; rej: (e: Error) => void; timer: NodeJS.Timeout }>();
  let sock: Socket | undefined;
  // Each socket's events only touch state while it is still the current one: a socket that was
  // closed (close() then call()) must not fail the calls of the one that replaced it.
  const failAll = (from: Socket, e: Error) => {
    if (sock !== from) return;
    for (const [, p] of pending) { clearTimeout(p.timer); p.rej(e); }
    pending.clear();
    sock = undefined;
  };
  const open = () => {
    const s = createConnection(info.socket);
    let sbuf = "";
    s.on("data", (d) => {
      if (sock !== s) return;
      sbuf += d.toString();
      let nl: number;
      while ((nl = sbuf.indexOf("\n")) >= 0) {
        const line = sbuf.slice(0, nl);
        sbuf = sbuf.slice(nl + 1);
        let r: HostReply | undefined;
        try { r = parseReply(JSON.parse(line)); } catch { r = undefined; }
        const p = r && pending.get(r.id);
        if (!r || !p) continue;
        pending.delete(r.id);
        clearTimeout(p.timer);
        p.res(r);
      }
    });
    s.on("error", (e) => failAll(s, e));
    s.on("close", () => failAll(s, new Error("host connection closed")));
    return s;
  };
  return {
    call(m) {
      sock ??= open();
      const s = sock;
      return new Promise((res, rej) => {
        const timer = setTimeout(() => { pending.delete(m.id); rej(new Error("host timed out")); }, requestTimeoutMs());
        pending.set(m.id, { res, rej, timer });
        s.write(JSON.stringify({ ...m, token: info.token }) + "\n");
      });
    },
    close() { sock?.end(); sock = undefined; },
  };
}

/**
 * A live host for this run and runner: reuses one that answers, otherwise starts one and waits
 * for it. Undefined when it can't start, so the caller falls back to a browser of its own.
 */
export async function connectHost(projectDir: string, runDir: string, runner: string, cliPath: string): Promise<HostConnection | undefined> {
  if (process.env.BASELINE_SHARED_BROWSER === "0") return undefined;
  const key = hostKey(runDir, runner);
  const alive = async () => {
    const info = readInfo(infoPath(key));
    if (!info || realPath(info.runDir) !== realPath(runDir)) return undefined;
    try { const r = await requestOnce(info, { id: 0, method: "ping" }, 2_000); return r.ok ? info : undefined; } catch { return undefined; }
  };
  let info = await alive();
  if (!info) {
    rmSync(infoPath(key), { force: true });
    if (!existsSync(cliPath)) return undefined;
    const child = spawn(process.execPath, [cliPath, "browser-host", runner, "--run", runDir], { cwd: projectDir, detached: true, stdio: "ignore" });
    child.unref();
    const until = Date.now() + START_MS;
    while (!info && Date.now() < until) {
      await new Promise((r) => setTimeout(r, START_POLL_MS));
      // The host writes its info file only once it is listening: no file, no point pinging.
      if (existsSync(infoPath(key))) info = await alive();
    }
  }
  return info ? persistent(info) : undefined;
}

/** A BLOCKED explorer is waiting on the user: its browser must still be there when they answer. */
function runIsBlocked(runDir: string): boolean {
  const explore = join(runDir, "explore");
  try { return readdirSync(explore).some((r) => existsSync(join(explore, r, "blocker.json"))); } catch { return false; }
}

register("browser-host", "(internal) keep one browser open for a runner during a run: browser-host <runner> --run <dir>", async (args) => {
  const { values, positionals } = parseFlags(args, {});
  const runner = positionals[0];
  const projectDir = process.cwd();
  if (!values.run) return 2;
  const checked = checkRunDir(projectDir, resolve(values.run));
  if (!checked.ok) { process.stderr.write(checked.reason + "\n"); return 2; }
  const run = checked.run;
  const runDir = run.runDir;
  const cfg = loadConfig(projectDir);
  const r = cfg.runners.find((x) => x.key === runner);
  if (!r) return 2;
  const key = hostKey(runDir, r.key);
  const sock = socketPath(key);
  const token = randomBytes(24).toString("hex");
  const finishedMarker = trustedFiles.finished(runDir);

  let last = Date.now();
  let closing = false;
  const dispatcher = createDispatcher({
    runDir,
    openSession: () => openSession({ runDir, runId: run.runId, runner: r, cfg, baseUrl: run.url, storageState: sessionPath(dataDir(), projectDir, r.key) }),
    info: { runner: r.key, persona: r.persona, depth: r.depth },
    keepOnClose: true,
  });

  const handle = (line: string, conn: Socket) => {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { conn.destroy(); return; }
    if ((raw as { token?: unknown } | null)?.token !== token) { conn.destroy(); return; }
    const m: RpcRequest | undefined = parseRequest(raw);
    if (!m) { conn.destroy(); return; }
    last = Date.now();
    const send = (x: HostReply) => { if (!conn.destroyed) conn.write(JSON.stringify(x) + "\n"); };
    if (m.method === "ping") return send({ id: m.id, ok: true });
    void dispatcher.handle(m).then(send);
  };

  const server = createServer((conn) => {
    let buf = "";
    conn.on("data", (d) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        handle(line, conn);
      }
    });
    conn.on("error", () => { /* the script went away; its queued commands still finish */ });
  });

  const shutdown = async () => {
    if (closing) return;
    closing = true;
    server.close();
    // Never wait forever on a command that hangs: give it and the browser ten seconds, then go.
    await Promise.race([dispatcher.close(), new Promise((r) => setTimeout(r, 10_000))]);
    rmSync(infoPath(key), { force: true });
    if (process.platform !== "win32") rmSync(sock, { force: true });
    process.exit(0);
  };

  if (process.platform !== "win32") rmSync(sock, { force: true });
  await new Promise<void>((res, rej) => { server.once("error", rej); server.listen(sock, () => res()); });
  if (process.platform !== "win32") chmodSync(sock, 0o600);
  mkdirSync(hostsDir(), { recursive: true, mode: 0o700 });
  writeFileSync(infoPath(key), JSON.stringify({ token, socket: sock, pid: process.pid, runDir } satisfies HostInfo), { mode: 0o600 });

  // Close with this run: when `run finish` marks it finished, or after an idle spell. Another run
  // starting doesn't close it (two sessions may run side by side). A host for an already finished
  // run (a late cleanup pass) closes after a short idle.
  const finishedAtStart = existsSync(finishedMarker);
  setInterval(() => {
    if (!finishedAtStart && existsSync(finishedMarker)) return void shutdown();
    if (runIsBlocked(runDir)) last = Date.now();
    const idle = finishedAtStart ? IDLE_FINISHED_MS : Number(process.env.BASELINE_HOST_IDLE_MS) || IDLE_MS;
    if (Date.now() - last > idle) void shutdown();
  }, Number(process.env.BASELINE_HOST_WATCH_MS) || WATCH_MS);
  for (const s of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(s, () => void shutdown());
  await new Promise(() => {});
  return 0;
});
