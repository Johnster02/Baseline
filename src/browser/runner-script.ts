import { fork } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { register, err, io } from "../cli";
import { loadConfig } from "../config/store";
import { dataDir, sessionPath } from "../config/secrets";
import { openSession } from "./session";
import type { Session } from "./session";
import { isCommand } from "./rpc";

/** The plugin root: dist/cli.cjs lives in <root>/dist. */
function pluginRoot(): string {
  return typeof __dirname !== "undefined" ? resolve(__dirname, "..") : process.cwd();
}

export function activeRunDir(projectDir: string, flag?: string): string | undefined {
  if (flag) return resolve(io.origCwd, flag);
  if (process.env.BASELINE_RUN_DIR) return process.env.BASELINE_RUN_DIR;
  const p = join(projectDir, ".baseline", "active-run");
  return existsSync(p) ? readFileSync(p, "utf8").trim() : undefined;
}

/** A tiny node_modules/baseline pointing at the IPC client, so scripts can require("baseline"). */
function shimDir(root: string): string {
  const dir = join(dataDir(), "shim", "node_modules", "baseline");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.js"), `module.exports = require(${JSON.stringify(join(root, "dist", "client.cjs"))});\n`);
  // Preloaded into each script: require("baseline") resolves straight to the client, without
  // walking parent folders (which the sandbox does not let it read).
  writeFileSync(join(dataDir(), "shim", "preload.cjs"), `const M = require("module"); const t = ${JSON.stringify(join(root, "dist", "client.cjs"))};
const r = M._resolveFilename; M._resolveFilename = function (req, ...a) { return req === "baseline" ? t : r.call(this, req, ...a); };\n`);
  return dirname(dir);
}

export function parseScriptArgs(args: string[]): { runnerKey?: string; file?: string; runFlag?: string } {
  const runIdx = args.indexOf("--run");
  const runFlag = runIdx >= 0 ? args[runIdx + 1] : undefined;
  const rest = args.filter((_, i) => !(runIdx >= 0 && (i === runIdx || i === runIdx + 1)));
  return { runnerKey: rest[0], file: rest[1], runFlag };
}

register("script", "run an agent's browser script as a runner: script <runner> <file.cjs> [--run <dir>]", async (args) => {
  const { runnerKey, file, runFlag } = parseScriptArgs(args);
  const projectDir = process.cwd();
  const cfg = loadConfig(projectDir);
  const runner = cfg.runners.find((r) => r.key === runnerKey);
  if (!runner || !file) {
    err(`usage: baseline script <runner> <file.cjs> [--run <dir>]. Runners: ${cfg.runners.map((r) => r.key).join(", ") || "none"}`);
    return 2;
  }
  const runDir = activeRunDir(projectDir, runFlag);
  if (!runDir || !existsSync(join(runDir, "run.json"))) { err("no active run. Start one with /baseline:run."); return 2; }
  const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as { runId: string; url: string };

  let session: Session | undefined;
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
  if (data.startsWith(script) || script.startsWith(data + sep)) { err("refusing: scripts may not live in Baseline's data folder"); return 2; }
  const execArgv = [permFlag, `--require=${real(join(dataDir(), "shim", "preload.cjs"))}`, `--allow-fs-read=${real(join(dataDir(), "shim"))}`, `--allow-fs-read=${real(runDir)}`, `--allow-fs-read=${real(scriptPath)}`, `--allow-fs-read=${real(shim)}`,
    `--allow-fs-read=${real(join(pluginRoot(), "dist"))}`, `--allow-fs-write=${real(runDir)}`];
  const child = fork(real(scriptPath), [], {
    cwd: runDir,
    execArgv,
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    // The script gets only the shim on its module path, and none of Baseline's own settings.
    env: { PATH: process.env.PATH ?? "", HOME: runDir, NODE_PATH: shim },
  });

  let chain: Promise<unknown> = Promise.resolve();
  child.on("message", (m: { id: number; method: unknown; args?: unknown[] }) => {
    chain = chain.then(async () => {
      const reply = (ok: boolean, value?: unknown, error?: string) => { if (child.connected) child.send({ id: m.id, ok, value, error }); };
      if (!isCommand(m.method)) return reply(false, undefined, `"${String(m.method)}" is not an allowed command`);
      try {
        if (m.method === "open") {
          session ??= await openSession({ runDir, runId: run.runId, runner, cfg, baseUrl: run.url, storageState: sessionPath(dataDir(), projectDir, runner.key) });
          return reply(true, { runner: runner.key, persona: runner.persona, depth: runner.depth });
        }
        if (!session) return reply(false, undefined, "call open() first");
        if (m.method === "close") { await session.close(); session = undefined; return reply(true); }
        const fn = (session as unknown as Record<string, (...a: unknown[]) => unknown>)[m.method]!;
        return reply(true, await fn(...(m.args ?? [])));
      } catch (e) {
        if ((e as Error).name === "SignedOutError") {
          // The report shows which runner was signed out mid-run.
          const file = join(runDir, "runners.json");
          let prev: { key: string }[] = [];
          try { prev = JSON.parse(readFileSync(file, "utf8")); } catch { prev = []; }
          writeFileSync(file, JSON.stringify([...prev.filter((p) => p.key !== runner.key), { key: runner.key, ok: false, error: (e as Error).message }], null, 2));
        }
        return reply(false, undefined, `${(e as Error).name}: ${(e as Error).message.split("\n")[0]}`);
      }
    });
  });

  const code = await new Promise<number>((res) => child.on("exit", (c) => res(c ?? 1)));
  await chain.catch(() => {});
  if (session) await session.close().catch(() => {});
  return code;
});
