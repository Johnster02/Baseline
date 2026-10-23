import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

/**
 * A runner's sign-in details. `origin` is the site they were saved for: Baseline types them on that
 * site only. Details saved before origins were recorded have none and must be saved again.
 */
export type Credentials = { username: string; password: string; origin?: string | undefined };

/** The origin (scheme://host:port) of a URL, or undefined. */
export function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.origin : undefined; } catch { return undefined; }
}

// Data-folder location lives in core/paths; re-exported for existing callers.
export { dataDir, recordPluginData } from "../core/paths";

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
