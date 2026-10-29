# Baseline Defect Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the eight defects from the 2026-10-29 run notes, make the same test suite pass on Linux and macOS in CI, and instrument a run so the 5-minute target can be argued from evidence.

**Architecture:** All changes are inside the existing TypeScript engine (`src/`), the plugin's agent and skill markdown, and CI. One data-folder resolver replaces the split that currently exists between hook-context and CLI-context calls. Sign-in gains a positive signed-in check that both the stored-password path and the manual-capture path must pass before reporting success. The Bash guard stops matching command text against path-shaped patterns and instead decides whether a path could reach a protected folder, with a new positive corpus guarding against over-blocking.

**Tech Stack:** TypeScript 7 (strict), Node 20+, esbuild, vitest 5, Playwright 1.64.1, zod 4. Package manager: pnpm.

**Spec:** `docs/superpowers/specs/2026-10-29-baseline-defect-fixes-design.md`. Read it before any task; every task below cites its section.

## Global Constraints

- Platform scope is **Linux and macOS**. Existing `win32` branches stay as they are; write no new Windows code and claim no Windows support.
- The holes closed by commits `3eff994`..`7a070db` stay closed. Every existing test in `test/bash-guard.spec.ts`, `test/guard.spec.ts` and `test/guard-decide.spec.ts` must still pass unchanged. Deleting or weakening an existing guard assertion is out of scope for every task.
- `pnpm check` (typecheck, full vitest, `node scripts/build.mjs --verify`, `claude plugin test`) passes at the end of every task. Chromium must be installed locally first: `pnpm exec playwright install chromium`.
- `dist/` is committed. Run `node scripts/build.mjs` and commit the result in any task that changes `src/`.
- Credentials, saved sessions and session state never appear in command output, logs, progress files, timing files or error messages.
- Sign-in results keep the existing rule: they never contain a username or password.
- New user-facing messages use plain words and say what to do next, matching the house style in `src/config/cli.ts`.
- Never write durable state to `${CLAUDE_PLUGIN_ROOT}`.

## Review Focus

1. **A pointer file naming a directory that does not exist yet** → the data folder resolves to the plugin data folder anyway, not the legacy fallback; this is the root of defect 3.1. Test in Task 1.
2. **A site whose home page renders for signed-out visitors, and a runner with no `authedCheck`** → verification reports `weak` with a reason, never `ok`. Test in Task 3.
3. **A command whose quoted regex argument contains `.config` or a glob character** (`sed -n '/[a-z]*\.config/p' notes.txt`) → allowed, while a glob that could actually expand into a protected folder is still refused. Test in Task 5.
4. **`created()` called with a template URL** (`/projects/<id>`) **or a URL on another origin** → the entry is stored without a usable address and marked unconfirmed; `baseline created` shows it as such. Test in Task 8.
5. **`s.upload()` pointed at a path outside the run folder** (`../../etc/passwd`, an absolute path, a symlink out) → refused before the file input is touched. Test in Task 9.

---

## File Structure

**Modified**
- `src/core/paths.ts` — one data-folder resolver; create the pointer target; case-folded `isInside`.
- `src/core/migrate.ts` *(new)* — one-time move of `~/.config/baseline` into the plugin data folder.
- `src/core/doctor.ts` *(new)* — `baseline doctor`: where state lives and what is in it.
- `src/browser/signin.ts` — positive signed-in check; form-path prefix match; capture rewrite.
- `src/browser/launch.ts` *(new)* — one place that decides which browser channel and flags to use.
- `src/config/schema.ts` — `authedCheck` on the runner schema.
- `src/config/store.ts` — `describePermissions` lists the user's own pattern additions in full.
- `src/config/cli.ts` — `config auth`.
- `src/hooks/bash-guard.ts` — path decisions instead of text matching; `guard explain`.
- `src/run/schemas.ts` — `unreadLinks` accepts a string or `{ url, reason? }`.
- `src/inputs/cli.ts` — `inputs unread-link`.
- `src/run/cli.ts` — `size` reports the real validation error; `timings`.
- `src/browser/rpc.ts`, `src/browser/dispatch.ts`, `src/browser/session.ts` — `upload`, `fixture`, hardened `created`, per-command timings.
- `src/browser/owned.ts` — `CreatedEntry` gains `at` and `confirmed`.
- `agents/code-reader.md` — gains the `Write` tool.
- `agents/gatherer.md` — use `inputs unread-link`.
- `agents/explorer.md` — fixtures and upload.
- `agents/cleaner.md` — navigate by `at`, never an unconfirmed `url`.
- `skills/setup/SKILL.md` — ask for `authedCheck`; mention `config auth`.
- `.github/workflows/ci.yml` — `macos-latest` leg.

