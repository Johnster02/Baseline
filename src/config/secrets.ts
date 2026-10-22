import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type Credentials = { username: string; password: string };

/** Durable per-user data dir. Skills pass ${CLAUDE_PLUGIN_DATA} as BASELINE_DATA. */
export function dataDir(): string {
  return process.env.BASELINE_DATA || process.env.CLAUDE_PLUGIN_DATA || join(homedir(), ".config", "baseline");
}

export function projectHash(projectDir: string): string {
  return createHash("sha256").update(resolve(projectDir)).digest("hex").slice(0, 16);
}

export function secretsPath(data: string, projectDir: string): string {
  return join(data, "secrets", `${projectHash(projectDir)}.json`);
}

function readAll(data: string, projectDir: string): Record<string, Credentials> {
  const p = secretsPath(data, projectDir);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
}

export function setSecret(data: string, projectDir: string, runnerKey: string, creds: Credentials): void {
  const all = readAll(data, projectDir);
  all[runnerKey] = creds;
  const p = secretsPath(data, projectDir);
  mkdirSync(join(data, "secrets"), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(all), { mode: 0o600 });
  chmodSync(p, 0o600);
}

export function getSecret(data: string, projectDir: string, runnerKey: string): Credentials | undefined {
  return readAll(data, projectDir)[runnerKey];
}

export function sessionPath(data: string, projectDir: string, runnerKey: string): string {
  return join(data, "sessions", projectHash(projectDir), `${runnerKey}.json`);
}
