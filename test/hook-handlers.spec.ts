// The guard hooks in-process: runGuardHook (shared by dist/hook.cjs) and `baseline hook <name>`.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGuardHook, isGuardHook, safeGuardHook } from "../src/hooks/handlers";
import { runKey } from "../src/core/paths";
import { main, io } from "../src/cli";
import "../src/commands";

const URL_ = "https://staging.acme.dev";
let data: string, project: string, runDir: string;
const env = () => ({ ...process.env, BASELINE_DATA: data, CLAUDE_PROJECT_DIR: project });
const call = (name: Parameters<typeof runGuardHook>[0], input: object) => runGuardHook(name, JSON.stringify({ cwd: project, ...input }), env());

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), "hh-data-"));
  project = mkdtempSync(join(tmpdir(), "hh-proj-"));
  process.env.BASELINE_DATA = data;
  runDir = join(project, ".baseline", "sessions", "s", "runs", "r-1");
  mkdirSync(runDir, { recursive: true });
  const trusted = join(data, "runs", runKey(runDir));
  mkdirSync(trusted, { recursive: true });
  writeFileSync(join(trusted, "run.json"), JSON.stringify({ runDir, projectDir: project, url: URL_, live: false, startedAt: new Date().toISOString() }));
});

describe("runGuardHook", () => {
  it("knows its hook names", () => {
    expect(["bash-guard", "tool-guard", "read-guard", "write-guard"].every(isGuardHook)).toBe(true);
    expect(isGuardHook("store-options")).toBe(false);
  });
  it("lets malformed or non-object input through", () => {
    expect(runGuardHook("bash-guard", "not json", env())).toEqual({ code: 0 });
    expect(runGuardHook("bash-guard", "null", env())).toEqual({ code: 0 });
    expect(runGuardHook("bash-guard", '"a string"', env())).toEqual({ code: 0 });
  });
  it("bash-guard: blocks with exit 2 and a reason while the trusted run is active", () => {
    const r = call("bash-guard", { tool_input: { command: "baseline config allow customer delete" } });
    expect(r.code).toBe(2);
    expect(r.deny).toMatch(/run in progress/);
    expect(call("bash-guard", { tool_input: { command: "ls" } })).toEqual({ code: 0 });
  });
  it("bash-guard: a finished run no longer blocks", () => {
    writeFileSync(join(data, "runs", runKey(runDir), "finished"), "");
    expect(call("bash-guard", { tool_input: { command: "baseline config allow customer delete" } })).toEqual({ code: 0 });
  });
  it("tool-guard: browser MCP tools are off during a run", () => {
    expect(call("tool-guard", { tool_name: "mcp__playwright__browser_navigate" }).code).toBe(2);
    expect(call("tool-guard", { tool_name: "mcp__linear__get_issue" }).code).toBe(0);
  });
  it("write-guard: reads file_path or notebook_path", () => {
    expect(call("write-guard", { tool_input: { file_path: join(project, ".baseline", "config.json") } }).code).toBe(2);
    expect(call("write-guard", { tool_input: { notebook_path: join(data, "x.ipynb") } }).code).toBe(2);
    expect(call("write-guard", { tool_input: { file_path: join(project, "notes.md") } }).code).toBe(0);
  });
  it("read-guard: checks Read's file_path, a search root and a Glob pattern; relative globs stay in the project", () => {
    expect(call("read-guard", { tool_name: "Read", tool_input: { file_path: join(data, "trackers.json") } }).code).toBe(2);
    expect(call("read-guard", { tool_name: "Grep", tool_input: { pattern: "x", path: join(data, "secrets") } }).code).toBe(2);
    expect(call("read-guard", { tool_name: "Glob", tool_input: { pattern: join(data, "**", "*.json") } }).code).toBe(2);
    expect(call("read-guard", { tool_name: "Glob", tool_input: { pattern: "**/*.json" } }).code).toBe(0);
  });
  it("read-guard: Grep or Glob with no path searches cwd, refused when cwd contains the data folder", () => {
    const above = join(data, "..");
    expect(call("read-guard", { cwd: above, tool_name: "Grep", tool_input: { pattern: "password" } }).code).toBe(2);
    expect(call("read-guard", { cwd: above, tool_name: "Glob", tool_input: { pattern: "**/*.json" } }).code).toBe(2);
    expect(call("read-guard", { tool_name: "Grep", tool_input: { pattern: "password" } }).code).toBe(0);
  });
  it("read-guard: a search rooted above the data folder is refused; Grep's regex is never read as a path", () => {
    const above = join(data, "..");
    expect(call("read-guard", { tool_name: "Grep", tool_input: { pattern: "password", path: above } }).code).toBe(2);
    expect(call("read-guard", { tool_name: "Glob", tool_input: { pattern: join(above, "**", "secrets*") } }).code).toBe(2);
    expect(call("read-guard", { tool_name: "Grep", tool_input: { pattern: "x", path: project, glob: join(data, "*.json") } }).code).toBe(2);
    // A regex that happens to look like the data folder's path is just text to search for.
    expect(call("read-guard", { tool_name: "Grep", tool_input: { pattern: join(data, "secrets"), path: project } }).code).toBe(0);
    // Reading one file above the data folder is fine: only searches sweep into it.
    expect(call("read-guard", { tool_name: "Read", tool_input: { file_path: join(above, "notes.txt") } }).code).toBe(0);
  });
  it("bash-guard: a subagent can't start or finish runs, sign in, change config or write .baseline/ mid-run", () => {
    const agent = (command: string) => call("bash-guard", { agent_id: "agent_1", tool_input: { command } });
    for (const c of ["baseline run finish", "baseline run new --url https://x --label y", "baseline signin --all", "baseline config set lastUrl https://x", "echo '{}' > .baseline/config.json", "rm .baseline/active-run", "cp x ./.baseline/active-run"]) {
      expect(agent(c).code, c).toBe(2);
    }
    for (const c of ["baseline config show", "baseline script customer walk.cjs", "echo hi > .baseline/sessions/s/runs/r-1/note.txt", "cat .baseline/config.json"]) {
      expect(agent(c).code, c).toBe(0);
    }
    // The main session (no agent_id) may still finish its own run.
    expect(call("bash-guard", { tool_input: { command: "baseline run finish" } }).code).toBe(0);
  });
  it("a guard that throws blocks the tool while a run is active, and lets it through otherwise", () => {
    const boom = () => { throw new Error("boom"); };
    const stdin = JSON.stringify({ cwd: project, tool_input: { command: "ls" } });
    expect(safeGuardHook("bash-guard", stdin, env(), boom)).toMatchObject({ code: 2, deny: expect.stringMatching(/guard hit an error/) });
    writeFileSync(join(data, "runs", runKey(runDir), "finished"), "");
    expect(safeGuardHook("bash-guard", stdin, env(), boom)).toEqual({ code: 0 });
  });
});

