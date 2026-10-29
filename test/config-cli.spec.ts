import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli";
import "../src/commands";
import { loadConfig } from "../src/config/store";
import { getSecret, setSecret } from "../src/config/secrets";

let out = "";
let cwd: string;
beforeEach(() => {
  out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s: any) => { out += String(s); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((s: any) => { out += String(s); return true; });
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "cli-")));
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  process.env.BASELINE_DATA = realpathSync(mkdtempSync(join(tmpdir(), "data-")));
});
afterEach(() => vi.restoreAllMocks());

describe("config cli", () => {
  it("adds a runner, allows a category and describes it", async () => {
    expect(await main(["config", "add-runner", "customer", "customer", "form", "/login"])).toBe(0);
    expect(await main(["config", "allow", "customer", "email"])).toBe(0);
    expect(loadConfig(cwd).runners[0]?.allow).toEqual(["email"]);
    out = "";
    expect(await main(["config", "describe"])).toBe(0);
    expect(out).toMatch(/customer/);
    expect(out).toMatch(/can: .*send email/is);
  });

  it("remembers a runner's standing instructions, shows them, and clears them", async () => {
    await main(["config", "add-runner", "customer", "customer", "session"]);
    expect(await main(["config", "note", "customer", "may submit the order, never pay"])).toBe(0);
    await main(["config", "note", "customer", "may submit the order, never pay"]);
    await main(["config", "note", "customer", "only in the test workspace"]);
    expect(loadConfig(cwd).runners[0]?.notes).toEqual(["may submit the order, never pay", "only in the test workspace"]);
    out = "";
    await main(["config", "describe"]);
    expect(out).toMatch(/never a permission\): "may submit the order, never pay"; "only in the test workspace"/);
    expect(out).not.toMatch(/can: [^\n]*never pay/);
    expect(await main(["config", "note", "customer", "--clear", "1"])).toBe(0);
    expect(loadConfig(cwd).runners[0]?.notes).toEqual(["only in the test workspace"]);
    expect(await main(["config", "note", "customer", "--clear", "9"])).toBe(2);
    await main(["config", "note", "customer", "--clear"]);
    expect(loadConfig(cwd).runners[0]?.notes).toEqual([]);
  });

  it("rejects an unknown category", async () => {
    await main(["config", "add-runner", "customer", "customer", "session"]);
    expect(await main(["config", "allow", "customer", "nukes"])).toBe(2);
  });

  it("target-check exits 3 on production without --live", async () => {
    await main(["config", "set", "productionUrls", '["https://shop.acme.dev"]']);
    expect(await main(["target-check", "https://shop.acme.dev"])).toBe(3);
    expect(await main(["target-check", "https://shop.acme.dev", "--live"])).toBe(0);
  });

  it("config show never prints secrets", async () => {
    await main(["config", "add-runner", "customer", "customer", "form", "/login"]);
    const { setSecret } = await import("../src/config/secrets");
    setSecret(process.env.BASELINE_DATA!, cwd, "customer", { username: "c@acme.test", password: "hunter2" });
    out = "";
    await main(["config", "show"]);
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("c@acme.test");
  });
});

describe("config secret stdin errors", () => {
  it("bad JSON on stdin never echoes the input", async () => {
    const { io } = await import("../src/cli");
    await main(["config", "add-runner", "customer", "customer", "session"]);
    vi.spyOn(io, "readStdin").mockReturnValue('{"username":"a","password":hunter2}');
    out = "";
    const code = await main(["config", "secret", "customer", "--url", "https://staging.acme.dev"]);
    expect(code).toBe(2);
    expect(out).toMatch(/stdin must be JSON/);
    expect(out).not.toContain("hunter2");
  });
  it("saves the site the details are for, from --url or the configured site, and refuses without one", async () => {
    const { io } = await import("../src/cli");
    const { getSecret } = await import("../src/config/secrets");
    await main(["config", "add-runner", "customer", "customer", "session"]);
    vi.spyOn(io, "readStdin").mockReturnValue('{"username":"a","password":"b"}');
    expect(await main(["config", "secret", "customer"])).toBe(2);
    expect(out).toMatch(/which site/);
    expect(await main(["config", "secret", "customer", "--url", "https://staging.acme.dev/login"])).toBe(0);
    expect(getSecret(process.env.BASELINE_DATA!, cwd, "customer")).toEqual({ username: "a", password: "b", origin: "https://staging.acme.dev" });
    await main(["config", "set", "lastUrl", "https://qa.acme.dev"]);
    expect(await main(["config", "secret", "customer"])).toBe(0);
    expect(getSecret(process.env.BASELINE_DATA!, cwd, "customer")?.origin).toBe("https://qa.acme.dev");
  });
});

describe("config set", () => {
  it("merges list fields instead of replacing them, unless --replace", async () => {
    await main(["config", "set", "productionUrls", '["https://shop.acme.dev"]']);
    await main(["config", "set", "productionUrls", '["https://admin.acme.dev"]']);
    await main(["config", "set", "patterns", '{"email":{"words":["ping customer"]}}']);
    await main(["config", "set", "patterns", '{"finance":{"words":["top up"]}}']);
    await main(["config", "set", "readPosts", '["/api/search"]']);
    await main(["config", "set", "readPosts", '["/api/lookup"]']);
    const c = loadConfig(cwd);
    expect(c.productionUrls.sort()).toEqual(["https://admin.acme.dev", "https://shop.acme.dev"]);
    expect(c.patterns.email.words).toContain("ping customer");
    expect(c.patterns.finance.words).toContain("top up");
    expect(c.readPosts.sort()).toEqual(["/api/lookup", "/api/search"]);
    await main(["config", "set", "readPosts", '["/api/only"]', "--replace"]);
    expect(loadConfig(cwd).readPosts).toEqual(["/api/only"]);
  });
});

