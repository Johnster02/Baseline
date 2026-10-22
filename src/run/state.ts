import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pad = (n: number) => String(n).padStart(2, "0");

export function newRun(projectDir: string, sessionId: string | undefined, meta: { url: string; label: string; permissions?: { runner: string; can: string[]; cannot: string[] }[]; live?: boolean }) {
  const d = new Date();
  const base = `r-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const root = join(projectDir, ".baseline");
  let runId = base;
  const sessionKey = sessionId && /^[A-Za-z0-9_-]+$/.test(sessionId) ? sessionId : undefined;
  let sessionDir = join(root, "sessions", sessionKey ?? runId);
  for (let i = 2; existsSync(join(sessionDir, "runs", runId)) || (!sessionKey && existsSync(sessionDir)); i++) {
    runId = `${base}-${i}`;
    if (!sessionKey) sessionDir = join(root, "sessions", runId);
  }
  const runDir = join(sessionDir, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId, url: meta.url, label: meta.label, startedAt: d.toISOString(), permissions: meta.permissions ?? [], live: meta.live === true }, null, 2));
  writeFileSync(join(root, "active-run"), runDir);
  return { runId, runDir, sessionDir };
}

export function finishRun(projectDir: string): void {
  rmSync(join(projectDir, ".baseline", "active-run"), { force: true });
}
