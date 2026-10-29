import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorReport } from "../src/core/doctor";
import { projectHash } from "../src/config/secrets";
import { newRun } from "../src/run/state";

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
let data: string, home: string, proj: string;

beforeEach(() => {
  data = tmp("doc-data-");
  home = tmp("doc-home-");
  proj = tmp("doc-proj-");
  process.env.BASELINE_DATA = data;
  process.env.HOME = home;
});

describe("baseline doctor", () => {
  it("names the resolved folder and every candidate, and never prints what a secret holds", () => {
    const hash = projectHash(proj);
    mkdirSync(join(data, "secrets"), { recursive: true });
    writeFileSync(join(data, "secrets", `${hash}.json`), JSON.stringify({ customer: { username: "u", password: "hunter2" } }));
    mkdirSync(join(data, "sessions", hash), { recursive: true });
    writeFileSync(join(data, "sessions", hash, "customer.json"), "{}");

    const r = doctorReport(proj);
    expect(r.resolved).toBe(data);
    expect(r.candidates.map((c) => c.dir)).toContain(join(home, ".config", "baseline"));
    expect(r.candidates.find((c) => c.dir === data)).toMatchObject({ exists: true, secretsHere: true, sessionsHere: ["customer"] });
    expect(JSON.stringify(r)).not.toContain("hunter2");
    expect(JSON.stringify(r)).not.toContain("username");
  });

  it("says a folder has nothing for this project when the login was saved in the other one", () => {
    const legacy = join(home, ".config", "baseline");
    mkdirSync(join(legacy, "secrets"), { recursive: true });
    writeFileSync(join(legacy, "secrets", `${projectHash(proj)}.json`), "{}");
    const r = doctorReport(proj);
    expect(r.candidates.find((c) => c.dir === legacy)).toMatchObject({ secretsHere: true });
    expect(r.candidates.find((c) => c.dir === data)).toMatchObject({ secretsHere: false, sessionsHere: [] });
  });

  it("reports the active run when one is going", () => {
    const { runDir } = newRun(proj, undefined, { url: "https://staging.acme.dev", label: "x" });
    expect(doctorReport(proj).activeRun).toBe(runDir);
  });

  it("reports no active run on a fresh project", () => {
    expect(doctorReport(proj).activeRun).toBeUndefined();
  });

  it("shows the migration breadcrumb once the legacy folder has been copied across", () => {
    const legacy = join(home, ".config", "baseline");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "migrated-to"), data + "\n");
    expect(doctorReport(proj).migratedTo).toBe(data);
  });
});
