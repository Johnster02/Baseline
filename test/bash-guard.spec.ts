import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashGuard, activeRunUrl } from "../src/hooks/bash-guard";

const url = "https://staging.acme.dev";
describe("bashGuard during an active run", () => {
  const deny = (cmd: string) => expect(bashGuard(cmd, { runUrl: url })).toMatchObject({ deny: expect.any(String) });
  const allow = (cmd: string) => expect(bashGuard(cmd, { runUrl: url })).toEqual({ allow: true });
  it("denies writes to the site under test with curl, wget and friends", () => {
    deny("curl -X POST https://staging.acme.dev/api/cart");
    deny("curl --request DELETE https://staging.acme.dev/api/users/7");
    deny("curl -d 'a=1' https://staging.acme.dev/api/cart");
    deny("curl --json '{}' staging.acme.dev/api");
    deny("wget --method=PUT https://staging.acme.dev/x");
    deny("wget --post-data=a https://staging.acme.dev/x");
    deny("http POST https://staging.acme.dev/api/cart a=1");
  });
  it("allows reads of the site and writes elsewhere", () => {
    allow("curl https://staging.acme.dev/version");
    allow("curl -s -I https://staging.acme.dev/");
    allow("curl -X POST https://api.github.com/graphql");
  });
  it("denies driving Playwright directly", () => {
    deny("npx playwright test");
    deny("node -e \"require('playwright')\"");
    deny("pnpm exec playwright codegen https://staging.acme.dev");
  });
  it("allows baseline itself", () => {
    allow("baseline script customer .baseline/sessions/s/runs/r-1/explore/customer/walk.cjs");
    allow("baseline config describe");
    allow("baseline progress agent customer 'opening /cart'");
  });
});

describe("bashGuard with no active run", () => {
  it("allows everything", () => {
    expect(bashGuard("curl -X POST https://staging.acme.dev/api/cart", {})).toEqual({ allow: true });
  });
});

describe("activeRunUrl", () => {
  it("reads the url of the active run in this project only", () => {
    const p = mkdtempSync(join(tmpdir(), "bg-"));
    expect(activeRunUrl(p)).toBeUndefined();
    const runDir = join(p, ".baseline", "sessions", "s", "runs", "r-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ url, startedAt: new Date().toISOString() }));
    writeFileSync(join(p, ".baseline", "active-run"), runDir);
    expect(activeRunUrl(p)).toBe(url);
  });
});

describe("plugin data pointer", () => {
  it("the SessionStart hook records CLAUDE_PLUGIN_DATA so plain `baseline` calls find it", async () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const { recordPluginData, dataDir } = await import("../src/config/secrets");
    const target = join(home, ".claude", "plugins", "data", "baseline");
    recordPluginData(target, home);
    expect(readFileSync(join(home, ".config", "baseline", "plugin-data"), "utf8").trim()).toBe(target);
    const saved = { ...process.env };
    delete process.env.BASELINE_DATA; delete process.env.CLAUDE_PLUGIN_DATA; process.env.HOME = home;
    try { expect(dataDir()).toBe(target); } finally { process.env = saved; }
  });
});

