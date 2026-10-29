import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli";
import "../src/commands";
import { loadConfig, saveConfig } from "../src/config/store";

let out = "";
let cwd: string;
beforeEach(() => {
  out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s: any) => { out += String(s); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((s: any) => { out += String(s); return true; });
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "rcli-")));
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
});
afterEach(() => vi.restoreAllMocks());

describe("run cli", () => {
  it("run new, progress and run finish work on the active run", async () => {
    expect(await main(["run", "new", "--url", "http://localhost:3000", "--label", "PR #412", "--session", "s1"])).toBe(0);
    const { runDir } = JSON.parse(out);
    expect(await main(["progress", "start", "quick", "3"])).toBe(0);
    expect(await main(["progress", "phase", "explore", "active", "62", "two explorers"])).toBe(0);
    expect(await main(["progress", "agent", "customer", "opening /cart"])).toBe(0);
    const p = JSON.parse(readFileSync(join(runDir, "progress.json"), "utf8"));
    expect(p).toMatchObject({ label: "PR #412", size: "quick", agents: 3 });
    expect(p.phases.find((x: any) => x.name === "explore")).toMatchObject({ status: "active", pct: 62, note: "two explorers" });
    expect(await main(["progress", "done"])).toBe(0);
    expect(JSON.parse(readFileSync(join(runDir, "progress.json"), "utf8")).finishedAt).toBeTruthy();
    expect(await main(["run", "finish"])).toBe(0);
  });

  it("won't start a second run while one is still going, unless --force", async () => {
    process.env.BASELINE_DATA = realpathSync(mkdtempSync(join(tmpdir(), "rcli-data-")));
    expect(await main(["run", "new", "--url", "http://x", "--label", "a"])).toBe(0);
    out = "";
    expect(await main(["run", "new", "--url", "http://x", "--label", "b"])).toBe(4);
    expect(out).toMatch(/another run is still in progress/);
    expect(await main(["run", "new", "--url", "http://x", "--label", "b", "--force"])).toBe(0);
    expect(await main(["run", "finish"])).toBe(0);
  });

  it("progress updates from parallel processes are all kept", async () => {
    await main(["run", "new", "--url", "http://x", "--label", "x"]);
    const runDir = readFileSync(join(cwd, ".baseline", "active-run"), "utf8");
    const { execFile } = await import("node:child_process");
    const repo = join(__dirname, "..");
    const mod = JSON.stringify(join(repo, "src/run/progress.ts"));
    const code = `import(${mod}).then((m) => m.updateProgress(process.argv[1], { agent: { persona: process.argv[2], doing: "x" } }))`;
    const run = (i: number) => new Promise<void>((res, rej) => execFile(process.execPath, ["--import", "tsx", "-e", code, runDir, `p${i}`], { cwd: repo }, (e) => (e ? rej(e) : res())));
    await Promise.all(Array.from({ length: 8 }, (_, i) => run(i)));
    expect(JSON.parse(readFileSync(join(runDir, "progress.json"), "utf8")).active).toHaveLength(8);
  }, 30000);

  it("a lock left by a killed process does not block progress forever", async () => {
    await main(["run", "new", "--url", "http://x", "--label", "x"]);
    const runDir = readFileSync(join(cwd, ".baseline", "active-run"), "utf8");
    const { utimesSync } = await import("node:fs");
    const lock = join(runDir, "progress.json.lock");
    writeFileSync(lock, "");
    utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    expect(await main(["progress", "agent", "customer", "opening"])).toBe(0);
    expect(JSON.parse(readFileSync(join(runDir, "progress.json"), "utf8")).active).toHaveLength(1);
  });

  it("commit --out refuses a sibling folder that shares the run's prefix", async () => {
    await main(["run", "new", "--url", "http://x", "--label", "x"]);
    const runDir = readFileSync(join(cwd, ".baseline", "active-run"), "utf8");
    expect(await main(["commit", "--out", runDir + "-evil/commit.json"])).toBe(2);
  });

  it("inputs falls back to the active run like every other command", async () => {
    await main(["run", "new", "--url", "http://x", "--label", "x"]);
    const runDir = readFileSync(join(cwd, ".baseline", "active-run"), "utf8");
    expect(await main(["inputs", "Check the discount field"])).toBe(0);
    expect(JSON.parse(readFileSync(join(runDir, "inputs.json"), "utf8")).items[0].ref.kind).toBe("text");
  });

  it("progress rejects an unknown phase", async () => {
    await main(["run", "new", "--url", "http://x", "--label", "x"]);
    expect(await main(["progress", "phase", "lunch", "active"])).toBe(2);
  });

  it("size reads inputs.json and prints the plan", async () => {
    await main(["run", "new", "--url", "http://x", "--label", "x"]);
    const runDir = readFileSync(join(cwd, ".baseline", "active-run"), "utf8");
    writeFileSync(join(runDir, "inputs.json"), JSON.stringify({ items: [{ ref: { kind: "github-pr", ref: "412" }, body: "short", changedFiles: ["a.ts"] }] }));
    out = "";
    expect(await main(["size", "--personas", "customer"])).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ size: "pr", codeOnly: false });
  });

  it("sitemap merge reads a file", async () => {
    const f = join(cwd, "m.json");
    writeFileSync(f, JSON.stringify({ routes: [{ path: "/cart", title: "Cart", personas: ["customer"] }], notes: [] }));
    expect(await main(["sitemap", "merge", f])).toBe(0);
    out = "";
    await main(["sitemap", "show"]);
    expect(JSON.parse(out).routes[0].path).toBe("/cart");
  });
});

describe("run new: production", () => {
  it("refuses a production URL itself, and records --live", async () => {
    const cfg = { ...loadConfig(cwd), productionUrls: ["https://shop.acme.dev"] };
    saveConfig(cwd, cfg);
    expect(await main(["run", "new", "--url", "https://shop.acme.dev", "--label", "x"])).toBe(3);
    expect(await main(["run", "new", "--url", "https://shop.acme.dev", "--label", "x", "--live"])).toBe(0);
    const runDir = readFileSync(join(cwd, ".baseline", "active-run"), "utf8");
    expect(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).live).toBe(true);
  });
});