describe("baseline hook", () => {
  let out = "";
  beforeEach(() => {
    out = "";
    vi.spyOn(process, "cwd").mockReturnValue(project);
    vi.spyOn(process.stdout, "write").mockImplementation((s: any) => { out += String(s); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation((s: any) => { out += String(s); return true; });
  });
  afterEach(() => { vi.restoreAllMocks(); delete process.env.CLAUDE_PROJECT_DIR; });

  it("runs a guard hook on stdin and prints the reason it blocked", async () => {
    process.env.CLAUDE_PROJECT_DIR = project;
    vi.spyOn(io, "readStdin").mockReturnValue(JSON.stringify({ cwd: project, tool_input: { command: "baseline config deny customer delete" } }));
    expect(await main(["hook", "bash-guard"])).toBe(2);
    expect(out).toMatch(/run in progress/);
  });
  it("allows when stdin can't be read", async () => {
    vi.spyOn(io, "readStdin").mockImplementation(() => { throw new Error("no stdin"); });
    expect(await main(["hook", "bash-guard"])).toBe(0);
  });
  it("store-options records the plugin data pointer", async () => {
    const home = mkdtempSync(join(tmpdir(), "hh-home-"));
    const prev = { HOME: process.env.HOME, CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA };
    process.env.HOME = home;
    process.env.CLAUDE_PLUGIN_DATA = join(home, ".claude", "plugins", "data", "baseline");
    try {
      expect(await main(["hook", "store-options"])).toBe(0);
      expect(readFileSync(join(home, ".config", "baseline", "plugin-data"), "utf8").trim()).toBe(process.env.CLAUDE_PLUGIN_DATA);
    } finally {
      process.env.HOME = prev.HOME;
      if (prev.CLAUDE_PLUGIN_DATA === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prev.CLAUDE_PLUGIN_DATA;
    }
  });
  it("store-options brings a login saved in the legacy folder across", async () => {
    const home = mkdtempSync(join(tmpdir(), "hh-home-"));
    const legacy = join(home, ".config", "baseline");
    mkdirSync(join(legacy, "secrets"), { recursive: true, mode: 0o700 });
    writeFileSync(join(legacy, "secrets", "abc.json"), "{}", { mode: 0o600 });
    const prev = { HOME: process.env.HOME, CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA };
    process.env.HOME = home;
    process.env.CLAUDE_PLUGIN_DATA = join(home, ".claude", "plugins", "data", "baseline");
    try {
      expect(await main(["hook", "store-options"])).toBe(0);
      expect(existsSync(join(process.env.CLAUDE_PLUGIN_DATA, "secrets", "abc.json"))).toBe(true);
      expect(existsSync(join(legacy, "migrated-to"))).toBe(true);
    } finally {
      process.env.HOME = prev.HOME;
      if (prev.CLAUDE_PLUGIN_DATA === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prev.CLAUDE_PLUGIN_DATA;
    }
  });
  it("rejects an unknown hook", async () => {
    expect(await main(["hook", "nope"])).toBe(2);
    expect(out).toMatch(/unknown hook/);
  });
});
