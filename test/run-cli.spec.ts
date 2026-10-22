import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli";
import "../src/commands";

let out = "";
let cwd: string;
beforeEach(() => {
  out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s: any) => { out += String(s); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((s: any) => { out += String(s); return true; });
  cwd = mkdtempSync(join(tmpdir(), "rcli-"));
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

  it("progress rejects an unknown phase", async () => {
    await main(["run", "new", "--url", "http://x", "--label", "x"]);
    expect(await main(["progress", "phase", "lunch", "active"])).toBe(2);
  });

  it("size reads inputs.json and prints the plan", async () => {
    await main(["run", "new", "--url", "http://x", "--label", "x"]);
    const runDir = readFileSync(join(cwd, ".baseline", "active-run"), "utf8");
    writeFileSync(join(runDir, "inputs.json"), JSON.stringify({ items: [{ ref: { kind: "github-pr" }, body: "short", changedFiles: ["a.ts"] }] }));
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
