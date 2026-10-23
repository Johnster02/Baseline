#!/usr/bin/env node
// Pre-push leak check. The banned-terms list lives outside the repo, so publishing
// the repo never publishes the list it protects.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { leakCheck, leakCheckAuthors } from "./leak-check-lib.mjs";

const banned = process.env.BASELINE_BANNED_TERMS || join(homedir(), ".config", "baseline-private", "banned-terms.txt");
if (!existsSync(banned)) {
  // Other contributors have no list, so this passes; say so loudly so it is never mistaken for a pass.
  console.warn(`WARNING: leak check skipped: no banned-terms file at ${banned} (set BASELINE_BANNED_TERMS).`);
  if (process.env.GITHUB_ACTIONS) console.log("::warning::leak check skipped: no banned-terms file");
  process.exit(0);
}
const files = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean)
  .filter((f) => !f.endsWith("pnpm-lock.yaml"));
const hits = leakCheck(files, banned);
for (const h of hits) console.error(`leak: ${h.file}:${h.line} contains a banned term`);
const commits = execSync("git log --branches --format='%h %ae %ce'", { encoding: "utf8" }).split("\n").filter(Boolean);
const who = leakCheckAuthors(commits, banned);
for (const h of who) console.error(`leak: commit ${h.commit} has a banned term in its author or committer`);
if (hits.length || who.length) process.exit(1);
console.log(`leak check passed (${files.length} files)`);
