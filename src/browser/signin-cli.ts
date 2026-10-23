import { register, out, err } from "../cli";
import { activeRunDir } from "./runner-script";
import { loadConfig } from "../config/store";
import { dataDir } from "../config/secrets";
import { captureSession, chooseSignInUrl, signIn } from "./signin";
import { trustedActiveRun } from "../hooks/active-run";
import type { SignInResult } from "./signin";
import { recordRunnerStatus } from "../run/runners";
import { checkRunDir } from "../core/trusted-run";

register("signin", "sign runners in: signin <runner>|--all [--url <url>] [--manual] [--live]", async (args) => {
  const projectDir = process.cwd();
  const cfg = loadConfig(projectDir);
  const urlIdx = args.indexOf("--url");
  // Stored passwords are typed only on the run's own site (or the configured one): a page or
  // ticket that says "sign in at <url>" can't send them anywhere else.
  const chosen = chooseSignInUrl({ flagUrl: urlIdx >= 0 ? args[urlIdx + 1] : undefined, lastUrl: cfg.lastUrl, activeUrl: trustedActiveRun(projectDir)?.url });
  if (!chosen.ok) { err(chosen.reason); return 2; }
  const baseUrl = chosen.url;
  const name = args.find((a, i) => !a.startsWith("--") && i !== urlIdx + 1);
  const runners = args.includes("--all") ? cfg.runners : cfg.runners.filter((r) => r.key === name);
  if (!runners.length) { err(`no runner "${name ?? ""}"`); return 2; }
  const ctx = { projectDir, data: dataDir(), baseUrl, live: args.includes("--live") };
  const results: SignInResult[] = [];
  for (const r of runners) results.push(args.includes("--manual") ? await captureSession(r, cfg, ctx) : await signIn(r, cfg, ctx));
  // Record each runner's status in the active run, so the report can say who was not signed in.
  // Only into a run Baseline started: never a folder an agent named.
  const runDir = activeRunDir(projectDir);
  const checked = runDir ? checkRunDir(projectDir, runDir) : undefined;
  if (checked?.ok) recordRunnerStatus(checked.run.runDir, results);
  out(JSON.stringify(results));
  return results.every((r) => r.ok) ? 0 : 1;
});
