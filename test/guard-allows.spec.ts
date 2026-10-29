// The positive corpus: commands the guard must never refuse. Its counterpart is the adversarial
// corpus in test/bash-guard.spec.ts, and both have to pass. A guard that refuses a developer's
// `ls ~/.config/nvim/*.lua` or a quoted regex teaches people to work around it.
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { bashGuard, explainBash, pathWords, setsBaselineEnv } from "../src/hooks/bash-guard";

const home = process.env.HOME || "/home/u";
const dirs = [join(home, ".config", "baseline"), join(home, ".claude", "plugins", "data", "baseline")];
const url = "https://staging.acme.dev";
/** The hardest case: a run is active and the data folders are off limits. */
const ctx = { protectedDirs: dirs, runUrl: url, live: false };

const ALLOWED = [
  // Spec 3.4's table: every one of these was refused.
  "ls ~/.config/nvim/*.lua",
  "ls ~/.claude/plugins/cache/*/skills",
  "sed -n '/[a-z]*\\.config/p' notes.txt",
  'grep -rn "BASELINE_DATA=" src/core/paths.ts',
  'echo "$CLAUDE_PLUGIN_DATA"',
  // Spelling alone used to decide, so these near-identical commands were already allowed: they
  // must stay allowed.
  "cat ~/.claude/settings.json",
  `grep -E '^[a-z]*$' ${join(home, ".config", "app", "list.txt")}`,
  "ls ~/.config/nvim",
  // Other people's config and caches, which are not Baseline's data folders.
  "ls $HOME/.config/gh",
  "cat ${HOME}/.config/nvim/init.lua",
  "ls ~/.claude/plugins/cache/baseline/skills/*/SKILL.md",
  "cat ~/.claude/plugins/cache/baseline/skills/run/SKILL.md",
  "rg -l 'TODO' ~/.claude/projects",
  "ls ~/.claude/projects/*/*.jsonl",
  // Working on this plugin's own source: its data folder's name and env vars are in the text.
  "grep -rn 'CLAUDE_PLUGIN_DATA' hooks/hooks.json",
  "grep -rn 'CLAUDE_PLUGIN_DATA' src/core/paths.ts",
  "grep -rn '.config/baseline' src/core/paths.ts",
  "rg 'BASELINE_DATA' src test",
  "rg -n 'BASELINE_RUN_DIR=' src",
  "sed -n '/\\.config\\/baseline/p' docs/permissions.md",
  "awk '/CLAUDE_PLUGIN_DATA/ {print NR}' src/core/paths.ts",
  // Ordinary developer work in a checkout.
  "pnpm vitest run test/guard-allows.spec.ts",
  "git diff -- src/hooks/bash-guard.ts",
  "ls dist/*.cjs",
  "cat test/*.spec.ts",
  "find . -name '*.json' -not -path './node_modules/*'",
  "rg 'baseline script' agents/*.md",
  "echo $CLAUDE_PLUGIN_ROOT",
  "ls ~/code/*.ts",
  "rm -rf /tmp/x/*",
];

/** The same shapes, aimed at a data folder: the narrowing must not let any of these through. */
const REFUSED = [
  "cat ~/.config/nvim/../baseline/trackers.json",
  "ls ~/.claude/plugins/data/*/secrets",
  "ls ~/.claude/plugins/data/baseline/*",
  "grep -r password ~/.config/baseline",
  "grep -rn 'x' ~/.config/baseline/secrets",
  "rg password $CLAUDE_PLUGIN_DATA",
  "sed -n '/x/p' ~/.config/baseline/trackers.json",
  "echo x > ~/.config/baseline/trackers.json",
  "echo ~/.config/baseline/trackers.json | xargs cat",
  "cat $(echo ~/.config/baseline/trackers.json)",
  "ls $CLAUDE_PLUGIN_DATA",
  "cat ${CLAUDE_PLUGIN_DATA}/trackers.json",
  "awk '{print}' ~/.config/baseline/trackers.json",
  "BASELINE_DATA=/tmp/x baseline script customer walk.cjs",
  "export BASELINE_DATA=/tmp/x; baseline run finish",
];

