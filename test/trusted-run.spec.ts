// Which run folders Baseline will open a browser for, or hand to a script sandbox.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRunDir, readTrustedRun } from "../src/core/trusted-run";
import { trustedFiles } from "../src/core/paths";

let proj: string;
beforeEach(() => {
  proj = realpathSync(mkdtempSync(join(tmpdir(), "tr-proj-")));
  process.env.BASELINE_DATA = realpathSync(mkdtempSync(join(tmpdir(), "tr-data-")));
});

const runFolder = (id = "r-1") => {
  const d = join(proj, ".baseline", "sessions", "s", "runs", id);
  mkdirSync(d, { recursive: true });
  return d;
};
const record = (runDir: string, extra: object = {}) =>
  writeFileSync(trustedFiles.run(runDir), JSON.stringify({ runDir, projectDir: proj, runId: "r-1", url: "https://staging.acme.dev", startedAt: new Date().toISOString(), ...extra }));

describe("checkRunDir", () => {
  it("accepts a run folder `run new` recorded for this project", () => {
    const d = runFolder();
    record(d);
    const c = checkRunDir(proj, d);
    expect(c).toMatchObject({ ok: true, run: { url: "https://staging.acme.dev", finished: false } });
  });
  it("refuses a folder outside .baseline/sessions, and the sessions folder itself", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "tr-home-")));
    writeFileSync(join(outside, "run.json"), "{}");
    expect(checkRunDir(proj, outside)).toMatchObject({ ok: false, reason: expect.stringMatching(/not a run folder/) });
    runFolder();
    expect(checkRunDir(proj, join(proj, ".baseline", "sessions"))).toMatchObject({ ok: false });
  });
  it("refuses a run folder with no record, or a record copied from another run", () => {
    const d = runFolder("r-1"), other = runFolder("r-2");
    expect(checkRunDir(proj, d)).toMatchObject({ ok: false, reason: expect.stringMatching(/no record/) });
    // r-1's record names r-2: it vouches only for the folder it names.
    record(d, { runDir: other });
    expect(checkRunDir(proj, d)).toMatchObject({ ok: false });
    expect(readTrustedRun(d)).toBeUndefined();
  });
  it("refuses a run recorded for another project", () => {
    const d = runFolder();
    record(d, { projectDir: realpathSync(mkdtempSync(join(tmpdir(), "tr-other-"))) });
    expect(checkRunDir(proj, d)).toMatchObject({ ok: false, reason: expect.stringMatching(/another project/) });
  });
  it("refuses a run folder that holds the data folder", () => {
    const d = runFolder();
    process.env.BASELINE_DATA = join(d, "data");
    mkdirSync(process.env.BASELINE_DATA, { recursive: true });
    expect(checkRunDir(proj, d)).toMatchObject({ ok: false });
  });
});