describe("task 13 review: guard hardening", () => {
  const ctx = { runUrl: url };
  const deny = (cmd: string) => expect(bashGuard(cmd, ctx), cmd).toMatchObject({ deny: expect.any(String) });
  const allow = (cmd: string) => expect(bashGuard(cmd, ctx), cmd).toEqual({ allow: true });
  it("a baseline prefix does not excuse a chained command", () => {
    deny("baseline config describe && curl -X POST https://staging.acme.dev/api");
    deny("baseline view; curl -d a=1 https://staging.acme.dev/x");
  });
  it("agents cannot change permissions or production protection mid-run", () => {
    for (const c of ["baseline config allow customer finance", "baseline config deny customer email", "baseline config depth customer workflow",
      "baseline config set productionUrls '[]'", "baseline config secret customer", "baseline config add-runner x x session",
      "baseline config remove-runner customer", "baseline signin --all --live", "baseline target-check https://x --live"]) deny(c);
  });
  it("catches paths, quotes, case, short flags and scripting languages", () => {
    deny("/usr/bin/curl -X POST https://staging.acme.dev/api");
    deny("\"curl\" -X POST https://staging.acme.dev/api");
    deny("curl -X POST https://STAGING.acme.dev/api");
    deny("curl -d@body.json https://staging.acme.dev/api");
    deny("curl -sd x=1 https://staging.acme.dev/api");
    deny("python3 -c \"import requests; requests.post('https://staging.acme.dev/api')\"");
    deny("node -e \"fetch('https://staging.acme.dev/api',{method:'DELETE'})\"");
  });
  it("does not block harmless commands", () => {
    allow("curl -f https://staging.acme.dev/health");
    allow("wget -t 3 https://staging.acme.dev/");
    allow("grep -n playwright package.json");
    allow("cat playwright.config.ts");
    allow("baseline config describe");
    allow("baseline script customer walk.cjs");
  });
  it("treats localhost and 127.0.0.1 as the same site", () => {
    expect(bashGuard("curl -X POST http://localhost:4517/api", { runUrl: "http://127.0.0.1:4517" })).toMatchObject({ deny: expect.any(String) });
  });
  it("blocks browser MCP tools while a run is active", async () => {
    const { toolGuard } = await import("../src/hooks/bash-guard");
    expect(toolGuard("mcp__playwright__browser_click", ctx)).toMatchObject({ deny: expect.any(String) });
    expect(toolGuard("mcp__claude-in-chrome__computer", ctx)).toMatchObject({ deny: expect.any(String) });
    expect(toolGuard("WebFetch", ctx)).toEqual({ allow: true });
    expect(toolGuard("mcp__playwright__browser_click", {})).toEqual({ allow: true });
  });
});

describe("active run detection", () => {
  it("ignores a pointer that escapes the sessions folder", () => {
    const p = mkdtempSync(join(tmpdir(), "bg-"));
    const evil = join(p, ".baseline", "sessions", "..", "..", "evil");
    mkdirSync(evil, { recursive: true });
    mkdirSync(join(p, ".baseline", "sessions"), { recursive: true });
    writeFileSync(join(evil, "run.json"), JSON.stringify({ url, startedAt: new Date().toISOString() }));
    writeFileSync(join(p, ".baseline", "active-run"), evil);
    expect(activeRunUrl(p)).toBeUndefined();
  });
  it("ignores a stale run older than 6 hours", () => {
    const p = mkdtempSync(join(tmpdir(), "bg-"));
    const runDir = join(p, ".baseline", "sessions", "s", "runs", "r-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ url, startedAt: new Date(Date.now() - 7 * 3600e3).toISOString() }));
    writeFileSync(join(p, ".baseline", "active-run"), runDir);
    expect(activeRunUrl(p)).toBeUndefined();
  });
});

describe("data dir safety", () => {
  it("never uses a data dir inside the project", async () => {
    const { dataDir } = await import("../src/config/secrets");
    const proj = mkdtempSync(join(tmpdir(), "proj-"));
    const saved = { ...process.env };
    process.env.BASELINE_DATA = join(proj, "steal");
    try { expect(() => dataDir(proj)).toThrow(/inside the project/); } finally { process.env = saved; }
  });
  it("ignores a pointer outside ~/.claude/plugins", async () => {
    const { recordPluginData, dataDir } = await import("../src/config/secrets");
    const home = mkdtempSync(join(tmpdir(), "home-"));
    recordPluginData("/tmp/somewhere-else", home);
    const saved = { ...process.env };
    delete process.env.BASELINE_DATA; delete process.env.CLAUDE_PLUGIN_DATA; process.env.HOME = home;
    try { expect(dataDir()).toBe(join(home, ".config", "baseline")); } finally { process.env = saved; }
  });
});
