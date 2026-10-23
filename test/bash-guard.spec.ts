import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashGuard, activeRunUrl, activeRun, normalizeSegment, mentionsDataDir, readGuard, sweepsHome, writeGuard } from "../src/hooks/bash-guard";
import { spawnSync } from "node:child_process";
import { runKey } from "../src/core/paths";

const url = "https://staging.acme.dev";
describe("bashGuard during an active run", () => {
  const deny = (cmd: string) => expect(bashGuard(cmd, { runUrl: url })).toMatchObject({ deny: expect.any(String) });
  const allow = (cmd: string) => expect(bashGuard(cmd, { runUrl: url })).toEqual({ allow: true });
  it("denies writes to the site under test with curl, wget and friends", () => {
    deny("curl -X POST https://staging.acme.dev/api/cart");
    deny("curl --request DELETE https://staging.acme.dev/api/users/7");
    deny("curl -d 'a=1' https://staging.acme.dev/api/cart");
    deny("curl --json '{}' staging.acme.dev/api");
    deny("wget --method=PUT https://staging.acme.dev/x");
    deny("wget --post-data=a https://staging.acme.dev/x");
    deny("http POST https://staging.acme.dev/api/cart a=1");
  });
  it("allows reads of the site and writes elsewhere", () => {
    allow("curl https://staging.acme.dev/version");
    allow("curl -s -I https://staging.acme.dev/");
    allow("curl -X POST https://api.github.com/graphql");
  });
  it("denies driving Playwright directly", () => {
    deny("npx playwright test");
    deny("node -e \"require('playwright')\"");
    deny("pnpm exec playwright codegen https://staging.acme.dev");
  });
  it("allows baseline itself", () => {
    allow("baseline script customer .baseline/sessions/s/runs/r-1/explore/customer/walk.cjs");
    allow("baseline config describe");
    allow("baseline progress agent customer 'opening /cart'");
  });
});

describe("bashGuard with no active run", () => {
  it("allows everything", () => {
    expect(bashGuard("curl -X POST https://staging.acme.dev/api/cart", {})).toEqual({ allow: true });
  });
});

describe("activeRunUrl", () => {
  it("reads the url of the active run in this project only", () => {
    const p = mkdtempSync(join(tmpdir(), "bg-"));
    expect(activeRunUrl(p)).toBeUndefined();
    const runDir = join(p, ".baseline", "sessions", "s", "runs", "r-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ url, startedAt: new Date().toISOString() }));
    writeFileSync(join(p, ".baseline", "active-run"), runDir);
    expect(activeRunUrl(p)).toBe(url);
  });
});

describe("plugin data pointer", () => {
  it("the SessionStart hook records CLAUDE_PLUGIN_DATA so plain `baseline` calls find it", async () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const { recordPluginData, dataDir } = await import("../src/config/secrets");
    const target = join(home, ".claude", "plugins", "data", "baseline");
    mkdirSync(target, { recursive: true });
    recordPluginData(target, home);
    expect(readFileSync(join(home, ".config", "baseline", "plugin-data"), "utf8").trim()).toBe(target);
    const saved = { ...process.env };
    delete process.env.BASELINE_DATA; delete process.env.CLAUDE_PLUGIN_DATA; process.env.HOME = home;
    try { expect(dataDir()).toBe(target); } finally { process.env = saved; }
  });
});

describe("plugin data pointer: only trusted when it names Claude Code's plugin data folder", () => {
  const withHome = async (home: string, extra: NodeJS.ProcessEnv, fn: (dataDir: () => string) => void) => {
    const { dataDir } = await import("../src/config/secrets");
    const saved = { ...process.env };
    delete process.env.BASELINE_DATA; delete process.env.CLAUDE_PLUGIN_DATA; delete process.env.CLAUDE_CONFIG_DIR;
    Object.assign(process.env, { HOME: home, ...extra });
    try { fn(dataDir); } finally { process.env = saved; }
  };
  it("ignores a pointer to a folder elsewhere under ~/.claude/plugins, or to a missing folder", async () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const { recordPluginData } = await import("../src/config/secrets");
    const elsewhere = join(home, ".claude", "plugins", "cache", "evil");
    mkdirSync(elsewhere, { recursive: true });
    recordPluginData(elsewhere, home);
    await withHome(home, {}, (dataDir) => expect(dataDir()).toBe(join(home, ".config", "baseline")));
    recordPluginData(join(home, ".claude", "plugins", "data", "missing"), home);
    await withHome(home, {}, (dataDir) => expect(dataDir()).toBe(join(home, ".config", "baseline")));
  });
  it("follows CLAUDE_CONFIG_DIR's plugin data folder", async () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const cfgDir = mkdtempSync(join(tmpdir(), "claude-cfg-"));
    const target = join(cfgDir, "plugins", "data", "baseline");
    mkdirSync(target, { recursive: true });
    const { recordPluginData } = await import("../src/config/secrets");
    recordPluginData(target, home);
    await withHome(home, { CLAUDE_CONFIG_DIR: cfgDir }, (dataDir) => expect(dataDir()).toBe(target));
  });
});

