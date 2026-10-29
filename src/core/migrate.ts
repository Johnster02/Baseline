// One-time move of state from the legacy data folder (~/.config/baseline) into the folder Claude
// Code gives the plugin. Before this existed, hooks resolved one folder and plain Bash calls
// resolved the other, so a login saved by one command was invisible to the next (spec 3.1).
//
// Copy, not move: the legacy folder keeps its copy, and stays a protected candidate in
// dataDirCandidates(), so nothing is lost and the guards keep covering both places.
// Kept free of heavy imports: the hook bundle uses it.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** What a Baseline data folder holds. Nothing else is touched. */
const PARTS = ["secrets", "sessions", "hosts", "runs"] as const;

/** Written into the legacy folder once it has been copied across, so this only ever runs once. */
const BREADCRUMB = "migrated-to";

export type MigrationResult = {
  /** Top-level folders that had at least one file copied out of them. */
  moved: string[];
  /** Files already present at the target, left exactly as they were (paths relative to the folder). */
  skipped: string[];
};

/** Copy one tree, preserving modes, never overwriting. Returns the files it did not take. */
function copyTree(from: string, to: string, rel: string, skipped: string[]): number {
  let copied = 0;
  mkdirSync(to, { recursive: true, mode: statSync(from).mode & 0o777 });
  chmodSync(to, statSync(from).mode & 0o777);
  for (const name of readdirSync(from)) {
    const src = join(from, name), dst = join(to, name), r = join(rel, name);
    const st = statSync(src);
    if (st.isDirectory()) { copied += copyTree(src, dst, r, skipped); continue; }
    if (!st.isFile()) continue;
    // A newer file at the target always wins: this runs on every session start, and a password
    // saved since the migration must never be rolled back to the legacy copy.
    if (existsSync(dst)) { skipped.push(r); continue; }
    copyFileSync(src, dst);
    chmodSync(dst, st.mode & 0o777);
    copied++;
  }
  return copied;
}

/**
 * Copy the legacy folder's state into `target`, once. A no-op when there is nothing to move, when
 * it has already run, or when the two are the same folder.
 */
export function migrateLegacyData(opts: { legacy: string; target: string }): MigrationResult {
  const legacy = resolve(opts.legacy), target = resolve(opts.target);
  const empty: MigrationResult = { moved: [], skipped: [] };
  if (legacy === target) return empty;
  if (!existsSync(legacy) || existsSync(join(legacy, BREADCRUMB))) return empty;
  const moved: string[] = [], skipped: string[] = [];
  for (const part of PARTS) {
    const from = join(legacy, part);
    if (!existsSync(from) || !statSync(from).isDirectory()) continue;
    if (copyTree(from, join(target, part), part, skipped) > 0) moved.push(part);
  }
  writeFileSync(join(legacy, BREADCRUMB), target + "\n", { mode: 0o600 });
  return { moved, skipped };
}
