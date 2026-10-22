import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectConfig } from "../config/schema";

export type CommitInfo = { codeRead: boolean; commitRead?: string; deployed?: string; mismatch: boolean };

/** The commit the code reader reads, and (when setup gave a version probe) the one the site is running. */
/** The probe may only call the site under test (same host as the run URL), over http(s), with a timeout. */
function probeAllowed(probeUrl: string, runUrl?: string): boolean {
  try {
    const p = new URL(probeUrl);
    if (!/^https?:$/.test(p.protocol)) return false;
    return !!runUrl && p.origin === new URL(runUrl).origin;
  } catch { return false; }
}

export async function commitInfo(projectDir: string, cfg: ProjectConfig, probe?: (url: string) => Promise<string>, runUrl?: string): Promise<CommitInfo> {
  let commitRead: string | undefined;
  try { commitRead = (await promisify(execFile)("git", ["rev-parse", "--short=7", "HEAD"], { cwd: projectDir })).stdout.trim(); } catch { commitRead = undefined; }
  if (!commitRead) return { codeRead: false, mismatch: false };
  let deployed: string | undefined;
  if (cfg.versionProbe && probeAllowed(cfg.versionProbe.url, runUrl ?? cfg.lastUrl) && cfg.versionProbe.pattern.length <= 200) {
    try {
      const body = probe ? await probe(cfg.versionProbe.url) : await (await fetch(cfg.versionProbe.url, { signal: AbortSignal.timeout(5000), redirect: "error" })).text();
      deployed = body.slice(0, 100_000).match(new RegExp(cfg.versionProbe.pattern))?.[1];
    } catch { deployed = undefined; }
  }
  const mismatch = !!deployed && !deployed.startsWith(commitRead) && !commitRead.startsWith(deployed);
  return { codeRead: true, commitRead, ...(deployed ? { deployed } : {}), mismatch };
}
