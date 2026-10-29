import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { leakCheck } from "../scripts/leak-check-lib.mjs";

const AGENTS = join(__dirname, "..", "agents");
const EXPECTED: Record<string, { model: string; output: RegExp }> = {
  gatherer: { model: "haiku", output: /inputs\.json/ },
  "code-reader": { model: "sonnet", output: /code\.json/ },
  explorer: { model: "sonnet", output: /explore-<runner>\.json/ },
  "guide-reader": { model: "sonnet", output: /guide\.json/ },
  refuter: { model: "opus", output: /refuted\.json/ },
  cleaner: { model: "haiku", output: /cleanup\.json/ },
};

function front(md: string): Record<string, string> {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  return Object.fromEntries(m[1]!.split("\n").filter((l) => l.includes(":")).map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]));
}

describe("agents", () => {
  it("has exactly the six agents", () => {
    expect(readdirSync(AGENTS).sort()).toEqual(Object.keys(EXPECTED).map((n) => n + ".md").sort());
  });
  for (const [name, exp] of Object.entries(EXPECTED)) {
    it(`${name} has frontmatter, its model, its output contract and the never-assume rule`, () => {
      const md = readFileSync(join(AGENTS, name + ".md"), "utf8");
      const f = front(md);
      expect(f.name).toBe(name);
      expect(f.description?.length).toBeGreaterThan(20);
      expect(f.model).toBe(exp.model);
      expect(f.tools).toBeTruthy();
      expect(md).toMatch(exp.output);
      expect(md).toMatch(/never assume/i);
    });
  }
  it("every agent told to write a file has the Write tool", () => {
    for (const name of Object.keys(EXPECTED)) {
      const md = readFileSync(join(AGENTS, name + ".md"), "utf8");
      if (!/write `<runDir>/.test(md)) continue;
      expect(front(md).tools, `${name} is told to write a file`).toMatch(/\bWrite\b/);
    }
  });

  it("explorers and the cleaner only drive the browser through baseline script", () => {
    for (const n of ["explorer", "cleaner"]) {
      const md = readFileSync(join(AGENTS, n + ".md"), "utf8");
      expect(md).toContain("baseline script");
      expect(md).toMatch(/never (use|run|import) playwright/i);
    }
  });
});

describe("product checklist", () => {
  it("exists and has the generic items", () => {
    const md = readFileSync(join(__dirname, "..", "checklists", "product.md"), "utf8");
    for (const s of ["greyed", "busy", "clips", "empty state", "lose", "every surface"]) expect(md.toLowerCase()).toContain(s);
  });
  it("passes the leak check when a banned-terms file exists", () => {
    const banned = process.env.BASELINE_BANNED_TERMS || join(process.env.HOME ?? "", ".config", "baseline-private", "banned-terms.txt");
    expect(leakCheck([join(__dirname, "..", "checklists", "product.md"), ...readdirSync(AGENTS).map((n) => join(AGENTS, n))], banned)).toEqual([]);
  });
});
