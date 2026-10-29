import { activeRunDir as coreActiveRunDir, dataDir, isInside, trustedFiles } from "../core/paths";
import { fork } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { register, err, io } from "../cli";
import { loadConfig } from "../config/store";
import { sessionPath } from "../config/secrets";
import { checkRunDir } from "../core/trusted-run";
import { parseFlags } from "../core/args";
import { recordRunnerStatus } from "../run/runners";
import { openSession } from "./session";
import { parseRequest } from "./rpc";
import { connectHost } from "./host";
import type { HostReply } from "./host";
import { createDispatcher } from "./dispatch";

/** The plugin root: dist/cli.cjs lives in <root>/dist. */
function pluginRoot(): string {
  return typeof __dirname !== "undefined" ? resolve(__dirname, "..") : process.cwd();
}

export function activeRunDir(projectDir: string, flag?: string): string | undefined {
  return coreActiveRunDir(projectDir, flag, io.origCwd);
}

/**
 * Preloaded into every script. Node's permission model (on this Node) doesn't cover the network,
 * so scripts lose their sockets here: they reach the site only through the guarded commands.
 * The IPC channel to `baseline script` is set up by Node itself and is not affected.
 */
function preloadSource(client: string): string {
  return `"use strict";
const M = require("module"); const t = ${JSON.stringify(client)};
const r = M._resolveFilename; M._resolveFilename = function (req, ...a) { return req === "baseline" ? t : r.call(this, req, ...a); };
const deny = function () { throw new Error("Baseline: scripts can't open network connections. Drive the page with the baseline commands."); };
const patch = (o, k) => { try { Object.defineProperty(o, k, { value: deny, writable: false, configurable: false }); } catch (e) {} };
const net = require("net"); for (const k of ["connect", "createConnection", "createServer"]) patch(net, k); patch(net.Socket.prototype, "connect");
for (const m of ["http", "https"]) { const x = require(m); for (const k of ["request", "get", "createServer"]) patch(x, k); }
const tls = require("tls"); for (const k of ["connect", "createServer"]) patch(tls, k);
try { const h2 = require("http2"); for (const k of ["connect", "createServer", "createSecureServer"]) patch(h2, k); } catch (e) {}
patch(require("dgram"), "createSocket");
for (const k of ["fetch", "WebSocket", "EventSource"]) if (k in globalThis) patch(globalThis, k);
patch(process, "binding"); patch(process, "_linkedBinding");
`;
}

/** A tiny node_modules/baseline pointing at the IPC client, so scripts can require("baseline"). */
function shimDir(root: string): string {
  const dir = join(dataDir(), "shim", "node_modules", "baseline");
  const client = join(root, "dist", "client.cjs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.js"), `module.exports = require(${JSON.stringify(client)});\n`);
  // Preloaded into each script: require("baseline") resolves straight to the client, without
  // walking parent folders (which the sandbox does not let it read).
  writeFileSync(join(dataDir(), "shim", "preload.cjs"), preloadSource(client));
  return dirname(dir);
}

export function parseScriptArgs(args: string[]): { runnerKey?: string | undefined; file?: string | undefined; runFlag?: string | undefined } {
  const { values, positionals } = parseFlags(args, {});
  return { runnerKey: positionals[0], file: positionals[1], runFlag: values.run };
}

/** Use the shared browser while the run is going; a finished run (a late cleanup) gets its own. */
const wantsSharedBrowser = (runDir: string) => !existsSync(trustedFiles.finished(runDir));