**Created**
- `fixtures/` — the small files `s.fixture` serves.
- `test/migrate.spec.ts`, `test/doctor.spec.ts`, `test/guard-allows.spec.ts`, `test/upload.spec.ts`, `test/timings.spec.ts`.

---

### Task 1: One data folder

Spec 3.1. Defect 1, and the root cause of the "no record of starting the run" failures.

**Files:**
- Modify: `src/core/paths.ts:13-62`
- Create: `src/core/migrate.ts`
- Modify: `src/hooks/cli.ts:10-14` (store-options rewrites the pointer whenever it sees `CLAUDE_PLUGIN_DATA`)
- Test: `test/config.spec.ts` (resolver), `test/migrate.spec.ts` (new)

**Interfaces:**
- Produces: `recordPluginData(dir: string, home?: string): void` — unchanged signature, now creates `dir` before writing the pointer.
- Produces: `migrateLegacyData(opts: { legacy: string; target: string }): { moved: string[]; skipped: string[] }` in `src/core/migrate.ts`. Copies `secrets/`, `sessions/`, `hosts/`, `runs/` with modes preserved (`0o700` dirs, `0o600` files), never overwrites an existing file at the target, writes `<legacy>/migrated-to` naming the target, and is a no-op when the breadcrumb is already there.
- Produces: `dataDirCandidates(): string[]` — unchanged signature; must keep including `join(home, ".config", "baseline")` after migration.

- [ ] **Step 1: Write the failing tests**

```ts
// test/config.spec.ts
it("a pointer to a folder that does not exist yet still wins over the legacy fallback", () => {
  const home = tmp("home-"), data = join(home, ".claude", "plugins", "data", "baseline");
  recordPluginData(data, home);
  expect(existsSync(data)).toBe(true);
  expect(dataDir(tmp("proj-"))).toBe(data); // with HOME=home and no BASELINE_DATA/CLAUDE_PLUGIN_DATA
});

it("the legacy folder stays protected after migration", () => {
  expect(dataDirCandidates()).toContain(join(home, ".config", "baseline"));
});
```

```ts
// test/migrate.spec.ts
it("moves secrets and sessions, keeps their modes, and leaves a breadcrumb", () => {
  // legacy/secrets/<hash>.json at 0600 and legacy/sessions/<hash>/customer.json
  const r = migrateLegacyData({ legacy, target });
  expect(r.moved).toContain("secrets");
  expect(statSync(join(target, "secrets", `${hash}.json`)).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(legacy, "migrated-to"), "utf8").trim()).toBe(target);
});

it("never overwrites a file already at the target, and reports it as skipped", () => { /* … */ });
it("is a no-op the second time", () => { /* … */ });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run test/migrate.spec.ts test/config.spec.ts`
Expected: FAIL — `migrateLegacyData` is not exported; the pointer test fails because `recordPluginData` does not create the directory.

- [ ] **Step 3: Implement**

In `paths.ts`, make `recordPluginData` `mkdirSync(dir, { recursive: true, mode: 0o700 })` before writing the pointer. Keep `readPointer`'s ownership and containment checks exactly as they are — the fix is that the directory now exists, not that the check is relaxed. Write `migrate.ts` to the interface above.

- [ ] **Step 4: Call the migration once, from `store-options`**

In `src/hooks/cli.ts`, when `CLAUDE_PLUGIN_DATA` is set: `recordPluginData(...)`, then `migrateLegacyData({ legacy: join(home, ".config", "baseline"), target: process.env.CLAUDE_PLUGIN_DATA })`. Swallow and ignore any error — a SessionStart hook must never fail the session.

- [ ] **Step 5: Run the full suite**

Run: `pnpm vitest run`
Expected: PASS, 432+ tests.

- [ ] **Step 6: Commit**

```bash
git add src/core/paths.ts src/core/migrate.ts src/hooks/cli.ts test/migrate.spec.ts test/config.spec.ts dist/
git commit -m "fix(paths): one data folder, with a one-time migration from ~/.config/baseline"
```

---

### Task 2: `baseline doctor`

Spec 3.1. The command that would have diagnosed defects 1–3 in one step.

**Files:**
- Create: `src/core/doctor.ts`, `test/doctor.spec.ts`
- Modify: `src/entry.ts` (register it)

**Interfaces:**
- Consumes: `dataDir`, `dataDirCandidates` from Task 1.
- Produces: `doctorReport(projectDir: string): { resolved: string; pointer?: string; candidates: { dir: string; exists: boolean; runners: string[]; sessions: string[]; secrets: number }[]; activeRun?: string }`. `secrets` is a **count**; never the keys, never any content.
- Produces: a `doctor` command printing that report as plain lines, exit 0 always.

- [ ] **Step 1: Write the failing test**

