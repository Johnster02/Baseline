#!/usr/bin/env node
// Pre-push leak check. The banned-terms list lives outside the repo, so publishing
// the repo never publishes the list it protects.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { leakCheck } from "./leak-check-lib.mjs";

const banned = process.env.BASELINE_BANNED_TERMS || join(homedir(), ".config", "baseline-private", "banned-terms.txt");
if (!existsSync(banned)) {
  console.log("leak check skipped: no banned-terms file");
  process.exit(0);
}
const files = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean)
  .filter((f) => !f.endsWith("pnpm-lock.yaml"));
const hits = leakCheck(files, banned);
for (const h of hits) console.error(`leak: ${h.file}:${h.line} contains a banned term`);
if (hits.length) process.exit(1);
console.log(`leak check passed (${files.length} files)`);