describe("config set-authed-check", () => {
  const addRunner = () => main(["config", "add-runner", "customer", "customer", "form", "/login"]);

  it("saves a page and a word only a signed-in user sees", async () => {
    await addRunner();
    expect(await main(["config", "set-authed-check", "customer", "/account", "--text", "Sign out"])).toBe(0);
    expect(loadConfig(cwd).runners[0]?.authedCheck).toEqual({ path: "/account", expect: { text: "Sign out" } });
  });

  it("saves a role and name instead of text", async () => {
    await addRunner();
    expect(await main(["config", "set-authed-check", "customer", "/dashboard", "--role", "button", "--name", "Log out"])).toBe(0);
    expect(loadConfig(cwd).runners[0]?.authedCheck).toEqual({ path: "/dashboard", expect: { role: "button", name: "Log out" } });
  });

  it("--clear removes it", async () => {
    await addRunner();
    await main(["config", "set-authed-check", "customer", "/account", "--text", "Sign out"]);
    expect(await main(["config", "set-authed-check", "customer", "--clear"])).toBe(0);
    expect(loadConfig(cwd).runners[0]?.authedCheck).toBeUndefined();
  });

  it("refuses a check with nothing to look for, and an unknown runner", async () => {
    await addRunner();
    expect(await main(["config", "set-authed-check", "customer", "/account"])).toBe(2);
    expect(await main(["config", "set-authed-check", "nobody", "/account", "--text", "x"])).toBe(2);
  });
});

describe("config auth", () => {
  const fullRunner = async () => {
    await main(["config", "add-runner", "customer", "customer", "form", "/login"]);
    await main(["config", "depth", "customer", "create"]);
    await main(["config", "allow", "customer", "email"]);
    await main(["config", "note", "customer", "only touch the staging workspace"]);
    await main(["config", "set-authed-check", "customer", "/account", "--text", "Sign out"]);
  };

  it("switching to manual sign-in keeps depth, allowed areas, notes and the signed-in check", async () => {
    await fullRunner();
    setSecret(process.env.BASELINE_DATA!, cwd, "customer", { username: "u", password: "p", origin: "https://staging.acme.dev" });
    expect(await main(["config", "auth", "customer", "session"])).toBe(0);
    const r = loadConfig(cwd).runners[0]!;
    expect(r).toMatchObject({ depth: "create", allow: ["email"], auth: { kind: "session" } });
    expect(r.notes).toEqual(["only touch the staging workspace"]);
    expect(r.authedCheck).toEqual({ path: "/account", expect: { text: "Sign out" } });
    // Leaving the password form drops the stored password with it.
    expect(getSecret(process.env.BASELINE_DATA!, cwd, "customer")).toBeUndefined();
  });

  it("switching to a password form keeps everything else and takes the login path", async () => {
    await main(["config", "add-runner", "admin", "admin", "session"]);
    await main(["config", "depth", "admin", "workflow"]);
    expect(await main(["config", "auth", "admin", "form", "/sign-in"])).toBe(0);
    expect(loadConfig(cwd).runners[0]).toMatchObject({ depth: "workflow", auth: { kind: "form", loginUrl: "/sign-in" } });
  });

  it("refuses an unknown runner, a missing kind and a form with no login path", async () => {
    await fullRunner();
    expect(await main(["config", "auth", "nobody", "session"])).toBe(2);
    expect(await main(["config", "auth", "customer"])).toBe(2);
    expect(await main(["config", "auth", "customer", "form"])).toBe(2);
    expect(await main(["config", "auth", "customer", "magic-link"])).toBe(2);
  });
});

describe("config describe says whether a sign-in can be proved", () => {
  it("names the signed-in check when there is one", async () => {
    await main(["config", "add-runner", "customer", "customer", "form", "/login"]);
    await main(["config", "set-authed-check", "customer", "/account", "--text", "Sign out"]);
    out = "";
    await main(["config", "describe"]);
    expect(out).toMatch(/signed in when \/account shows "Sign out"/);
  });

  it("says plainly when a sign-in cannot be proved", async () => {
    await main(["config", "add-runner", "admin", "admin", "session"]);
    out = "";
    await main(["config", "describe"]);
    expect(out).toMatch(/can't prove|cannot prove/i);
  });
});

describe("set-authed-check validates what it is told to look for (review minor 5)", () => {
  it("refuses a role Playwright does not have, so a typo can't fake proof of being signed out", async () => {
    await main(["config", "add-runner", "customer", "customer", "form", "/login"]);
    expect(await main(["config", "set-authed-check", "customer", "/account", "--role", "Button"])).toBe(2);
    expect(await main(["config", "set-authed-check", "customer", "/account", "--role", "buttn"])).toBe(2);
    expect(loadConfig(cwd).runners[0]?.authedCheck).toBeUndefined();
    expect(await main(["config", "set-authed-check", "customer", "/account", "--role", "button"])).toBe(0);
  });
});
