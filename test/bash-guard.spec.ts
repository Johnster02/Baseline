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
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ url }));
    writeFileSync(join(p, ".baseline", "active-run"), runDir);
    expect(activeRunUrl(p)).toBe(url);
  });
});

describe("plugin data pointer", () => {
  it("the SessionStart hook records CLAUDE_PLUGIN_DATA so plain `baseline` calls find it", async () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const { recordPluginData, dataDir } = await import("../src/config/secrets");
    recordPluginData("/x/plugins/data/baseline", home);
    expect(readFileSync(join(home, ".config", "baseline", "plugin-data"), "utf8").trim()).toBe("/x/plugins/data/baseline");
    const saved = { ...process.env };
    delete process.env.BASELINE_DATA; delete process.env.CLAUDE_PLUGIN_DATA; process.env.HOME = home;
    try { expect(dataDir()).toBe("/x/plugins/data/baseline"); } finally { process.env = saved; }
  });
});