describe("task 13 review: guard hardening", () => {
  const ctx = { runUrl: url };
  const deny = (cmd: string) => expect(bashGuard(cmd, ctx), cmd).toMatchObject({ deny: expect.any(String) });
  const allow = (cmd: string) => expect(bashGuard(cmd, ctx), cmd).toEqual({ allow: true });
  it("a baseline prefix does not excuse a chained command", () => {
    deny("baseline config describe && curl -X POST https://staging.acme.dev/api");
    deny("baseline view; curl -d a=1 https://staging.acme.dev/x");
  });
  it("agents cannot change permissions or production protection mid-run", () => {
    for (const c of ["baseline config allow customer finance", "baseline config deny customer email", "baseline config depth customer workflow",
      "baseline config set productionUrls '[]'", "baseline config secret customer", "baseline config add-runner x x session",
      "baseline config remove-runner customer", "baseline signin --all --live", "baseline target-check https://x --live"]) deny(c);
  });
  it("catches paths, quotes, case, short flags and scripting languages", () => {
    deny("/usr/bin/curl -X POST https://staging.acme.dev/api");
    deny("\"curl\" -X POST https://staging.acme.dev/api");
    deny("curl -X POST https://STAGING.acme.dev/api");
    deny("curl -d@body.json https://staging.acme.dev/api");
    deny("curl -sd x=1 https://staging.acme.dev/api");
    deny("python3 -c \"import requests; requests.post('https://staging.acme.dev/api')\"");
    deny("node -e \"fetch('https://staging.acme.dev/api',{method:'DELETE'})\"");
  });
  it("does not block harmless commands", () => {
    allow("curl -f https://staging.acme.dev/health");
    allow("wget -t 3 https://staging.acme.dev/");
    allow("grep -n playwright package.json");
    allow("cat playwright.config.ts");
    allow("baseline config describe");
    allow("baseline script customer walk.cjs");
  });
  it("treats localhost and 127.0.0.1 as the same site", () => {
    expect(bashGuard("curl -X POST http://localhost:4517/api", { runUrl: "http://127.0.0.1:4517" })).toMatchObject({ deny: expect.any(String) });
  });
  it("blocks browser MCP tools while a run is active", async () => {
    const { toolGuard } = await import("../src/hooks/bash-guard");
    expect(toolGuard("mcp__playwright__browser_click", ctx)).toMatchObject({ deny: expect.any(String) });
    expect(toolGuard("mcp__claude-in-chrome__computer", ctx)).toMatchObject({ deny: expect.any(String) });
    expect(toolGuard("WebFetch", ctx)).toEqual({ allow: true });
    expect(toolGuard("mcp__playwright__browser_click", {})).toEqual({ allow: true });
  });
});

