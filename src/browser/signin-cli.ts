import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { register, out, err } from "../cli";
import { activeRunDir } from "./runner-script";
import { loadConfig } from "../config/store";
import { dataDir } from "../config/secrets";
import { captureSession, signIn } from "./signin";
import type { SignInResult } from "./signin";

register("signin", "sign runners in: signin <runner>|--all [--url <url>] [--manual] [--live]", async (args) => {
  const projectDir = process.cwd();
  const cfg = loadConfig(projectDir);
  const urlIdx = args.indexOf("--url");
  const baseUrl = urlIdx >= 0 ? args[urlIdx + 1] : cfg.lastUrl;
  if (!baseUrl) { err("no URL: pass --url <url>"); return 2; }
  const name = args.find((a, i) => !a.startsWith("--") && i !== urlIdx + 1);
  const runners = args.includes("--all") ? cfg.runners : cfg.runners.filter((r) => r.key === name);
  if (!runners.length) { err(`no runner "${name ?? ""}"`); return 2; }
  const ctx = { projectDir, data: dataDir(), baseUrl, live: args.includes("--live") };
  const results: SignInResult[] = [];
  for (const r of runners) results.push(args.includes("--manual") ? await captureSession(r, cfg, ctx) : await signIn(r, cfg, ctx));
  // Record each runner's status in the active run, so the report can say who was not signed in.
  const runDir = activeRunDir(projectDir);
  if (runDir && existsSync(join(runDir, "run.json"))) {
    const file = join(runDir, "runners.json");
    let prev: { key: string }[] = [];
    try { prev = JSON.parse(readFileSync(file, "utf8")); } catch { prev = []; }
    const merged = [...prev.filter((p) => !results.some((r) => r.key === p.key)), ...results.map(({ key, ok, error }) => ({ key, ok, ...(error ? { error } : {}) }))];
    writeFileSync(file, JSON.stringify(merged, null, 2));
  }
  out(JSON.stringify(results));
  return results.every((r) => r.ok) ? 0 : 1;
});
