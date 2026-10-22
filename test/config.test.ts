import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, ensureGitignored, newRunner, checkTarget, describePermissions } from "../src/config/store";
import { secretsPath, setSecret, getSecret } from "../src/config/secrets";
import { defaultPatterns, projectConfigSchema } from "../src/config/schema";

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

describe("safety review fixes (task 2)", () => {
  const prod = (urls: string[]) => ({ ...loadConfig(tmp()), productionUrls: urls });

  it("matches production on hostname, ignoring protocol, port and trailing dot", () => {
    const cfg = prod(["https://shop.acme.dev"]);
    for (const u of ["http://shop.acme.dev", "https://shop.acme.dev:8443/x", "https://shop.acme.dev./", "HTTPS://SHOP.ACME.DEV"]) {
      expect(checkTarget(u, cfg, false)).toEqual({ ok: false, reason: "production" });
    }
  });

  it("accepts bare hosts in productionUrls by adding https", () => {
    const cfg = projectConfigSchema.parse({ productionUrls: ["shop.acme.dev"] });
    expect(cfg.productionUrls).toEqual(["https://shop.acme.dev"]);
    expect(checkTarget("https://shop.acme.dev", cfg, false).ok).toBe(false);
  });

  it("rejects a productionUrls entry that is not a URL", () => {
    expect(() => projectConfigSchema.parse({ productionUrls: ["not a url at all"] })).toThrow();
  });

  it("refuses a target that does not parse", () => {
    expect(checkTarget("shop.acme.dev", prod([]), false)).toEqual({ ok: false, reason: "invalid" });
  });

  it("editing one pattern category keeps the defaults of the others", () => {
    const cfg = projectConfigSchema.parse({ patterns: { email: { words: ["x"] } } });
    expect(cfg.patterns.email.words).toContain("x");
    expect(cfg.patterns.email.words).toContain("send invoice");
    expect(cfg.patterns.finance.words).toContain("pay");
    expect(cfg.patterns.delete.words).toContain("delete user");
  });

  it("saveConfig gitignores .baseline/", () => {
    const d = tmp();
    saveConfig(d, loadConfig(d));
    expect(readFileSync(join(d, ".gitignore"), "utf8")).toContain(".baseline/");
  });

  it("secrets file is rewritten 0600 even if it existed with looser permissions", async () => {
    const { chmodSync } = await import("node:fs");
    const data = tmp("data-"), proj = tmp("proj-");
    setSecret(data, proj, "a", { username: "u", password: "p" });
    chmodSync(secretsPath(data, proj), 0o644);
    setSecret(data, proj, "b", { username: "u2", password: "p2" });
    expect(statSync(secretsPath(data, proj)).mode & 0o777).toBe(0o600);
    expect(getSecret(data, proj, "a")).toEqual({ username: "u", password: "p" });
  });

  it("removeSecret deletes a runner's credentials", async () => {
    const { removeSecret } = await import("../src/config/secrets");
    const data = tmp("data-"), proj = tmp("proj-");
    setSecret(data, proj, "a", { username: "u", password: "p" });
    removeSecret(data, proj, "a");
    expect(getSecret(data, proj, "a")).toBeUndefined();
  });

  it("an unreadable secrets file errors without echoing its contents", () => {
    const data = tmp("data-"), proj = tmp("proj-");
    setSecret(data, proj, "a", { username: "u", password: "p" });
    writeFileSync(secretsPath(data, proj), '{"a":{"password":hunter2');
    expect(() => getSecret(data, proj, "a")).toThrow(/secrets file is unreadable/);
    try { getSecret(data, proj, "a"); } catch (e) { expect(String(e)).not.toContain("hunter2"); }
  });
});