```ts
it("names the resolved folder and every candidate, and never prints secret contents", () => {
  const r = doctorReport(proj);
  expect(r.resolved).toBe(data);
  expect(r.candidates.map((c) => c.dir)).toContain(join(home, ".config", "baseline"));
  expect(JSON.stringify(r)).not.toContain("hunter2");
});

it("reports the active run when one is going", () => {
  const { runDir } = newRun(proj, undefined, { url, label: "x" });
  expect(doctorReport(proj).activeRun).toBe(runDir);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run test/doctor.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `doctorReport` and register the `doctor` command**

- [ ] **Step 4: Run the test and the CLI**

Run: `pnpm vitest run test/doctor.spec.ts && node dist/cli.cjs doctor`
Expected: PASS, and a readable report.

- [ ] **Step 5: Commit**

```bash
git add src/core/doctor.ts src/entry.ts test/doctor.spec.ts dist/
git commit -m "feat(doctor): report where Baseline keeps state and which run is active"
```

---

### Task 3: A positive signed-in check

Spec 3.3. Defect 3. Do this before Task 4: the capture rewrite depends on it.

**Files:**
- Modify: `src/config/schema.ts:17-25` (runner schema), `src/browser/signin.ts:42-119`
- Modify: `skills/setup/SKILL.md:17-33` (ask for it)
- Test: `test/signin.spec.ts`

**Interfaces:**
- Produces: `authedCheck` on `runnerSchema`, optional: `z.object({ path: z.string(), expect: z.object({ text: z.string().optional(), role: z.string().optional(), name: z.string().optional() }) }).optional()`.
- Produces: `verifySignedIn(page: Page, runner: Runner): Promise<{ ok: boolean; strength: "proved" | "weak"; reason?: string }>`. With an `authedCheck`: navigate `path`, look for `expect`, `strength: "proved"`. Without one: run the existing `isSignedOut` heuristic and return `strength: "weak"` with a reason naming what could not be proved.
- Produces: `SignInResult` gains `strength?: "proved" | "weak"` and keeps `ok`/`error`. `verifySignedIn`'s `reason` is carried in `SignInResult.error`; there is no `reason` field on the result.
- Produces: `looksSignedOut` unchanged in signature; the form branch compares the login path as a **prefix** (`u.pathname === p || u.pathname.startsWith(p.replace(/\/$/, "") + "/")`).

- [ ] **Step 1: Write the failing tests**

```ts
it("a home page that signed-out visitors can see is not proof of being signed in", async () => {
  // fixture app serves / to everyone; runner has no authedCheck
  const r = await signIn(sessionRunner, cfg, ctx);
  expect(r.strength).toBe("weak");
  expect(r.error).toMatch(/could not prove/i);
});

it("an authedCheck that finds its text proves the sign-in", async () => {
  const r = await signIn({ ...sessionRunner, authedCheck: { path: "/account", expect: { text: "Sign out" } } }, cfg, ctx);
  expect(r).toMatchObject({ ok: true, strength: "proved" });
});

it("Clerk's second screen counts as still on the sign-in page", () => {
  expect(looksSignedOut("https://s.acme.dev/sign-in/factor-one", false, formRunner)).toBe(true);
  expect(looksSignedOut("https://s.acme.dev/dashboard", false, formRunner)).toBe(false);
});

it("a form sign-in that stalls on a code screen reports failure, and saves nothing", async () => {
  const r = await signIn(formRunner, cfg, ctx);
  expect(r.ok).toBe(false);
  expect(existsSync(sessionPath(data, proj, formRunner.key))).toBe(false);
});
```

The fixture app in `test/fixture-app/` already serves pages for these tests; add a `/sign-in/factor-one` route that asks for a code and a `/account` page behind the session cookie.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run test/signin.spec.ts`
Expected: FAIL — `strength` is undefined; the stalled form sign-in currently returns `ok: true`.

- [ ] **Step 3: Implement**