describe("the guard allows commands that cannot reach a protected folder", () => {
  for (const c of ALLOWED) it(`allows ${c}`, () => expect(bashGuard(c, ctx), c).toEqual({ allow: true }));
});

describe("the guard still refuses the same shapes aimed at a data folder", () => {
  for (const c of REFUSED) it(`refuses ${c}`, () => expect(bashGuard(c, ctx), c).toMatchObject({ deny: expect.any(String) }));
});

describe("which words of a command are paths", () => {
  it("leaves out a regex, a search pattern and echoed text, and keeps redirect targets", () => {
    expect(pathWords("sed -n '/[a-z]*\\.config/p' notes.txt")).toEqual(["sed", "-n", "notes.txt"]);
    expect(pathWords("grep -rn '.config/baseline' src/core/paths.ts")).toEqual(["grep", "-rn", "src/core/paths.ts"]);
    expect(pathWords('echo "$CLAUDE_PLUGIN_DATA"')).toEqual(["echo"]);
    expect(pathWords("echo x > ~/.config/baseline/t.json")).toEqual(["echo", "~/.config/baseline/t.json"]);
    // A pattern file is read, so the word after -f stays a path.
    expect(pathWords("grep -f ~/.config/baseline/t.json notes.txt")).toContain("~/.config/baseline/t.json");
    // Piped or substituted, echo's words are a path again: something else consumes them.
    expect(pathWords("echo ~/.config/baseline/t.json | xargs cat")).toContain("~/.config/baseline/t.json");
  });
});

describe("setting baseline's own variables", () => {
  it("is an assignment at the start of a command, not the text anywhere in one", () => {
    for (const c of ["BASELINE_DATA=/tmp/x baseline view", "export BASELINE_DATA=/tmp/x; baseline view",
      "env CLAUDE_PLUGIN_DATA=/tmp/x baseline signin", "A=1 BASELINE_RUN_DIR=/tmp/x baseline view",
      "sudo BASELINE_SHARED_BROWSER=0 baseline script a b", "sh -c 'BASELINE_DATA=/tmp/x baseline view'"]) {
      expect(setsBaselineEnv(c), c).toBe(true);
    }
    for (const c of ['grep -rn "BASELINE_DATA=" src/core/paths.ts', "rg -n 'BASELINE_RUN_DIR=' src",
      "echo BASELINE_DATA=/tmp/x", "baseline script customer walk.cjs"]) {
      expect(setsBaselineEnv(c), c).toBe(false);
    }
  });
});

describe("explainBash", () => {
  it("names the rule that refused a command, and says nothing refused an allowed one", () => {
    expect(explainBash("ls ~/.config/nvim/*.lua", ctx)).toEqual({ decision: "allow" });
    expect(explainBash("cat ~/.config/baseline/trackers.json", ctx)).toMatchObject({ decision: "deny", rule: "data-folder" });
    expect(explainBash("curl -X POST https://staging.acme.dev/api/x", ctx)).toMatchObject({ decision: "deny", rule: "site-write" });
    expect(explainBash("baseline config allow customer finance", ctx)).toMatchObject({ decision: "deny", rule: "config-frozen" });
    expect(explainBash("BASELINE_DATA=/tmp/x baseline script a b", ctx)).toMatchObject({ decision: "deny", rule: "env-override" });
    expect(explainBash("npx playwright test", ctx)).toMatchObject({ decision: "deny", rule: "playwright" });
    expect(explainBash("find ~ -name secrets", ctx)).toMatchObject({ decision: "deny", rule: "home-sweep" });
  });
  it("agrees with bashGuard on both corpora", () => {
    for (const c of ALLOWED) expect(explainBash(c, ctx).decision, c).toBe("allow");
    for (const c of REFUSED) expect(explainBash(c, ctx).decision, c).toBe("deny");
  });
});

