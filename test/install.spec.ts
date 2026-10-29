import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const spawnSync = vi.fn();
vi.mock("node:child_process", async (orig) => ({ ...(await orig<typeof import("node:child_process")>()), spawnSync }));

const { main } = await import("../src/cli");
await import("../src/setup/install");
const { PLAYWRIGHT_VERSION } = await import("../src/setup/install");

let out = "";
let data: string;
beforeEach(() => {
  out = "";
  spawnSync.mockReset();
  data = realpathSync(mkdtempSync(join(tmpdir(), "install-data-")));
  process.env.BASELINE_DATA = data;
  vi.spyOn(process.stdout, "write").mockImplementation((s: any) => { out += String(s); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((s: any) => { out += String(s); return true; });
});
afterEach(() => vi.restoreAllMocks());

describe("baseline install-browser", () => {
  it("installs the pinned Playwright into the data folder without install scripts, then Chromium", async () => {
    spawnSync.mockReturnValue({ status: 0 });
    expect(await main(["install-browser"])).toBe(0);
    const [npmCmd, npmArgs, npmOpts] = spawnSync.mock.calls[0]!;
    expect(npmCmd).toMatch(/^npm(\.cmd)?$/);
    expect(npmArgs).toEqual(expect.arrayContaining(["--prefix", data, "--ignore-scripts", `playwright@${PLAYWRIGHT_VERSION}`]));
    expect(npmOpts.cwd).toBe(data);
    const [, pwArgs, pwOpts] = spawnSync.mock.calls[1]!;
    expect(pwArgs).toEqual([join(data, "node_modules", "playwright", "cli.js"), "install", "chromium"]);
    expect(pwOpts.env.PLAYWRIGHT_BROWSERS_PATH).toBe(join(data, "browsers"));
    expect(out).toMatch(/browser ready/);
  });
  it("stops with an error when npm fails", async () => {
    spawnSync.mockReturnValueOnce({ status: 1 });
    expect(await main(["install-browser"])).toBe(1);
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(out).toMatch(/could not install Playwright/);
  });
  it("reports a Chromium download failure", async () => {
    spawnSync.mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({ status: 1 });
    expect(await main(["install-browser"])).toBe(1);
    expect(out).toMatch(/could not install Chromium/);
  });
});
