import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CATEGORIES, CATEGORY_LABEL, projectConfigSchema, runnerSchema } from "./schema";
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

export function newRunner(key: string, persona: string, auth: Runner["auth"]): Runner {
  return runnerSchema.parse({ key, persona, auth });
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

export function describePermissions(runner: Runner, patterns: Patterns): { can: string[]; cannot: string[] } {
  const can = [...DEPTH_CAN[runner.depth]];
  const cannot: string[] = [];
  if (runner.depth === "look") cannot.push("submit forms or change any data");
  else cannot.push("change or delete anything it did not create");
  for (const c of CATEGORIES) {
    const label = CATEGORY_LABEL[c];
    if (runner.allow.includes(c)) { can.push(label); continue; }
    const p = c === "live" ? undefined : patterns[c];
    const named = p && (p.words.length || p.urls.length) ? ` (watching for: ${[...p.words, ...p.urls].slice(0, 6).join(", ")})` : "";
    cannot.push(label + named);
  }
  return { can, cannot };
}
