import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type Credentials = { username: string; password: string };

const pointerFile = (home: string) => join(home, ".config", "baseline", "plugin-data");

/** Hooks see CLAUDE_PLUGIN_DATA but plain Bash calls don't: the SessionStart hook leaves a pointer. */
export function recordPluginData(dir: string, home = homedir()): void {
  mkdirSync(join(home, ".config", "baseline"), { recursive: true, mode: 0o700 });
  writeFileSync(pointerFile(home), dir + "\n", { mode: 0o600 });
}

/** Durable per-user data dir: env first, then the pointer the plugin's hook wrote, then a default. */
export function dataDir(): string {
  if (process.env.BASELINE_DATA) return process.env.BASELINE_DATA;
  if (process.env.CLAUDE_PLUGIN_DATA) return process.env.CLAUDE_PLUGIN_DATA;
  const home = process.env.HOME || homedir();
  try { const p = readFileSync(pointerFile(home), "utf8").trim(); if (p) return p; } catch { /* none */ }
  return join(home, ".config", "baseline");
}

export function projectHash(projectDir: string): string {
  let p = resolve(projectDir);
  try { p = realpathSync(p); } catch { /* not created yet */ }
  return createHash("sha256").update(p).digest("hex").slice(0, 16);
}

export function secretsPath(data: string, projectDir: string): string {
  return join(data, "secrets", `${projectHash(projectDir)}.json`);
}

function readAll(data: string, projectDir: string): Record<string, Credentials> {
  const p = secretsPath(data, projectDir);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    // Never let a parse error echo the file: it holds passwords.
    throw new Error(`secrets file is unreadable (${p}). Re-run setup to save sign-in details again.`);
  }
}

function writeAll(data: string, projectDir: string, all: Record<string, Credentials>): void {
  const dir = join(data, "secrets");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const p = secretsPath(data, projectDir);
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  // Exclusive create at 0600, then rename: no window with looser permissions, no half-written file.
  const fd = openSync(tmp, "wx", 0o600);
  try { writeSync(fd, JSON.stringify(all)); } finally { closeSync(fd); }
  renameSync(tmp, p);
}

export function setSecret(data: string, projectDir: string, runnerKey: string, creds: Credentials): void {
  const all = readAll(data, projectDir);
  all[runnerKey] = creds;
  writeAll(data, projectDir, all);
}

export function removeSecret(data: string, projectDir: string, runnerKey: string): void {
  const all = readAll(data, projectDir);
  if (runnerKey in all) {
    delete all[runnerKey];
    writeAll(data, projectDir, all);
  }
  rmSync(sessionPath(data, projectDir, runnerKey), { force: true });
}

export function getSecret(data: string, projectDir: string, runnerKey: string): Credentials | undefined {
  return readAll(data, projectDir)[runnerKey];
}

export function sessionPath(data: string, projectDir: string, runnerKey: string): string {
  return join(data, "sessions", projectHash(projectDir), `${runnerKey}.json`);
}
