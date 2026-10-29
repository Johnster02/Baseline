import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CATEGORIES, CATEGORY_LABEL, defaultPatterns, projectConfigSchema, runnerSchema } from "./schema";
import type { Patterns, ProjectConfig, Runner } from "./schema";

export const configDir = (projectDir: string) => join(projectDir, ".baseline");
export const configPath = (projectDir: string) => join(configDir(projectDir), "config.json");

export function loadConfig(projectDir: string): ProjectConfig {
  const p = configPath(projectDir);
  let raw: unknown = {};
  if (existsSync(p)) {
    try { raw = JSON.parse(readFileSync(p, "utf8")); } catch { throw new Error(`${p} is not valid JSON. Fix it, or run setup again.`); }
  }
  const r = projectConfigSchema.safeParse(raw);
  if (!r.success) throw new Error(`${p} is not a valid Baseline config: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ")}`);
  return r.data;
}

export function saveConfig(projectDir: string, cfg: ProjectConfig): void {
  const valid = projectConfigSchema.parse(cfg);
  mkdirSync(configDir(projectDir), { recursive: true });
  ensureGitignored(projectDir);
  writeFileSync(configPath(projectDir), JSON.stringify(valid, null, 2) + "\n");
}

export function newRunner(key: string, persona: string, auth: Runner["auth"], authedCheck?: Runner["authedCheck"]): Runner {
  return runnerSchema.parse({ key, persona, auth, ...(authedCheck ? { authedCheck } : {}) });
}

export function ensureGitignored(projectDir: string): void {
  // Already ignored (a global ignore, .git/info/exclude, a parent .gitignore): leave tracked files alone.
  try {
    execFileSync("git", ["check-ignore", "-q", ".baseline/"], { cwd: projectDir, stdio: "ignore" });
    return;
  } catch { /* not ignored, or not a git repo */ }
  const p = join(projectDir, ".gitignore");
  const text = existsSync(p) ? readFileSync(p, "utf8") : "";
  if (/^\.baseline\/?$/m.test(text)) return;
  const sep = text === "" || text.endsWith("\n") ? "" : "\n";
  writeFileSync(p, text + sep + ".baseline/\n");
}

// Re-exported: the URL checks live in a zod-free module so the guard can import them cheaply.
export { checkTarget, hostKey, isProduction } from "./target";

const DEPTH_CAN: Record<Runner["depth"], string[]> = {
  look: ["browse pages and read what they show"],
  create: ["browse pages and read what they show", "create its own test objects labelled with the run ID", "edit and delete only what it created"],
  workflow: ["browse pages and read what they show", "create its own test objects labelled with the run ID", "take its own test objects through every step of a flow", "edit and delete only what it created"],
};

/**
 * What each runner may and may not do, in plain words. Setup shows this as its final
 * confirmation, so the words the user added themselves are listed in full and never truncated:
 * the defaults are long enough that a user's own additions always fell off the end of the old
 * six-item cut, which meant setup never confirmed what they had just typed (spec 3.8).
 */
export function describePermissions(runner: Runner, patterns: Patterns): { can: string[]; cannot: string[] } {
  const can = [...DEPTH_CAN[runner.depth]];
  const cannot: string[] = [];
  if (runner.depth === "look") cannot.push("submit forms or change any data");
  else cannot.push("change or delete anything it did not create");
  const defaults = defaultPatterns();
  for (const c of CATEGORIES) {
    const label = CATEGORY_LABEL[c];
    if (runner.allow.includes(c)) { can.push(label); continue; }
    if (c === "live") { cannot.push(label); continue; }
    const p = patterns[c], d = defaults[c];
    const stock = [...p.words.filter((w) => d.words.includes(w)), ...p.urls.filter((u) => d.urls.includes(u))];
    const mine = [...p.words.filter((w) => !d.words.includes(w)), ...p.urls.filter((u) => !d.urls.includes(u))];
    const parts: string[] = [];
    if (stock.length) parts.push(`watching for: ${stock.slice(0, 6).join(", ")}${stock.length > 6 ? `, and ${stock.length - 6} more` : ""}`);
    if (mine.length) parts.push(`yours: ${mine.join(", ")}`);
    cannot.push(parts.length ? `${label} (${parts.join("; ")})` : label);
  }
  return { can, cannot };
}
