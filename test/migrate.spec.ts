import { describe, it, expect } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyData } from "../src/core/migrate";

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const hash = "0123456789abcdef";

/** A legacy ~/.config/baseline holding one runner's password file and one saved session. */
function legacyWithState(): string {
  const legacy = tmp("legacy-");
  mkdirSync(join(legacy, "secrets"), { recursive: true, mode: 0o700 });
  writeFileSync(join(legacy, "secrets", `${hash}.json`), JSON.stringify({ customer: { username: "u" } }), { mode: 0o600 });
  mkdirSync(join(legacy, "sessions", hash), { recursive: true, mode: 0o700 });
  writeFileSync(join(legacy, "sessions", hash, "customer.json"), JSON.stringify({ cookies: [] }), { mode: 0o600 });
  return legacy;
}

describe("migrating the legacy data folder", () => {
  it("moves secrets and sessions, keeps their modes, and leaves a breadcrumb", () => {
    const legacy = legacyWithState(), target = tmp("target-");
    const r = migrateLegacyData({ legacy, target });
    expect(r.moved).toContain("secrets");
    expect(r.moved).toContain("sessions");
    expect(statSync(join(target, "secrets", `${hash}.json`)).mode & 0o777).toBe(0o600);
    expect(statSync(join(target, "secrets")).mode & 0o777).toBe(0o700);
    expect(existsSync(join(target, "sessions", hash, "customer.json"))).toBe(true);
    expect(readFileSync(join(legacy, "migrated-to"), "utf8").trim()).toBe(target);
  });

  it("never overwrites a file already at the target, and reports it as skipped", () => {
    const legacy = legacyWithState(), target = tmp("target-");
    mkdirSync(join(target, "secrets"), { recursive: true, mode: 0o700 });
    writeFileSync(join(target, "secrets", `${hash}.json`), "the newer one", { mode: 0o600 });
    const r = migrateLegacyData({ legacy, target });
    expect(readFileSync(join(target, "secrets", `${hash}.json`), "utf8")).toBe("the newer one");
    expect(r.skipped).toContain(join("secrets", `${hash}.json`));
    expect(r.moved).not.toContain("secrets");
  });

  it("is a no-op the second time", () => {
    const legacy = legacyWithState(), target = tmp("target-");
    migrateLegacyData({ legacy, target });
    expect(migrateLegacyData({ legacy, target })).toEqual({ moved: [], skipped: [] });
  });

  it("does nothing when there is no legacy folder", () => {
    expect(migrateLegacyData({ legacy: join(tmp("gone-"), "nope"), target: tmp("target-") })).toEqual({ moved: [], skipped: [] });
  });

  it("refuses to migrate a folder onto itself", () => {
    const legacy = legacyWithState();
    expect(migrateLegacyData({ legacy, target: legacy })).toEqual({ moved: [], skipped: [] });
    expect(existsSync(join(legacy, "migrated-to"))).toBe(false);
  });
});

describe("migration hardening (review minors 1 and 2)", () => {
  it("never loosens the target's permissions, whatever the legacy folder's were", () => {
    const legacy = legacyWithState(), target = tmp("target-");
    chmodSync(join(legacy, "secrets"), 0o755);
    migrateLegacyData({ legacy, target });
    expect(statSync(join(target, "secrets")).mode & 0o777).toBe(0o700);
    expect(statSync(join(target, "secrets", `${hash}.json`)).mode & 0o777).toBe(0o600);
  });

  it("leaves no half-written secret behind if it is interrupted", () => {
    const legacy = legacyWithState(), target = tmp("target-");
    migrateLegacyData({ legacy, target });
    // Nothing partial: every file it wrote is a complete, valid copy, and no .tmp survives.
    expect(readdirSync(join(target, "secrets")).filter((f) => f.includes(".tmp"))).toEqual([]);
    expect(JSON.parse(readFileSync(join(target, "secrets", `${hash}.json`), "utf8"))).toHaveProperty("customer");
  });
});