// Review findings C1, I2, I3: three ways the narrowing lost ground that 7a070db held.
describe("the narrowing must not drop a path from the command", () => {
  const LEGACY = dirs[0]!, PLUGIN_DATA = dirs[1]!;
  const deny = (cmd: string, extra: object = {}) =>
    expect(bashGuard(cmd, { protectedDirs: dirs, ...extra }), cmd).toMatchObject({ deny: expect.any(String) });
  const allow = (cmd: string, extra: object = {}) =>
    expect(bashGuard(cmd, { protectedDirs: dirs, ...extra }), cmd).toEqual({ allow: true });

  it("an empty search pattern does not shift the data folder out of the command (C1)", () => {
    // Stripping quotes made '' vanish, so the next word landed in the pattern slot and was
    // dropped as a regex. `grep -r '' <data folder>` prints every saved password.
    deny(`grep '' ${LEGACY}/secrets.json`);
    deny(`grep -r '' ${PLUGIN_DATA}`);
    deny(`grep -r '' "$HOME/.config/baseline"`);
    deny(`grep -r '' -- ${LEGACY}`);
    deny(`rg '' ${LEGACY}`);
    deny(`sed '' ${LEGACY}/secrets.json`);
    deny(`awk '' ${LEGACY}/secrets.json`);
    deny(`ag '' ${LEGACY}`);
    deny(`zgrep '' ${LEGACY}/secrets.json`);
    deny(`eval "grep '' ${LEGACY}/secrets.json"`);
    deny(`grep "" ${LEGACY}/secrets.json`);
  });

  it("an empty pattern on an ordinary file is still fine", () => {
    allow("grep '' notes.txt");
    allow("grep -r '' src/");
    allow('sed "" notes.txt');
  });

  it("a glob is never text, even as an argument to echo (I2)", () => {
    // The shell expands the glob before echo runs, so the output is a listing of the data folder.
    deny(`echo ${LEGACY}/*`);
    deny(`printf '%s\\n' ${LEGACY}/*`);
    deny(`echo ${PLUGIN_DATA}/*/session.json`);
    deny("echo ~/.config/baseline/*");
  });

  it("printing a literal path, or a variable, is still fine", () => {
    allow('echo "$CLAUDE_PLUGIN_DATA"');
    allow(`echo ${LEGACY}`);
    allow("echo hello world");
    allow("printf '%s\\n' done");
  });

  it("a wrapper in front of an env override does not excuse it (I3)", () => {
    const run = { runUrl: "https://staging.acme.dev" };
    for (const w of ["timeout 5", "nice", "nice -n 10", "stdbuf -o0", "setsid", "ionice -c3", "strace -f"]) {
      deny(`${w} BASELINE_DATA=/tmp/x baseline script a b`, run);
      deny(`${w} CLAUDE_PLUGIN_DATA=/tmp/x baseline config show`, run);
    }
  });

  it("the same wrappers do not let a subagent start, finish or sign in to a run (I3)", () => {
    const agent = { runUrl: "https://staging.acme.dev", agent: true };
    for (const w of ["timeout 5", "nice", "stdbuf -o0", "setsid"]) {
      deny(`${w} baseline run finish`, agent);
      deny(`${w} baseline signin customer`, agent);
      deny(`${w} baseline run new --url https://x --label y`, agent);
    }
  });

  it("those wrappers in front of an ordinary command are still fine", () => {
    const run = { runUrl: "https://staging.acme.dev" };
    allow("timeout 5 pnpm vitest run", run);
    allow("nice node scripts/build.mjs", run);
    allow("timeout 30 baseline script customer walk.cjs", { ...run, agent: true });
  });
  it("a relative path to the plugin data folder is refused, glob or not (I5)", () => {
    deny("cat ../../.claude/plugins/data/baseline/x/secrets.json");
    deny("cat a/.claude/plugins/data/baseline/secrets.json");
    deny("cat ../.config/baseline/secrets.json");
    deny("cat ../../.claude/plugins/data/*/secrets.json");
  });

  it("a relative path through a hidden folder that goes nowhere near the data folder is fine", () => {
    allow("cat .claude/settings.json");
    allow("ls ../other/.config/app");
    allow("cat .config/nvim/init.lua");
    allow("ls data/*");
    allow("ls plugins/*");
    allow("cat src/core/paths.ts");
  });
  // The property, not a list of spellings. The first fix for this placeholded '' and "" and still
  // lost to `grep -r '"' <data>` — an argument made only of characters the splitter stripped.
  const ARGS = [
    "''", '""', "''''", '""""', `'""'`, `""''`,
    "' '", '"  "', `"'"`, `'"'`, "$' '",
    "'a'", '"a"', "a", "-e", "''a''", "'a b'",
  ];

  it("no argument spelling can shift a data folder out of a command (C-1)", () => {
    for (const dir of dirs) {
      for (const a of ARGS) {
        for (const tool of ["grep -r", "grep", "rg", "ag", "sed", "awk", "egrep", "zgrep", "grep -rl"]) {
          deny(`${tool} ${a} ${dir}`);
        }
      }
    }
  });

  it("the same spellings on an ordinary file are all still allowed", () => {
    for (const a of ARGS) {
      allow(`grep -r ${a} notes.txt`);
      allow(`sed ${a} notes.txt`);
    }
  });

  it("how many words a command has does not depend on its quoting (C-1)", () => {
    // Every one of these is four shell words. The guard drops the pattern slot, so each must
    // leave exactly the same three path words as the unquoted form.
    const base = pathWords("grep -r q x");
    expect(base).toEqual(["grep", "-r", "x"]);
    for (const a of [
      "grep -r '' x", `grep -r '"' x`, "grep -r '''' x", "grep -r ' ' x",
      "grep -r $' ' x", `grep -r "  " x`, `grep -r "'" x`, "grep -r 'a b' x",
    ]) expect(pathWords(a), a).toEqual(base);
    // A command with no pattern slot keeps all of its words, however they are quoted.
    for (const a of ["cat 'a b' x", `cat "" x`, "cat '' x"]) {
      expect(pathWords(a).length, a).toBe(pathWords("cat q x").length);
    }
  });

  it("an escaped or quoted path is still a path", () => {
    for (const dir of dirs) {
      deny(`cat '${dir}/secrets.json'`);
      deny(`cat "${dir}/secrets.json"`);
      deny(`cat ${dir}/'secrets.json'`);
    }
  });

  it("ordinary work in a project's own .claude or .config folder is allowed (I-2)", () => {
    for (const c of [
      "ls .claude/", "ls -la .claude/", "grep -rn todo .claude/", "git add .claude/",
      "du -sh .claude/", "find .claude/ -name '*.md'", "ls .claude/plugins/", "tree .claude/plugins",
      "ls .claude/plugins/data", "cat ./.claude/", "ls ../.claude/", "ls .config/",
      "cp -r .claude/ backup/", "cat .claude/settings.json", "ls .claude",
    ]) allow(c);
  });

  it("but a relative path that reaches into a data folder is still refused (I-2)", () => {
    deny("cat .claude/plugins/data/baseline/secrets.json");
    deny("cat ../../.claude/plugins/data/baseline/x/secrets.json");
    deny("ls .claude/plugins/data/baseline");
    deny("cat .config/baseline/secrets.json");
    deny("ls .claude/plugins/data/*/secrets");
  });

  it("a wrapper's real argument syntax does not excuse what follows it (I-1)", () => {
    const run = { runUrl: "https://staging.acme.dev" };
    const agent = { ...run, agent: true };
    for (const w of ["timeout 5", "timeout 999.5", "timeout 1.5", "timeout 3600.0", "timeout -s SIGKILL 3600",
      "timeout -k 5 10", "timeout --kill-after=5 10", "nice", "nice -10", "nice -n 10", "stdbuf -oL -eL", "setsid"]) {
      deny(`${w} env BASELINE_DATA=/tmp/x baseline script a b`, run);
      deny(`${w} baseline run finish`, agent);
      deny(`${w} baseline signin customer`, agent);
      deny(`${w} cat ${dirs[0]}/secrets.json`);
    }
  });

  it("those wrappers in front of ordinary work are still allowed (I-1)", () => {
    const run = { runUrl: "https://staging.acme.dev" };
    allow("timeout 1.5 pnpm vitest run", run);
    allow("timeout -s SIGKILL 30 node scripts/build.mjs", run);
    allow("nice -n 10 cat src/core/paths.ts", run);
    allow("timeout 30 baseline script customer walk.cjs", { ...run, agent: true });
  });
});