Add `authedCheck` to the schema. Write `verifySignedIn`. In `signIn`, replace both `isSignedOut` success checks with `verifySignedIn`, and save the session only when `ok` is true. Replace `Promise.all([page.waitForLoadState("load"), pw.press("Enter")])` with: press, then `page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})`, then verify — an SPA never fires `load` again, so waiting on it proves nothing.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run test/signin.spec.ts`
Expected: PASS.

- [ ] **Step 5: Add the setup question**

In `skills/setup/SKILL.md` step 3, after depth: ask for a path and a word only a signed-in user sees, and set it. Say plainly that without it Baseline cannot prove a sign-in worked.

- [ ] **Step 6: Commit**

```bash
git add src/config/schema.ts src/browser/signin.ts skills/setup/SKILL.md test/ dist/
git commit -m "fix(signin): prove a runner is signed in instead of failing to detect signed out"
```

---

### Task 4: Manual sign-in capture that does not loop or lie

Spec 3.2. Defects 2 and the "reports success when signed out" half of 3.

**Files:**
- Create: `src/browser/launch.ts`
- Modify: `src/browser/signin.ts:121-141`
- Test: `test/signin.spec.ts`

**Interfaces:**
- Consumes: `verifySignedIn` from Task 3.
- Produces: `chooseChannel(available: (name: string) => boolean): { channel?: string; args: string[]; ignoreDefaultArgs: string[] }` in `launch.ts`. Prefers `chrome`, then `msedge`, then bundled Chromium (no channel). Always returns `args: ["--disable-blink-features=AutomationControlled"]` and `ignoreDefaultArgs: ["--enable-automation"]`. Pure and injectable, so it is testable without a browser.
- Produces: `captureSession` unchanged in signature, with the semantics below.

- [ ] **Step 1: Write the failing tests**

```ts
it("prefers a real Chrome, then Edge, then bundled Chromium", () => {
  expect(chooseChannel((n) => n === "chrome").channel).toBe("chrome");
  expect(chooseChannel((n) => n === "msedge").channel).toBe("msedge");
  expect(chooseChannel(() => false).channel).toBeUndefined();
});

it("never launches with the automation banner flags", () => {
  const c = chooseChannel(() => false);
  expect(c.ignoreDefaultArgs).toContain("--enable-automation");
  expect(c.args).toContain("--disable-blink-features=AutomationControlled");
});

it("a window closed while still signed out reports failure and saves no session", async () => {
  const r = await captureSession(runner, cfg, ctx); // fixture app, window closed on the login page
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/signed out|could not/i);
  expect(existsSync(sessionPath(data, proj, runner.key))).toBe(false);
});

it("a popup closing does not end the capture", async () => { /* fixture page opens and closes a popup */ });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run test/signin.spec.ts`
Expected: FAIL — `launch.ts` missing; capture currently returns `ok: true` from the save timer alone.

- [ ] **Step 3: Implement `chooseChannel`**

- [ ] **Step 4: Rewrite `captureSession`**

Launch through `chooseChannel` with `launchPersistentContext(join(dataDir(), "profiles", projectHash, runner.key), …)`, headed. Wait on `browser.on("disconnected")` (and `context.on("close")`), **not** the first `page.on("close")`. Keep saving state on the interval, but drop the `saved` flag as the success signal: when the window closes, open a fresh context from the saved state and return `verifySignedIn`'s result. Report `ok: false` with that reason when it does not pass.

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run test/signin.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/browser/launch.ts src/browser/signin.ts test/signin.spec.ts dist/
git commit -m "fix(signin): manual capture uses a real browser profile and verifies before claiming success"
```

---

### Task 5: The guard stops reading regexes as paths

Spec 3.4. Defect 4. **The constraint on this task is the one that matters:** every existing guard assertion keeps passing.

**Files:**
- Modify: `src/hooks/bash-guard.ts:91-152, 193`
- Create: `test/guard-allows.spec.ts` (the positive corpus)
- Modify: `src/entry.ts` (register `guard explain`)
- Test: `test/bash-guard.spec.ts` (unchanged assertions must still pass)

**Interfaces:**
- Produces: `explainBash(command: string, ctx: BashContext): { decision: "allow" | "deny"; rule?: string; deny?: string }` — `bashGuard` with the name of the rule that fired. `bashGuard` keeps its exact signature and delegates to it.
- Produces: a `guard explain '<command>'` command printing that, exit 0.

- [ ] **Step 1: Write the positive corpus as a failing test**

```ts
// test/guard-allows.spec.ts — commands that must never be refused
const ALLOWED = [
  "ls ~/.config/nvim/*.lua",
  "ls ~/.claude/plugins/cache/*/skills",
  "cat ~/.claude/settings.json",
  "sed -n '/[a-z]*\\.config/p' notes.txt",
  "grep -rn \"BASELINE_DATA=\" src/core/paths.ts",
  "grep -rn 'CLAUDE_PLUGIN_DATA' hooks/hooks.json",
  "echo \"$CLAUDE_PLUGIN_DATA\"",
  "ls $HOME/.config/gh",
  "find ~/.claude -name '*.json'",
  "rg -l 'TODO' ~/.claude/projects",
  // … the full list is in spec 3.4 plus the project's own developer commands
];
it("allows commands that cannot reach a protected folder", () => {
  for (const c of ALLOWED) expect(bashGuard(c, { protectedDirs: [legacyData], runUrl: url })).toEqual({ allow: true });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run test/guard-allows.spec.ts`
Expected: FAIL on at least the five commands named in spec 3.4.

- [ ] **Step 3: Replace the blanket `.config`/`.claude` rules**

