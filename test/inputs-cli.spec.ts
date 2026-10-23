import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli";
import "../src/commands";
import { loadTrackers, storeTrackersFromEnv } from "../src/inputs/trackers";

let out = "";
let cwd: string;
beforeEach(() => {
  out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s: any) => { out += String(s); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((s: any) => { out += String(s); return true; });
  cwd = mkdtempSync(join(tmpdir(), "icli-"));
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  process.env.BASELINE_DATA = mkdtempSync(join(tmpdir(), "data-"));
});
afterEach(() => vi.restoreAllMocks());

describe("trackers store", () => {
  it("saves plugin options from the hook env at 0600 and loads them", () => {
    storeTrackersFromEnv({ CLAUDE_PLUGIN_OPTION_JIRA_BASE_URL: "https://acme.atlassian.net", CLAUDE_PLUGIN_OPTION_JIRA_EMAIL: "qa@acme.test", CLAUDE_PLUGIN_OPTION_JIRA_TOKEN: "tok", CLAUDE_PLUGIN_OPTION_LINEAR_API_KEY: "" });
    const t = loadTrackers();
    expect(t.jira).toEqual({ baseUrl: "https://acme.atlassian.net", email: "qa@acme.test", token: "tok" });
    expect(t.linear).toBeUndefined();
    expect(statSync(join(process.env.BASELINE_DATA!, "trackers.json")).mode & 0o777).toBe(0o600);
  });
});

describe("baseline inputs", () => {
  it("writes inputs.json for a text and a file input", async () => {
    writeFileSync(join(cwd, "spec.md"), "Expired codes are rejected. See https://acme.notion.so/x");
    const run = mkdtempSync(join(tmpdir(), "run-"));
    expect(await main(["inputs", "--run", run, "spec.md", "Check the discount field"])).toBe(0);
    const j = JSON.parse(readFileSync(join(run, "inputs.json"), "utf8"));
    expect(j.items.map((i: any) => i.ref.kind)).toEqual(["file", "text"]);
    expect(j.items[0].links).toEqual(["https://acme.notion.so/x"]);
    expect(j.unreadLinks).toEqual([]);
  });

  it("exits 4 with the options when a key is ambiguous", async () => {
    const run = mkdtempSync(join(tmpdir(), "run-"));
    expect(await main(["inputs", "--run", run, "ABC-12"])).toBe(4);
    expect(JSON.parse(out)).toEqual({ ambiguous: "ABC-12", options: ["jira", "linear"] });
  });

  it("--as forces a kind for an ambiguous key", async () => {
    const run = mkdtempSync(join(tmpdir(), "run-"));
    expect(await main(["inputs", "--run", run, "--as", "linear", "ABC-12"])).toBe(1);
    expect(out).toMatch(/Linear is not set up/);
  });
});

describe("baseline inputs --as", () => {
  it("applies to every ambiguous key instead of crashing", async () => {
    const run = mkdtempSync(join(tmpdir(), "run-"));
    const code = await main(["inputs", "--run", run, "--as", "linear", "ABC-1", "DEF-2"]);
    expect(code).toBe(1);
    expect(out).toMatch(/Linear is not set up/);
  });
});
