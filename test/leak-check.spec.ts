import { describe, it, expect } from "vitest";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leakCheck } from "../scripts/leak-check-lib.mjs";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "leak-")));

describe("leakCheck", () => {
  it("finds a banned term case-insensitively with its line", () => {
    const d = tmp();
    const banned = join(d, "banned.txt");
    writeFileSync(banned, "acmecorp\n\n");
    const f = join(d, "a.md");
    writeFileSync(f, "hello\nWelcome to AcmeCorp tools\n");
    expect(leakCheck([f], banned)).toEqual([{ file: f, line: 2, term: "acmecorp" }]);
  });

  it("returns no hits when the banned-terms file is missing", () => {
    const d = tmp();
    const f = join(d, "a.md");
    writeFileSync(f, "AcmeCorp");
    expect(leakCheck([f], join(d, "missing.txt"))).toEqual([]);
  });
});

describe("leakCheckAuthors", () => {
  it("flags a banned term in commit author or committer emails", async () => {
    const { leakCheckAuthors } = await import("../scripts/leak-check-lib.mjs");
    const d = tmp();
    const banned = join(d, "banned.txt");
    writeFileSync(banned, "acmecorp\n");
    expect(leakCheckAuthors(["abc123 me@gmail.com me@gmail.com", "def456 jo@acmecorp.com me@gmail.com"], banned)).toEqual([{ commit: "def456", term: "acmecorp" }]);
  });
});