In `mentionsDataDir`, delete the two unconditional returns for a path through `.config` or `.claude` (`:110`, `:125`). In their place, for a word whose expansion is uncertain, compare the glob's **fixed prefix** against the actual `protectedDirs` — refuse only when that prefix contains or is contained by one of them, which is what the following line already does. Keep every other containment check exactly as it is.

- [ ] **Step 4: Narrow `ENV_OVERRIDE` and `$CLAUDE_PLUGIN_DATA` to real positions**

Test `ENV_OVERRIDE` against each **normalised segment** (`normalizeSegment` already strips wrappers), anchored at the segment start, instead of against the raw command. Treat `$CLAUDE_PLUGIN_DATA` as a hit only when it begins a path-position word, not when it is an argument to `echo`, `grep` or `rg`.

- [ ] **Step 5: Run both corpora**

Run: `pnpm vitest run test/guard-allows.spec.ts test/bash-guard.spec.ts test/guard.spec.ts test/guard-decide.spec.ts`
Expected: PASS, with no existing assertion changed. If an adversarial test now fails, the narrowing went too far — tighten the new rule, do not edit the old test.

- [ ] **Step 6: Add `guard explain`**

- [ ] **Step 7: Commit**

```bash
git add src/hooks/bash-guard.ts src/entry.ts test/guard-allows.spec.ts dist/
git commit -m "fix(guard): decide by what a path can reach, not by what the text looks like"
```

---

### Task 6: The code-reader writes its own file

Spec 3.4, second half. Defect 4's "stopped its code-reader from saving results", which I could not reproduce.

**Files:**
- Modify: `agents/code-reader.md:5, 22-26`
- Test: `test/agents.spec.ts`

- [ ] **Step 1: Try to reproduce the block first**

Run `baseline guard explain` (Task 5) on the shapes a code-reader would use to write `code.json` with Bash: a heredoc, a `>` redirect, `tee`, `node -e`, `python3 -c`, both with and without an active run and with `agent: true`. Record what you find in the task's commit message. If something **is** refused, fix that rule under Task 5's constraints and say so.

- [ ] **Step 2: Write the failing test**

