import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProjectRoot } from "../src/project";

describe("findProjectRoot", () => {
  it("finds the nearest folder with .baseline/config.json at or above the start", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "proj-")));
    mkdirSync(join(root, ".baseline"));
    writeFileSync(join(root, ".baseline", "config.json"), "{}");
    const deep = join(root, ".baseline", "sessions", "s", "runs", "r-1");
    mkdirSync(deep, { recursive: true });
    expect(findProjectRoot(root)).toBe(root);
    expect(findProjectRoot(deep)).toBe(root);
  });
  it("ignores a .baseline folder without a config", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "proj-")));
    mkdirSync(join(root, ".baseline"));
    expect(findProjectRoot(root)).toBeUndefined();
  });
});
