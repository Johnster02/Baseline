// The bundled CLI as agents run it: from the project root or from inside a run folder.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(__dirname, "..", "dist", "cli.cjs");
const run = (args: string[], cwd: string) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, BASELINE_DATA: mkdtempSync(join(tmpdir(), "entry-data-")) } });

describe("dist/cli.cjs", () => {
  it("prints the plugin version", () => {
    const r = run(["version"], tmpdir());
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(JSON.parse(readFileSync(join(__dirname, "..", ".claude-plugin", "plugin.json"), "utf8")).version);
  });
  it("prints usage and exits 2 for an unknown command", () => {
    const r = run(["no-such-command"], tmpdir());
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage: baseline/);
  });
  it("works from inside a run folder by moving to the project root", () => {
    const root = mkdtempSync(join(tmpdir(), "entry-proj-"));
    mkdirSync(join(root, ".baseline"));
    writeFileSync(join(root, ".baseline", "config.json"), "{}");
    const deep = join(root, ".baseline", "sessions", "s", "runs", "r-1");
    mkdirSync(deep, { recursive: true });
    expect(run(["config", "set", "lastUrl", "https://entry.acme.dev"], root).status).toBe(0);
    const r = run(["config", "show"], deep);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("https://entry.acme.dev");
  });
});
