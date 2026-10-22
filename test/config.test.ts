import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, ensureGitignored, newRunner, checkTarget, describePermissions } from "../src/config/store";
import { secretsPath, setSecret, getSecret } from "../src/config/secrets";
import { defaultPatterns } from "../src/config/schema";

const tmp = (p = "cfg-") => mkdtempSync(join(tmpdir(), p));

describe("config", () => {
  it("a fresh project gets br2049 and no runners", () => {
    const cfg = loadConfig(tmp());
    expect(cfg.theme).toBe("br2049");
    expect(cfg.runners).toEqual([]);
  });

  it("a new runner defaults to look only with nothing allowed", () => {
    const r = newRunner("customer", "customer", { kind: "form", loginUrl: "/login" });
    expect(r.depth).toBe("look");
    expect(r.allow).toEqual([]);
  });

  it("saves and loads round trip", () => {
    const d = tmp();
    const cfg = loadConfig(d);
    cfg.runners.push(newRunner("admin", "admin", { kind: "session" }));
    cfg.lastUrl = "http://localhost:3000";
    saveConfig(d, cfg);
    const back = loadConfig(d);
    expect(back.runners[0].key).toBe("admin");
    expect(back.lastUrl).toBe("http://localhost:3000");
  });

  it("refuses a production URL unless live is asked for", () => {
    const cfg = { ...loadConfig(tmp()), productionUrls: ["https://shop.acme.dev"] };
    expect(checkTarget("https://shop.acme.dev/x", cfg, false)).toEqual({ ok: false, reason: "production" });
    expect(checkTarget("https://shop.acme.dev/x", cfg, true)).toEqual({ ok: true });
    expect(checkTarget("https://staging.acme.dev/x", cfg, false)).toEqual({ ok: true });
    expect(checkTarget("https://shop.acme.dev.evil.test/x", cfg, false)).toEqual({ ok: true });
  });

  it("ensureGitignored adds .baseline/ once", () => {
    const d = tmp();
    writeFileSync(join(d, ".gitignore"), "node_modules/\n");
    ensureGitignored(d);
    ensureGitignored(d);
    const text = readFileSync(join(d, ".gitignore"), "utf8");
    expect(text.match(/^\.baseline\/$/gm)?.length).toBe(1);
    expect(text).toContain("node_modules/");
  });

  it("describes a default runner's protected areas as cannot", () => {
    const r = newRunner("customer", "customer", { kind: "form", loginUrl: "/login" });
    const p = describePermissions(r, defaultPatterns());
    expect(p.can.join(" ")).toMatch(/browse/i);
    expect(p.cannot.join(" ")).toMatch(/send email/i);
    expect(p.cannot.join(" ")).toMatch(/payments/i);
    expect(p.cannot.join(" ")).toMatch(/submit/i);
  });
});

describe("secrets", () => {
  it("are stored outside the project with mode 0600 and round trip", () => {
    const data = tmp("data-");
    const proj = tmp("proj-");
    setSecret(data, proj, "customer", { username: "c@acme.test", password: "pw#1" });
    const p = secretsPath(data, proj);
    expect(p.startsWith(proj)).toBe(false);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(getSecret(data, proj, "customer")).toEqual({ username: "c@acme.test", password: "pw#1" });
    expect(getSecret(data, proj, "nobody")).toBeUndefined();
  });
});
