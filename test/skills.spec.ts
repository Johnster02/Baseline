import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { commandNames } from "../src/cli";
import "../src/commands";

const SKILLS = join(__dirname, "..", "skills");
describe("skills", () => {
  const names = readdirSync(SKILLS);
  it("has run, setup, dismiss and theme", () => {
    expect(names.sort()).toEqual(["dismiss", "run", "setup", "theme"]);
  });
  for (const n of ["dismiss", "run", "setup", "theme"]) {
    it(`${n} has a description and only calls baseline commands that exist`, () => {
      const p = join(SKILLS, n, "SKILL.md");
      expect(existsSync(p)).toBe(true);
      const md = readFileSync(p, "utf8");
      expect(md).toMatch(/^---\n[\s\S]*?description: .{30,}[\s\S]*?\n---/);
      const used = [...md.matchAll(/(?:^|[\s`(])baseline ([a-z][a-z-]*)/g)].map((m) => m[1]!);
      const known = new Set(commandNames());
      for (const u of used) expect(known.has(u), `${n} uses unknown command "baseline ${u}"`).toBe(true);
    });
  }
  it("run never promises a pass/fail result", () => {
    const md = readFileSync(join(SKILLS, "run", "SKILL.md"), "utf8");
    expect(md).not.toMatch(/Ready for QA|Needs work/);
    expect(md).toMatch(/Complete/);
  });
});
