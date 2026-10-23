import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../core/paths";
import { readJsonFile } from "../core/json";
import { trackersSchema } from "./fetch";
import type { Trackers } from "./fetch";

const file = () => join(dataDir(), "trackers.json");

/**
 * Plugin options reach hooks as CLAUDE_PLUGIN_OPTION_* env vars but are hidden from skills, so a
 * SessionStart hook calls this to keep them in a 0600 file the CLI can read.
 */
export function storeTrackersFromEnv(env: NodeJS.ProcessEnv): void {
  const o = (k: string) => (env[`CLAUDE_PLUGIN_OPTION_${k}`] || "").trim();
  const t: Trackers = {};
  if (o("JIRA_BASE_URL") && o("JIRA_TOKEN")) t.jira = { baseUrl: o("JIRA_BASE_URL"), email: o("JIRA_EMAIL"), token: o("JIRA_TOKEN") };
  if (o("LINEAR_API_KEY")) t.linear = { apiKey: o("LINEAR_API_KEY") };
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  writeFileSync(file(), JSON.stringify(t), { mode: 0o600 });
  chmodSync(file(), 0o600);
}

export function loadTrackers(): Trackers {
  const t: Trackers = readJsonFile(file(), (v) => trackersSchema.parse(v), {});
  const e = process.env;
  if (e.BASELINE_JIRA_BASE_URL && e.BASELINE_JIRA_TOKEN) t.jira = { baseUrl: e.BASELINE_JIRA_BASE_URL, email: e.BASELINE_JIRA_EMAIL || "", token: e.BASELINE_JIRA_TOKEN };
  if (e.BASELINE_LINEAR_API_KEY) t.linear = { apiKey: e.BASELINE_LINEAR_API_KEY };
  return t;
}