```ts
// test/agents.spec.ts
it("every agent that writes a file has the Write tool", () => {
  for (const a of agents) if (/write `<runDir>/.test(a.body)) expect(a.tools).toContain("Write");
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm vitest run test/agents.spec.ts`
Expected: FAIL — `code-reader` is told to write `<runDir>/code.json` with `tools: Read, Grep, Glob, Bash`.

- [ ] **Step 4: Add `Write` to the code-reader's tools**

Keep the "the only command you run that writes anything" line accurate: it now writes `code.json` with Write, and `baseline progress` stays its only writing *command*.

- [ ] **Step 5: Run the test and the plugin tests**

Run: `pnpm vitest run test/agents.spec.ts && claude plugin test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add agents/code-reader.md test/agents.spec.ts
git commit -m "fix(code-reader): give it the Write tool it needs for code.json"
```

---

### Task 7: `unreadLinks` the sizing step can read

Spec 3.5. Defect 5.

**Files:**
- Modify: `src/run/schemas.ts:25-37`, `src/inputs/cli.ts`, `src/run/cli.ts:109-120`
- Modify: `agents/gatherer.md:22-27`
- Test: `test/inputs-cli.spec.ts`, `test/run-cli.spec.ts`

**Interfaces:**
- Produces: `unreadLinks: z.array(z.union([z.string(), z.object({ url: z.string(), reason: z.string().optional() })]).transform((v) => (typeof v === "string" ? { url: v } : v)))` — reading a file written either way yields `{ url, reason? }`.
- Produces: `baseline inputs unread-link <url> [--reason <text>] [--run <dir>]`, appending to `inputs.json` atomically through `writeJsonAtomic`, exit 2 on a bad URL.
- Produces: `baseline size`'s failure message includes the zod issue list, in the style of `loadConfig`'s (`src/config/store.ts:17`).
- Note for the report: `src/render/report.ts:205` renders `unreadLinks` as strings; it must now read `.url`.

- [ ] **Step 1: Write the failing tests**

```ts
it("reads a file the gatherer wrote with objects", () => {
  writeFileSync(join(runDir, "inputs.json"), JSON.stringify({ items: [], unreadLinks: [{ url: "https://wiki/x", reason: "403" }] }));
  expect(inputsFileSchema.parse(JSON.parse(readFileSync(...)))).toMatchObject({ unreadLinks: [{ url: "https://wiki/x", reason: "403" }] });
});
it("still reads the old string form", () => { /* ["https://wiki/x"] → [{ url: "https://wiki/x" }] */ });
it("unread-link appends without rewriting the items", () => { /* … */ });
it("size says what is actually wrong with inputs.json", () => {
  // items: "nope"
  expect(stderr).toMatch(/items/);
  expect(stderr).not.toMatch(/no readable inputs\.json/);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run test/inputs-cli.spec.ts test/run-cli.spec.ts`
Expected: FAIL — the object form is rejected; `size` prints the misleading message.

- [ ] **Step 3: Implement the schema, the command and the error message, and fix the report's reader**

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run test/inputs-cli.spec.ts test/run-cli.spec.ts test/report.spec.ts`
Expected: PASS.

- [ ] **Step 5: Point the gatherer at the command**

Replace "Add every link you could not read to `unreadLinks` in `inputs.json`" with the command, and say not to edit `inputs.json` by hand.

- [ ] **Step 6: Commit**

```bash
git add src/run/schemas.ts src/inputs/cli.ts src/run/cli.ts src/render/report.ts agents/gatherer.md test/ dist/
git commit -m "fix(inputs): record unread links through a command, and read both shapes"
```

---

### Task 8: Created items carry a real address

Spec 3.7. Defect 7 — the one that nearly sent the cleaner to the wrong place.

**Files:**
- Modify: `src/browser/session.ts:381-387`, `src/browser/owned.ts:95-114`, `src/run/cli.ts:34-39`
- Modify: `agents/cleaner.md:10-27`, `agents/explorer.md:62-63, 75`
- Test: `test/owned.spec.ts`

**Interfaces:**
- Produces: `CreatedEntry` gains `pageUrl: string` (where the browser actually was when `created()` was called) and `confirmed: boolean`. `at` keeps its current meaning — the timestamp — so no existing field changes meaning and no migration is needed.
- Produces: `created(kind, label, url?)` — `url` defaults to the current page URL; a `url` on another origin is rejected with a thrown error naming the origin; a `url` matching `/[<>{}*]|:[a-z]+\b/` is stored as `urlUnusable: true` with no `url`. `confirmed` is true when the entry's path is in `OwnedTracker.paths`.
- Produces: `baseline created` output includes `pageUrl`, `confirmed` and `urlUnusable`.

- [ ] **Step 1: Write the failing tests**

```ts
it("records the page the browser is actually on when no url is given", async () => {
  await s.goto("/projects/9f2c-…");
  await s.created("project", "Baseline r-1 project");
  expect(readCreated(runDir).at(-1)).toMatchObject({ pageUrl: `${base}/projects/9f2c-…`, url: "/projects/9f2c-…" });
});
it("refuses a url on another origin", async () => {
  await expect(s.created("project", "Baseline r-1 project", "https://evil.test/p/1")).rejects.toThrow(/origin/);
});
it("stores a template url as unusable rather than as an address", async () => {
  await s.created("project", "Baseline r-1 project", "/projects/<id>");
  expect(readCreated(runDir).at(-1)).toMatchObject({ urlUnusable: true });
  expect(readCreated(runDir).at(-1)).not.toHaveProperty("url");
});
it("marks an entry confirmed when the browser owns that path", async () => { /* … */ });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run test/owned.spec.ts`
Expected: FAIL — `created` currently stores whatever it is given.

- [ ] **Step 3: Implement, keeping the legacy reader working**

`isCreated` must still accept entries written by earlier versions (no `pageUrl`, no `confirmed`): default `confirmed: false`, `pageUrl: ""`.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run test/owned.spec.ts test/run-cli.spec.ts`
Expected: PASS.

- [ ] **Step 5: Tell the cleaner what to trust**

In `agents/cleaner.md`: navigate by `pageUrl`, or find the item by its label on the list page. Never navigate to a `url` on an entry whose `confirmed` is false or whose `urlUnusable` is true — record it as left behind and say why. In `agents/explorer.md`, say that `s.created` takes the real URL of the page the record is on, and that passing a placeholder loses the address.

- [ ] **Step 6: Commit**

```bash
git add src/browser/session.ts src/browser/owned.ts src/run/cli.ts agents/cleaner.md agents/explorer.md test/owned.spec.ts dist/
git commit -m "fix(created): record the page the record is really on, and say when the address is unusable"
```

---

### Task 9: Uploads and fixtures

Spec 3.6. Defect 6.

**Files:**
- Create: `fixtures/` (a small PNG, a ~1-second MP4, a one-page PDF, a small CSV; each under 200 KB)
- Modify: `src/browser/rpc.ts:2-5`, `src/browser/dispatch.ts:22-38`, `src/browser/session.ts:30-49, 331-393`
- Modify: `agents/explorer.md:26-31, 66-81`
- Create: `test/upload.spec.ts`

**Interfaces:**
- Produces: `COMMANDS` gains `"upload"` and `"fixture"`.
- Produces: `Session.fixture(name: string): Promise<string>` — copies `fixtures/<name>` into `<runDir>/fixtures/` and returns the run-folder-relative path. An unknown name throws, naming what is available.
- Produces: `Session.upload(t: Target, paths: string[]): Promise<void>` — resolves each path against `runDir`, refuses (throws, before touching the page) anything that is not inside it after `realpathSync`, then `locator.setInputFiles`. Attributes the action through `noteTarget(l, "input")` so the guard judges the resulting write by the control's words, exactly as `fill` does.

- [ ] **Step 1: Write the failing tests**

```ts
it("refuses a path outside the run folder", async () => {
  for (const p of ["../../etc/passwd", "/etc/passwd", "fixtures/../../x"]) {
    await expect(s.upload({ label: "File" }, [p])).rejects.toThrow(/run folder/);
  }
});
it("refuses a symlink that points out of the run folder", async () => { /* … */ });
it("uploads a fixture copied into the run folder", async () => {
  const f = await s.fixture("clip.mp4");
  await s.upload({ label: "File" }, [f]);
  expect(await s.text()).toContain("clip.mp4");
});
it("names what is available when the fixture is unknown", async () => {
  await expect(s.fixture("nope.mov")).rejects.toThrow(/clip\.mp4/);
});
```

The fixture app needs a page with a file input that echoes the uploaded filename.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run test/upload.spec.ts`
Expected: FAIL — `"upload" is not an allowed command`.

- [ ] **Step 3: Add the fixtures, then implement `fixture` and `upload`**

- [ ] **Step 4: Run the tests and the guard suite**

Run: `pnpm vitest run test/upload.spec.ts test/guard.spec.ts test/dispatch.spec.ts`
Expected: PASS. The guard suite must be unchanged: an upload's POST still goes through `onRequest`.

- [ ] **Step 5: Document both verbs for the explorer**

Add them to the API list, and to the test-data rules: a fixture needing a file is no longer a reason to fall back to someone else's record.

- [ ] **Step 6: Commit**

```bash
git add fixtures/ src/browser/ agents/explorer.md test/upload.spec.ts dist/
git commit -m "feat(script): upload files from the run folder, with a small shipped fixture set"
```

---

### Task 10: Switching auth kind, and a summary that shows the user's own words

Spec 3.8. Defect 8, both halves.

**Files:**
- Modify: `src/config/cli.ts:33-36` (new `auth` case), `src/config/store.ts:54-66`
- Modify: `skills/setup/SKILL.md:17-33, 57-58`
- Test: `test/config-cli.spec.ts`, `test/config.spec.ts`

**Interfaces:**
- Produces: `baseline config auth <runner> <form <loginUrl>|session>` — changes only `auth`, keeping `depth`, `allow`, `notes` and `authedCheck`; deletes the saved session, and the stored password too when leaving `form`. Exit 2 on an unknown runner or a missing login URL.
- Produces: `describePermissions(runner, patterns)` — unchanged signature. The `cannot` line names at most 6 defaults, then `; yours: …` listing **every** user addition for that category, computed by differencing against `defaultPatterns()`.

- [ ] **Step 1: Write the failing tests**

```ts
it("switching to manual sign-in keeps depth, allowed areas and notes", () => {
  // customer: depth create, allow ["email"], one note, auth form
  run(["config", "auth", "customer", "session"]);
  expect(loadConfig(cwd).runners[0]).toMatchObject({ depth: "create", allow: ["email"], auth: { kind: "session" } });
  expect(loadConfig(cwd).runners[0].notes).toHaveLength(1);
  expect(getSecret(data, cwd, "customer")).toBeUndefined();
});

it("the summary shows every risky word the user added", () => {
  const p = patternsSchema.parse({ delete: { words: ["nuke the workspace"] } });
  const d = describePermissions(lookRunner, p);
  expect(d.cannot.join(" ")).toContain("nuke the workspace");
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run test/config-cli.spec.ts test/config.spec.ts`
Expected: FAIL — no `auth` subcommand; the custom word is cut off by the 6-item slice.

- [ ] **Step 3: Implement both**

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run test/config-cli.spec.ts test/config.spec.ts`
Expected: PASS.

- [ ] **Step 5: Mention `config auth` in setup**

Step 3 of the skill: changing how an existing runner signs in uses `config auth`, not remove-and-add.

- [ ] **Step 6: Commit**

```bash
git add src/config/ skills/setup/SKILL.md test/ dist/
git commit -m "feat(config): switch a runner's sign-in kind, and show the user's own risky words"
```

---

### Task 11: Linux and macOS, proven in CI

Spec 4.

**Files:**
- Modify: `src/core/paths.ts:80-83` (`isInside`)
- Modify: `test/*.spec.ts` — realpath the temp roots
- Modify: `.github/workflows/ci.yml:10-12`

**Interfaces:**
- Produces: `isInside(parent, child)` — unchanged signature; folds case on `darwin` and `win32`, compares exactly elsewhere.

- [ ] **Step 1: Write the failing test**

```ts
it("recognises the data folder whatever case it is spelled in, where the filesystem ignores case", () => {
  const folds = process.platform === "darwin" || process.platform === "win32";
  expect(isInside("/Users/j/.config/baseline", "/users/j/.config/BASELINE/secrets")).toBe(folds);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run test/config.spec.ts`
Expected: FAIL on macOS (and, on Linux, pass only once the platform branch exists).

- [ ] **Step 3: Implement the case fold in `isInside`**

- [ ] **Step 4: Realpath the temp roots in tests**

Wrap every `mkdtempSync(join(tmpdir(), …))` in `realpathSync`, so expectations match code that calls `realPath`. A shared helper in `test/setup.ts` is the DRY way; use it everywhere.

- [ ] **Step 5: Add the macOS CI leg**

Turn `check` into a matrix over `os: [ubuntu-latest, macos-latest]`, keeping `node: [20, 22, 24]` on Ubuntu and Node 22 only on macOS. The Playwright cache path differs per OS: use `~/Library/Caches/ms-playwright` on macOS.

- [ ] **Step 6: Run everything locally, then push and read CI**

Run: `pnpm check`
Expected: PASS on Linux. Then confirm the macOS leg is green; fix what it finds under this task.

- [ ] **Step 7: Commit**

```bash
git add src/core/paths.ts test/ .github/workflows/ci.yml dist/
git commit -m "fix(portability): fold path case on macOS, realpath test roots, run CI on macOS"
```

---

### Task 12: Measure the run before optimising it

Spec 2.1. The 14-minute run. This task buys evidence, not a speed-up.

**Files:**
- Modify: `src/browser/dispatch.ts:48-87` (time each command), `src/browser/session.ts:426` (default timeout), `src/browser/session.ts:315-328` (`networkidle` wait)
- Modify: `src/run/cli.ts` (`timings`)
- Create: `test/timings.spec.ts`

**Interfaces:**
- Produces: each dispatched command appends `{ at, runner, method, ms, ok }` to `<runDir>/logs/<runner>-timings.jsonl`. Target names and argument values are **not** recorded: a `fill` argument is a value typed into a site.
- Produces: `baseline timings [--run <dir>]` — total wall time per runner, the slowest 10 commands, and the count and total cost of commands that ended in a timeout.
- Produces: `context.setDefaultTimeout(8000)` (was 15000) and the `networkidle` wait in `agentNavigation` at 1000 ms (was 3000). Both read `BASELINE_TIMEOUT_MS` / `BASELINE_IDLE_MS` when set, so a slow site can be turned back up without a rebuild.

- [ ] **Step 1: Write the failing tests**

```ts
it("records one line per command, with no argument values", async () => {
  await s.fill({ label: "Email" }, "someone@example.test");
  const lines = readJsonl(join(runDir, "logs", "customer-timings.jsonl"), (v) => v);
  expect(lines.at(-1)).toMatchObject({ method: "fill", ok: true });
  expect(JSON.stringify(lines)).not.toContain("someone@example.test");
});
it("timings names the slowest commands and the cost of timeouts", () => {
  // three lines: click 120ms ok, waitFor 8000ms !ok, snapshot 40ms ok
  const out = run(["timings", "--run", runDir]);
  expect(out).toMatch(/waitFor.*8000/);
  expect(out).toMatch(/1 timed out/);
  expect(out).toMatch(/8\.1\d?s total/);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run test/timings.spec.ts`
Expected: FAIL — no timings file.

- [ ] **Step 3: Implement the timing log, the `timings` command and the two tuned waits**

- [ ] **Step 4: Run the suite**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/browser/ src/run/cli.ts test/timings.spec.ts dist/
git commit -m "feat(timings): record what each browser command costs, and tune two waits"
```

- [ ] **Step 6: Do a real run and report, do not guess**

Run Baseline against a real target, then `baseline timings`. Report: total wall time, time per phase, the slowest commands, and how much went to timeouts. Recommend the next move from that, and say plainly whether 5 minutes looks reachable.

---

## Notes for whoever executes this

- **Tasks 1–5 are the ones that caused the several-attempt sign-in.** If the work is cut short, cut from the bottom, not the top.
- **Task 5 is the risky one.** It loosens a security guard that was deliberately tightened five commits ago. The existing adversarial tests are the specification; the positive corpus is the new requirement. Both must pass, and no existing assertion may be edited to make that happen.
- Chromium must be installed before any test run: `pnpm exec playwright install chromium`. Without it, 42 browser tests fail for reasons that have nothing to do with this work.
- The previous session told John it had saved the dual-folder workaround to memory. The project memory directory is empty, so that note does not exist — the migration in Task 1 is what replaces it.