describe("active run detection", () => {
  it("ignores a pointer that escapes the sessions folder", () => {
    const p = mkdtempSync(join(tmpdir(), "bg-"));
    const evil = join(p, ".baseline", "sessions", "..", "..", "evil");
    mkdirSync(evil, { recursive: true });
    mkdirSync(join(p, ".baseline", "sessions"), { recursive: true });
    writeFileSync(join(evil, "run.json"), JSON.stringify({ url, startedAt: new Date().toISOString() }));
    writeFileSync(join(p, ".baseline", "active-run"), evil);
    expect(activeRunUrl(p)).toBeUndefined();
  });
  it("ignores a stale run older than a day", () => {
    const p = mkdtempSync(join(tmpdir(), "bg-"));
    const runDir = join(p, ".baseline", "sessions", "s", "runs", "r-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ url, startedAt: new Date(Date.now() - 25 * 3600e3).toISOString() }));
    writeFileSync(join(p, ".baseline", "active-run"), runDir);
    expect(activeRunUrl(p)).toBeUndefined();
  });
});

describe("data dir safety", () => {
  it("never uses a data dir inside the project", async () => {
    const { dataDir } = await import("../src/config/secrets");
    const proj = mkdtempSync(join(tmpdir(), "proj-"));
    const saved = { ...process.env };
    process.env.BASELINE_DATA = join(proj, "steal");
    try { expect(() => dataDir(proj)).toThrow(/inside the project/); } finally { process.env = saved; }
  });
  it("ignores a pointer outside ~/.claude/plugins", async () => {
    const { recordPluginData, dataDir } = await import("../src/config/secrets");
    const home = mkdtempSync(join(tmpdir(), "home-"));
    recordPluginData("/tmp/somewhere-else", home);
    const saved = { ...process.env };
    delete process.env.BASELINE_DATA; delete process.env.CLAUDE_PLUGIN_DATA; process.env.HOME = home;
    try { expect(dataDir()).toBe(join(home, ".config", "baseline")); } finally { process.env = saved; }
  });
});

describe("bash guard: however baseline is spelled", () => {
  const ctx = { runUrl: url };
  const deny = (cmd: string) => expect(bashGuard(cmd, ctx), cmd).toMatchObject({ deny: expect.any(String) });
  const allow = (cmd: string) => expect(bashGuard(cmd, ctx), cmd).toEqual({ allow: true });
  it.each([
    ["env assignment", "X=1 baseline config allow customer delete"],
    ["several assignments", "A=1 B=2 baseline config depth customer workflow"],
    ["env", "env baseline config allow customer delete"],
    ["env -i with vars", "env -i FOO=bar baseline config allow customer delete"],
    ["env -u", "env -u HOME baseline config allow customer delete"],
    ["command", "command baseline config allow customer delete"],
    ["exec", "exec baseline config allow customer delete"],
    ["nohup", "nohup baseline config allow customer delete"],
    ["time", "time baseline config allow customer delete"],
    ["relative path", "./bin/baseline config allow customer delete"],
    ["plugin root", '"$CLAUDE_PLUGIN_ROOT"/bin/baseline config allow customer delete'],
    ["plugin root braces", "${CLAUDE_PLUGIN_ROOT}/bin/baseline config allow customer delete"],
    ["the bundle itself", "node /x/dist/cli.cjs config allow customer delete"],
    ["quoted name", "'baseline' config allow customer delete"],
    ["split quotes", 'base""line config allow customer delete'],
    ["backslash", "\\baseline config allow customer delete"],
    ["subshell", "(baseline config allow customer delete)"],
    ["command substitution", "echo $(baseline config allow customer delete)"],
    ["backticks", "echo `baseline config allow customer delete`"],
    ["after ;", "ls; baseline config allow customer delete"],
    ["after &&", "ls && baseline config allow customer delete"],
    ["after |", "echo y | baseline config allow customer delete"],
    ["after &", "sleep 1 & baseline config allow customer delete"],
    ["after newline", "ls\nbaseline config allow customer delete"],
    ["sh -c", "sh -c 'baseline config allow customer delete'"],
    ["bash -c chained", 'bash -c "ls; baseline config allow customer delete"'],
    ["bash -lc", "bash -lc 'baseline config allow customer delete'"],
    ["eval", "eval 'baseline config allow customer delete'"],
    ["heredoc", "bash <<EOF\nbaseline config allow customer delete\nEOF"],
    ["a variable for the program", 'B=baseline; $B config allow customer delete'],
    ["a live run", "env baseline run new --url https://x --live"],
  ])("denies a permission change via %s", (_, cmd) => deny(cmd));
  it("denies overriding baseline's run, data folder or shared browser mid-run", () => {
    deny("BASELINE_SHARED_BROWSER=0 baseline script customer walk.cjs");
    deny("BASELINE_RUN_DIR=/tmp/other baseline script customer walk.cjs");
    deny("export BASELINE_DATA=/tmp/x; baseline script customer walk.cjs");
    deny("env CLAUDE_PLUGIN_DATA=/tmp/x baseline signin --all");
  });
  it("still allows ordinary baseline use and lookalikes", () => {
    allow("baseline script customer walk.cjs");
    allow("env FOO=1 baseline script customer walk.cjs");
    allow("./bin/baseline config describe");
    allow("git config --get user.name");
    allow("echo baseline is great");
  });
  it("a --live run may sign in and check its own target, however spelled", () => {
    expect(bashGuard("env baseline signin --all --live", { runUrl: url, live: true })).toEqual({ allow: true });
  });
  it("normalizes wrappers away", () => {
    expect(normalizeSegment("X=1 env -i command ./bin/baseline config show")).toBe("baseline config show");
    expect(normalizeSegment("  nohup time -p baseline view")).toBe("baseline view");
  });
});

describe("Baseline's data folder is off limits at all times", () => {
  const home = process.env.HOME || "/home/u";
  const dirs = [join(home, ".config", "baseline"), join(home, ".claude", "plugins", "data", "baseline-x")];
  it("bash: any spelling of the folder, with or without a run", () => {
    for (const c of ["cat ~/.config/baseline/secrets/abc.json", "ls $HOME/.config/baseline", "cat ${HOME}/.config/baseline/trackers.json",
      `cat '${dirs[1]}/sessions/x.json'`, "ls $CLAUDE_PLUGIN_DATA", "cat ${CLAUDE_PLUGIN_DATA}/trackers.json", "cd ~/.config/baseline && cat *"]) {
      expect(bashGuard(c, { protectedDirs: dirs }), c).toMatchObject({ deny: expect.any(String) });
    }
  });
  it("bash: doubled slashes, ./ segments, globs and variables near .config or .claude are refused", () => {
    for (const c of ["cat ~//.config/./baseline/secrets/a.json", "cat ~/.config/basel?ne/trackers.json", "cat ~/.config/{baseline,x}/trackers.json",
      "D=baseline; cat ~/.config/$D/trackers.json", "ls ~/.claude/plugins/data/*",
      "cat ~/x/../.config/baseline/trackers.json", "cat $HOME/a/b/../../.config/baseline/secrets/s.json", "ls ~/*", "cat ~/.c*/basel*/t.json"]) {
      expect(mentionsDataDir(c, dirs), c).toBe(true);
    }
  });
  it("bash: lookalike folders and ordinary globs are fine", () => {
    for (const c of ["ls ~/.config/baseline-private", "cat ~/.config/baselinex/a", "baseline config show", "ls ~/code/*.ts", "cat src/**/*.ts", "rm -rf /tmp/x/*"]) expect(mentionsDataDir(c, dirs), c).toBe(false);
  });
  it("read, grep and glob can't look inside", () => {
    const ctx = { cwd: "/tmp", protectedDirs: dirs };
    expect(readGuard([join(dirs[0]!, "secrets", "a.json")], ctx)).toMatchObject({ deny: expect.any(String) });
    expect(readGuard(["~/.config/baseline/trackers.json"], ctx)).toMatchObject({ deny: expect.any(String) });
    expect(readGuard([`${dirs[1]}/**/*.json`], ctx)).toMatchObject({ deny: expect.any(String) });
    expect(readGuard(["/tmp/project/README.md"], ctx)).toEqual({ allow: true });
  });
  it("read: a symlink that points into the data folder is followed and refused", () => {
    const data = mkdtempSync(join(tmpdir(), "rg-data-"));
    const proj = mkdtempSync(join(tmpdir(), "rg-proj-"));
    writeFileSync(join(data, "trackers.json"), "{}");
    symlinkSync(data, join(proj, "link"));
    const ctx = { cwd: proj, protectedDirs: [data] };
    expect(readGuard([join(proj, "link", "trackers.json")], ctx)).toMatchObject({ deny: expect.any(String) });
    expect(readGuard(["link/trackers.json"], ctx)).toMatchObject({ deny: expect.any(String) });
    expect(readGuard([join(proj, "link", "not-yet", "x.json")], ctx)).toMatchObject({ deny: expect.any(String) });
  });
  it("write and edit can't change it, and can't touch .baseline config mid-run", () => {
    const proj = "/tmp/proj";
    const ctx = { cwd: proj, projectDir: proj, protectedDirs: dirs };
    expect(writeGuard(join(dirs[0]!, "secrets", "a.json"), ctx)).toMatchObject({ deny: expect.any(String) });
    expect(writeGuard(".baseline/config.json", ctx)).toEqual({ allow: true });
    const mid = { ...ctx, runUrl: url };
    expect(writeGuard(".baseline/config.json", mid)).toMatchObject({ deny: expect.any(String) });
    expect(writeGuard("/tmp/proj/.baseline/active-run", mid)).toMatchObject({ deny: expect.any(String) });
    expect(writeGuard(".baseline/sessions/s/runs/r-1/findings.json", mid)).toEqual({ allow: true });
    expect(writeGuard("src/app.ts", mid)).toEqual({ allow: true });
  });
  it("write and edit can't touch Claude Code's plugin data folder or the data-folder pointer", () => {
    const home = process.env.HOME as string;
    const ctx = { cwd: "/tmp", projectDir: "/tmp/proj", protectedDirs: [join(home, ".config", "baseline")] };
    expect(writeGuard(join(home, ".claude", "plugins", "data", "anything", "x.json"), ctx)).toMatchObject({ deny: expect.any(String) });
    expect(writeGuard(join(home, ".config", "baseline", "plugin-data"), ctx)).toMatchObject({ deny: expect.any(String) });
  });
});

describe("active run from trusted state", () => {
  const withData = (fn: (data: string) => void) => {
    const data = mkdtempSync(join(tmpdir(), "data-"));
    const saved = process.env.BASELINE_DATA;
    process.env.BASELINE_DATA = data;
    try { fn(data); } finally { if (saved === undefined) delete process.env.BASELINE_DATA; else process.env.BASELINE_DATA = saved; }
  };
  const trusted = (data: string, proj: string, runDir: string, extra: Record<string, unknown> = {}) => {
    const d = join(data, "runs", runKey(runDir));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "run.json"), JSON.stringify({ runDir, projectDir: proj, url, live: false, startedAt: new Date().toISOString(), ...extra }));
    return d;
  };
  it("deleting the project pointer or editing run.json doesn't switch the guard off", () => withData((data) => {
    const p = mkdtempSync(join(tmpdir(), "bg-"));
    const runDir = join(p, ".baseline", "sessions", "s", "runs", "r-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ url: "https://other.example", startedAt: "1970-01-01T00:00:00Z" }));
    trusted(data, p, runDir);
    expect(activeRun(p)?.url).toBe(url);
    writeFileSync(join(p, ".baseline", "active-run"), runDir);
    expect(activeRun(p)?.url).toBe(url);
  }));
  it("a finished or stale run is not active; another project's run doesn't count", () => withData((data) => {
    const p = mkdtempSync(join(tmpdir(), "bg-")), other = mkdtempSync(join(tmpdir(), "bg-"));
    const d = trusted(data, p, join(p, "r-1"));
    trusted(data, other, join(other, "r-2"));
    expect(activeRun(p)?.runDir).toBe(join(p, "r-1"));
    writeFileSync(join(d, "finished"), "");
    expect(activeRun(p)).toBeUndefined();
    trusted(data, p, join(p, "r-3"), { startedAt: new Date(Date.now() - 25 * 3600e3).toISOString() });
    expect(activeRun(p)).toBeUndefined();
  }));
});

