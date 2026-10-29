// `baseline doctor`: where Baseline is keeping state right now, and what is in each place.
// Written because the two-folder split (spec 3.1) cost a user several sign-in attempts to
// diagnose: with this, the answer to "which folder has my login?" is one command.
//
// It reports whether a file is there, never what is in it: these folders hold passwords,
// saved sessions and tracker tokens.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { register, out } from "../cli";
import { dataDir, dataDirCandidates } from "./paths";
import { projectHash } from "../config/secrets";
import { activeRun } from "../hooks/active-run";

export type DoctorCandidate = {
  dir: string;
  exists: boolean;
  /** This project's saved sign-in details live in this folder. */
  secretsHere: boolean;
  /** Runner keys with a saved session in this folder, for this project. */
  sessionsHere: string[];
  /** Trusted run records in this folder, for any project. */
  runs: number;
};

export type DoctorReport = {
  /** The folder every Baseline command in this process would use. */
  resolved: string;
  /** What the SessionStart hook recorded, when it is readable. */
  pointer?: string;
  /** The pre-migration location, which stays protected either way. */
  legacy: string;
  /** Where the legacy folder's state was copied, if it has been. */
  migratedTo?: string;
  candidates: DoctorCandidate[];
  activeRun?: string;
};

const names = (dir: string): string[] => { try { return readdirSync(dir); } catch { return []; } };
const count = (dir: string): number => names(dir).length;

function describeCandidate(dir: string, hash: string): DoctorCandidate {
  const exists = existsSync(dir);
  return {
    dir,
    exists,
    secretsHere: existsSync(join(dir, "secrets", `${hash}.json`)),
    sessionsHere: names(join(dir, "sessions", hash)).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort(),
    runs: count(join(dir, "runs")),
  };
}

export function doctorReport(projectDir: string): DoctorReport {
  const home = process.env.HOME || homedir();
  const hash = projectHash(projectDir);
  const legacy = join(home, ".config", "baseline");
  let pointer: string | undefined;
  try { pointer = readFileSync(join(legacy, "plugin-data"), "utf8").trim() || undefined; } catch { pointer = undefined; }
  let migratedTo: string | undefined;
  try { migratedTo = readFileSync(join(legacy, "migrated-to"), "utf8").trim() || undefined; } catch { migratedTo = undefined; }
  let resolved: string;
  try { resolved = dataDir(projectDir); } catch (e) { resolved = `unavailable: ${e instanceof Error ? e.message : String(e)}`; }
  const candidates = [...new Set([...dataDirCandidates(), legacy])].map((d) => describeCandidate(d, hash));
  const run = activeRun(projectDir);
  return {
    resolved,
    ...(pointer ? { pointer } : {}),
    legacy,
    ...(migratedTo ? { migratedTo } : {}),
    candidates,
    ...(run ? { activeRun: run.runDir } : {}),
  };
}

const age = (dir: string): string => { try { return new Date(statSync(dir).mtime).toISOString().slice(0, 16).replace("T", " "); } catch { return "—"; } };

register("doctor", "where Baseline keeps its state, and what is in each place", () => {
  const r = doctorReport(process.cwd());
  const lines = [`data folder in use: ${r.resolved}`];
  if (r.pointer) lines.push(`pointer (written by the SessionStart hook): ${r.pointer}`);
  if (r.migratedTo) lines.push(`legacy folder already copied to: ${r.migratedTo}`);
  lines.push("", "folders Baseline keeps out of every tool:");
  for (const c of r.candidates) {
    const mark = c.dir === r.resolved ? " <- in use" : "";
    if (!c.exists) { lines.push(`  ${c.dir}  (not there)${mark}`); continue; }
    const bits = [
      c.secretsHere ? "this project's sign-in details: yes" : "this project's sign-in details: no",
      `saved sessions here: ${c.sessionsHere.length ? c.sessionsHere.join(", ") : "none"}`,
      `run records: ${c.runs}`,
      `last changed ${age(c.dir)}`,
    ];
    lines.push(`  ${c.dir}${mark}`, `      ${bits.join(" · ")}`);
  }
  lines.push("", r.activeRun ? `a run is active: ${r.activeRun}` : "no run is active in this project");
  out(lines.join("\n"));
  return 0;
});
