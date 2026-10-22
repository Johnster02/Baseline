import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli";
import "../src/commands";
import { loadConfig } from "../src/config/store";

let out = "";
let cwd: string;
beforeEach(() => {
  out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s: any) => { out += String(s); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((s: any) => { out += String(s); return true; });
  cwd = mkdtempSync(join(tmpdir(), "cli-"));
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  process.env.BASELINE_DATA = mkdtempSync(join(tmpdir(), "data-"));
});
afterEach(() => vi.restoreAllMocks());

describe("config cli", () => {
  it("adds a runner, allows a category and describes it", async () => {
    expect(await main(["config", "add-runner", "customer", "customer", "form", "/login"])).toBe(0);
    expect(await main(["config", "allow", "customer", "email"])).toBe(0);
    expect(loadConfig(cwd).runners[0].allow).toEqual(["email"]);
    out = "";
    expect(await main(["config", "describe"])).toBe(0);
    expect(out).toMatch(/customer/);
    expect(out).toMatch(/can: .*send email/is);
  });

  it("rejects an unknown category", async () => {
    await main(["config", "add-runner", "customer", "customer", "session"]);
    expect(await main(["config", "allow", "customer", "nukes"])).toBe(2);
  });

  it("target-check exits 3 on production without --live", async () => {
    await main(["config", "set", "productionUrls", '["https://shop.acme.dev"]']);
    expect(await main(["target-check", "https://shop.acme.dev"])).toBe(3);
    expect(await main(["target-check", "https://shop.acme.dev", "--live"])).toBe(0);
  });

  it("config show never prints secrets", async () => {
    await main(["config", "add-runner", "customer", "customer", "form", "/login"]);
    const { setSecret } = await import("../src/config/secrets");
    setSecret(process.env.BASELINE_DATA!, cwd, "customer", { username: "c@acme.test", password: "hunter2" });
    out = "";
    await main(["config", "show"]);
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("c@acme.test");
  });
});
