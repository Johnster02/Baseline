// dist/hook.cjs end to end: what hooks.json runs on every tool call.
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runKey } from "../src/core/paths";

const ROOT = join(__dirname, "..");
const URL_ = "https://staging.acme.dev";
let data: string, project: string, runDir: string, idle: string;

const hook = (name: string, input: unknown, projectDir = project) =>
  spawnSync(process.execPath, [join(ROOT, "dist", "hook.cjs"), name], {
    input: JSON.stringify({ cwd: projectDir, ...(input as object) }), encoding: "utf8",
    env: { ...process.env, BASELINE_DATA: data, CLAUDE_PROJECT_DIR: projectDir },
  });

beforeAll(() => {
  data = mkdtempSync(join(tmpdir(), "hook-data-"));
  project = mkdtempSync(join(tmpdir(), "hook-proj-"));
  idle = mkdtempSync(join(tmpdir(), "hook-idle-"));
  runDir = join(project, ".baseline", "sessions", "s", "runs", "r-1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(project, ".baseline", "active-run"), runDir);
  // The trusted record `run new` leaves in the data folder: what the hook believes.
  const trusted = join(data, "runs", runKey(runDir));
  mkdirSync(trusted, { recursive: true });
  writeFileSync(join(trusted, "run.json"), JSON.stringify({ runDir, projectDir: project, url: URL_, live: false, startedAt: new Date().toISOString() }));
});

describe("dist/hook.cjs during an active run", () => {
  it("bash-guard blocks permission changes, however baseline is spelled", () => {
    for (const command of ["baseline config allow customer delete", "X=1 baseline config allow customer delete", "./bin/baseline config depth customer create"]) {
      const r = hook("bash-guard", { tool_input: { command } });
      expect(r.status, command).toBe(2);
      expect(r.stderr).toMatch(/run in progress/);
    }
  });
  it("bash-guard blocks direct writes to the site under test and allows reads", () => {
    expect(hook("bash-guard", { tool_input: { command: `curl -X POST ${URL_}/api/orders` } }).status).toBe(2);
    expect(hook("bash-guard", { tool_input: { command: `curl ${URL_}/health` } }).status).toBe(0);
    expect(hook("bash-guard", { tool_input: { command: "baseline script customer s.cjs" } }).status).toBe(0);
  });
  it("tool-guard turns browser MCP tools off and leaves others alone", () => {
    expect(hook("tool-guard", { tool_name: "mcp__playwright__browser_click" }).status).toBe(2);
    expect(hook("tool-guard", { tool_name: "mcp__claude-in-chrome__navigate" }).status).toBe(2);
    expect(hook("tool-guard", { tool_name: "mcp__github__get_issue" }).status).toBe(0);
  });
  it("write-guard blocks edits to the project config but not to the run folder or code", () => {
    expect(hook("write-guard", { tool_input: { file_path: join(project, ".baseline", "config.json") } }).status).toBe(2);
    expect(hook("write-guard", { tool_input: { file_path: join(runDir, "findings.json") } }).status).toBe(0);
    expect(hook("write-guard", { tool_input: { file_path: join(project, "src", "app.ts") } }).status).toBe(0);
  });
  it("read-guard blocks the data folder and allows project files", () => {
    expect(hook("read-guard", { tool_input: { file_path: join(data, "secrets", "x.json") } }).status).toBe(2);
    expect(hook("read-guard", { tool_input: { file_path: join(project, "README.md") } }).status).toBe(0);
  });
});

describe("dist/hook.cjs with no active run", () => {
  it("allows config changes, site calls and browser tools", () => {
    expect(hook("bash-guard", { tool_input: { command: "baseline config allow customer delete" } }, idle).status).toBe(0);
    expect(hook("bash-guard", { tool_input: { command: `curl -X POST ${URL_}/api/orders` } }, idle).status).toBe(0);
    expect(hook("tool-guard", { tool_name: "mcp__playwright__browser_click" }, idle).status).toBe(0);
    expect(hook("write-guard", { tool_input: { file_path: join(idle, ".baseline", "config.json") } }, idle).status).toBe(0);
  });
  it("still keeps agents out of the data folder", () => {
    expect(hook("bash-guard", { tool_input: { command: `cat ${data}/trackers.json` } }, idle).status).toBe(2);
    expect(hook("write-guard", { tool_input: { file_path: join(data, "secrets", "x.json") } }, idle).status).toBe(2);
  });
});
