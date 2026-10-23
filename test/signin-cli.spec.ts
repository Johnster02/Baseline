// `baseline signin` refuses to type stored passwords anywhere but the site under test.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli";
import "../src/commands";
import { loadConfig, newRunner, saveConfig } from "../src/config/store";
import { newRun } from "../src/run/state";

let out = "";
let cwd: string;
beforeEach(() => {
  out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s: any) => { out += String(s); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((s: any) => { out += String(s); return true; });
  cwd = mkdtempSync(join(tmpdir(), "signin-cli-"));
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  process.env.BASELINE_DATA = mkdtempSync(join(tmpdir(), "data-"));
  const cfg = loadConfig(cwd);
  saveConfig(cwd, { ...cfg, lastUrl: "https://staging.acme.dev", runners: [newRunner("customer", "customer", { kind: "form", loginUrl: "/login" })] });
});
afterEach(() => vi.restoreAllMocks());

describe("baseline signin --url", () => {
  it("refuses a URL on a different site from the configured one", async () => {
    expect(await main(["signin", "--all", "--url", "https://evil.example"])).toBe(2);
    expect(out).toMatch(/refusing to sign in at https:\/\/evil\.example/);
  });
  it("refuses any other site while a run is active, even one matching the old config", async () => {
    saveConfig(cwd, { ...loadConfig(cwd), lastUrl: "https://evil.example" });
    newRun(cwd, undefined, { url: "https://staging.acme.dev", label: "x" });
    expect(await main(["signin", "customer", "--url", "https://evil.example"])).toBe(2);
    expect(out).toMatch(/a run is active on https:\/\/staging\.acme\.dev/);
  });
  it("rejects a malformed URL", async () => {
    expect(await main(["signin", "--all", "--url", "not a url"])).toBe(2);
    expect(out).toMatch(/not a valid URL/);
  });
  it("names an unknown runner instead of signing anyone in", async () => {
    expect(await main(["signin", "nobody", "--url", "https://staging.acme.dev/x"])).toBe(2);
    expect(out).toMatch(/no runner "nobody"/);
  });
});