register("script", "run an agent's browser script as a runner: script <runner> <file.cjs> [--run <dir>]", async (args) => {
  const { runnerKey, file, runFlag } = parseScriptArgs(args);
  const projectDir = process.cwd();
  const cfg = loadConfig(projectDir);
  const runner = cfg.runners.find((r) => r.key === runnerKey);
  if (!runner || !file) {
    err(`usage: baseline script <runner> <file.cjs> [--run <dir>]. Runners: ${cfg.runners.map((r) => r.key).join(", ") || "none"}`);
    return 2;
  }
  const wanted = activeRunDir(projectDir, runFlag);
  if (!wanted) { err("no active run. Start one with /baseline:run."); return 2; }
  // Only a run Baseline started: the folder becomes the script's sandbox, so an agent can't
  // point it at a folder of its choosing (its home, Baseline's data folder).
  const checked = checkRunDir(projectDir, wanted);
  if (!checked.ok) { err(checked.reason); return 2; }
  const run = checked.run;
  const runDir = run.runDir;

  const scriptPath = resolve(io.origCwd, file);
  const shim = shimDir(pluginRoot());
  // Node's permission model: the script may read its run folder, the shim and Baseline's client,
  // write only into its run folder, and start no other programs. Saved sessions and credentials
  // in the data folder are out of reach.
  const major = Number(process.versions.node.split(".")[0]);
  const permFlag = major >= 22 ? "--permission" : "--experimental-permission";
  const real = (p: string) => { try { return realpathSync.native(p); } catch { return p; } };
  // macOS and Windows paths ignore case, so compare without it there.
  const fold = (p: string) => (process.platform === "darwin" || process.platform === "win32" ? p.toLowerCase() : p);
  const data = fold(real(dataDir())), script = fold(real(scriptPath));
  if (isInside(script, data) || isInside(data, script)) { err("refusing: scripts may not live in Baseline's data folder"); return 2; }
  // Node 20's permission model is experimental and warns on every script; agents would read that
  // as script output. Silence just that warning where Node supports it (20.11+).
  const quiet = major < 22 && process.allowedNodeEnvironmentFlags.has("--disable-warning") ? ["--disable-warning=ExperimentalWarning"] : [];
  const execArgv = [...quiet, permFlag, `--require=${real(join(dataDir(), "shim", "preload.cjs"))}`, `--allow-fs-read=${real(join(dataDir(), "shim"))}`, `--allow-fs-read=${real(runDir)}`, `--allow-fs-read=${real(scriptPath)}`, `--allow-fs-read=${real(shim)}`,
    `--allow-fs-read=${real(join(pluginRoot(), "dist"))}`, `--allow-fs-write=${real(runDir)}`];
  // The runner's browser for the whole run, kept open by a background host. A script against a
  // finished run (a late cleanup) gets a browser of its own that closes when the script ends, so
  // nothing is left running. Without a host (it could not start, or BASELINE_SHARED_BROWSER=0)
  // the script also gets its own.
  const host = wantsSharedBrowser(runDir) ? await connectHost(projectDir, runDir, runner.key, join(pluginRoot(), "dist", "cli.cjs")) : undefined;

  // The report shows which runner was signed out mid-run.
  const noteSignedOut = (message: string) => recordRunnerStatus(runDir, [{ key: runner.key, ok: false, error: message }]);
  const own = createDispatcher({
    runDir,
    openSession: () => openSession({ runDir, runId: run.runId, runner, cfg, baseUrl: run.url, storageState: sessionPath(dataDir(), projectDir, runner.key) }),
    info: { runner: runner.key, persona: runner.persona, depth: runner.depth },
    keepOnClose: false,
    onSignedOut: noteSignedOut,
  });

  const child = fork(real(scriptPath), [], {
    cwd: runDir,
    execArgv,
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    // The script gets only the shim on its module path, and none of Baseline's own settings.
    env: { PATH: process.env.PATH ?? "", HOME: runDir, NODE_PATH: shim },
  });

  let relay: Promise<unknown> = Promise.resolve();
  child.on("message", (raw: unknown) => {
    const m = parseRequest(raw);
    if (!m) return;
    const send = (r: HostReply) => { if (child.connected) child.send(r); };
    if (!host) { void own.handle(m).then(send); return; }
    const p = host.call({ id: m.id, method: String(m.method), args: m.args })
      .catch((e: unknown): HostReply => ({ id: m.id, ok: false, error: `HostError: ${e instanceof Error ? e.message : String(e)}` }))
      .then((r) => {
        if (!r.ok && r.error?.startsWith("SignedOutError:")) noteSignedOut(r.error.slice("SignedOutError: ".length));
        send(r);
      });
    relay = relay.then(() => p);
  });

  const code = await new Promise<number>((res) => child.on("exit", (c) => res(c ?? 1)));
  await relay.catch(() => {});
  host?.close();
  await own.close();
  return code;
});