describe("dist/hook.cjs", () => {
  const ROOT = join(__dirname, "..");
  const hook = (name: string, input: unknown, env: Record<string, string> = {}) =>
    spawnSync("node", [join(ROOT, "dist", "hook.cjs"), name], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, ...env } });
  it("blocks reading the data folder and allows ordinary commands", () => {
    const data = mkdtempSync(join(tmpdir(), "data-"));
    const r = hook("bash-guard", { tool_input: { command: `cat ${data}/secrets/x.json` }, cwd: tmpdir() }, { BASELINE_DATA: data });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/data folder/);
    expect(hook("bash-guard", { tool_input: { command: "ls" }, cwd: tmpdir() }, { BASELINE_DATA: data }).status).toBe(0);
    expect(hook("read-guard", { tool_input: { file_path: join(data, "trackers.json") } }, { BASELINE_DATA: data }).status).toBe(2);
  });
  it("lets malformed input through and never blocks on an unknown hook", () => {
    expect(spawnSync("node", [join(ROOT, "dist", "hook.cjs"), "bash-guard"], { input: "not json", encoding: "utf8" }).status).toBe(0);
    expect(hook("nope", {}).status).toBe(1);
  });
});

describe("live runs", () => {
  it("a live run lets its own signin --live through the Bash guard, a normal run does not", () => {
    expect(bashGuard("baseline signin --all --url https://shop.acme.dev --live", { runUrl: "https://shop.acme.dev", live: true })).toEqual({ allow: true });
    expect(bashGuard("baseline signin --all --url https://shop.acme.dev --live", { runUrl: "https://staging.acme.dev" })).toMatchObject({ deny: expect.any(String) });
    expect(bashGuard("baseline config allow customer finance", { runUrl: "https://shop.acme.dev", live: true })).toMatchObject({ deny: expect.any(String) });
  });
  it("activeRun reports the live flag from a pre-trusted-state run.json", () => {
    const p = mkdtempSync(join(tmpdir(), "bg-live-"));
    const runDir = join(p, ".baseline", "sessions", "s", "runs", "r-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ url: "https://shop.acme.dev", live: true, startedAt: new Date().toISOString() }));
    writeFileSync(join(p, ".baseline", "active-run"), runDir);
    expect(activeRun(p)).toMatchObject({ url: "https://shop.acme.dev", live: true });
  });
});

describe("bash guard: sweeps of the home folder (defence in depth for the data folder)", () => {
  it("refuses recursive searches, archives and copies rooted at home or its config folders", () => {
    for (const c of ["find ~ -name '*.json' -exec cat {} +", "cat ~/.config/basel*/secrets*", "cd ~/.config && cat baseline/x", "grep -r token ~", "rg password $HOME",
      "tar czf x.tgz ~/.config", "cp -r ~/.claude /tmp/x", "ls -R ~/.claude", "ls ~/.config/*"]) expect(sweepsHome(c), c).toBe(true);
  });
  it("leaves ordinary work alone", () => {
    for (const c of ["cd ~", "cd ~/projects/foo && ls", "grep -r token ./src", "ls -la ~", "find . -name x", "du -sh ~/Downloads", "pnpm test", "git status"]) expect(sweepsHome(c), c).toBe(false);
  });
  it("is part of the always-on data folder check", () => {
    expect(bashGuard("find ~ -name secrets", { protectedDirs: ["/nowhere"] })).toMatchObject({ deny: expect.any(String) });
  });
});

describe("bash guard: config changes however baseline is named", () => {
  it("refuses config set and --live through a variable or alias mid-run", () => {
    for (const c of ["b=baseline; $b config set productionUrls '[]'", "$B run new --url https://x --label y --live"]) {
      expect(bashGuard(c, { runUrl: url }), c).toMatchObject({ deny: expect.any(String) });
    }
  });
});

describe("active run: several runs at once", () => {
  it("lists every unfinished run and guards all of their sites", () => {
    const proj = mkdtempSync(join(tmpdir(), "multi-"));
    const data = mkdtempSync(join(tmpdir(), "multi-data-"));
    const saved = process.env.BASELINE_DATA;
    process.env.BASELINE_DATA = data;
    try {
      const mk = (id: string, u: string, startedAt: string, live = false) => {
        const runDir = join(proj, ".baseline", "sessions", "s", "runs", id);
        mkdirSync(runDir, { recursive: true });
        const t = join(data, "runs", runKey(runDir));
        mkdirSync(t, { recursive: true });
        writeFileSync(join(t, "run.json"), JSON.stringify({ runDir, projectDir: proj, url: u, live, startedAt }));
        return runDir;
      };
      const older = mk("r-1", "https://older.acme.dev", new Date(Date.now() - 60_000).toISOString(), true);
      mk("r-2", "https://newer.acme.dev", new Date().toISOString(), true);
      const run = activeRun(proj);
      expect(run?.urls?.sort()).toEqual(["https://newer.acme.dev", "https://older.acme.dev"]);
      expect(run?.live).toBe(true);
      // A newer run doesn't hide the older one's site from the guard.
      expect(bashGuard("curl -X POST https://older.acme.dev/api/x", { runUrl: run?.url, runUrls: run?.urls })).toMatchObject({ deny: expect.any(String) });
      // live only when every run is live.
      mk("r-3", "https://third.acme.dev", new Date().toISOString(), false);
      expect(activeRun(proj)?.live).toBe(false);
      expect(activeRun(proj)?.runDirs).toContain(older);
    } finally { process.env.BASELINE_DATA = saved; }
  });
});

