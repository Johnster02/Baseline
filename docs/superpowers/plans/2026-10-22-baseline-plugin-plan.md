# Baseline Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Baseline, an open-source Claude Code plugin that QA-tests a change (PR, ticket, spec, file, text) against a running site as the user's test accounts and writes an advisory, low-noise, themed report.

**Architecture:** A Claude Code plugin whose skills orchestrate plugin subagents (gatherer, code reader, explorers, guide reader, refuter, cleaner). All deterministic work (config, input fetching, the Playwright safety guard, sign-in, run state, noise filtering, report and terminal rendering) lives in a TypeScript engine bundled by esbuild into committed `dist/` files and exposed on PATH through `bin/baseline`. A mod pane shows themed live progress and the end summary; a self-contained HTML report is always written and published as an artifact when available.

**Tech Stack:** TypeScript 5 (strict), Node 20+, esbuild, vitest, Playwright (installed by setup into `${CLAUDE_PLUGIN_DATA}`, not bundled), zod (bundled). Dev package manager: pnpm.

**Spec:** `docs/superpowers/specs/2026-10-22-baseline-plugin-design.md` (copied into the repo in Task 1). Read it before any task.

## Global Constraints

- Plugin name `baseline`; repo `https://github.com/Johnster02/Baseline` (marketplace add: `Johnster02/Baseline`); MIT licence.
- No employer-specific content anywhere in the repo (spec 4.1). Example data uses "Acme shop".
- Never write state to `${CLAUDE_PLUGIN_ROOT}` (changes on update). Durable per-user state: `${CLAUDE_PLUGIN_DATA}`. Per-project state: `<project>/.baseline/` (gitignored by setup).
- Credentials and saved sessions never appear in reports, logs, progress files or screenshot captions.
- Default depth for every runner: **look only**. Protected areas (live sites and real users, email, auth and accounts, deleting projects or users, payments and finance) are **off** unless ticked in setup.
- Agents never assume: anything that looks protected is skipped and logged, never attempted.
- Every run ends with result **Complete**. No pass/fail result anywhere.
- Related findings are never capped. Unrelated findings go to "Other observations", top 5 by severity listed, rest counted.
- No evidence means verdict `unverified`, never a bug, never a match.
- Themes: `br2049` (default), `light`, `dark` (navy tokens from spec 3.10, exactly).
- Ship `dist/` committed; no `package-lock.json`/`bun.lock` at plugin root (so Claude Code's auto-install never runs; `pnpm-lock.yaml` is ignored by it).
- `claude plugin validate .` passes after every task that touches plugin files.

## Review Focus

1. **A key like `ABC-123` with both Jira and Linear configured** → ask which tracker, never guess. Test in Task 6.
2. **A form submit on a look-only runner whose site sends reads as POST (search)** → the read works only if allowlisted in setup; otherwise it is logged as skipped with category `unknown-write`, and the run continues. Test in Task 4.
3. **The URL given matches a production URL from setup** → run refuses unless `--live` was given on that run. Test in Task 2.
4. **Saved session expired mid-run** → explorer gets a clear "signed out" signal, the run reports that runner as not signed in and continues with others; never re-enters credentials into a different page. Test in Task 5.
5. **Two personas report the same issue with different wording** → merged into one finding when they share the same screen route and spec ref; personas listed. Test in Task 8.

---

## File Structure

```
.claude-plugin/plugin.json        manifest (name, version, userConfig for tracker tokens)
.claude-plugin/marketplace.json   repo is its own marketplace (plugin source "./")
skills/run/SKILL.md               /baseline:run <input...>   orchestration
skills/setup/SKILL.md             /baseline:setup            re-runnable setup
skills/dismiss/SKILL.md           /baseline:dismiss <id> "<reason>"
skills/theme/SKILL.md             /baseline:theme <br2049|light|dark>
agents/{gatherer,code-reader,explorer,guide-reader,refuter,cleaner}.md
checklists/product.md             generic product-sense checklist
hooks/hooks.json                  PreToolUse Bash guard + mod module
mod/pane.js                       built mod (from src/mod)
bin/baseline                      shell shim -> node dist/cli.cjs
src/cli.ts                        subcommand router
src/config/{schema,store,secrets}.ts
src/browser/{guard,session,signin,runner-script}.ts
src/inputs/{resolve,github,jira,linear,files}.ts
src/run/{state,progress,sizing,commit}.ts
src/findings/{schema,filter,counts,notes}.ts
src/render/{tokens,report,terminal}.ts
src/report/template.html          report shell with three themes
src/mod/pane.ts
test/fixture-app/server.ts        "Acme shop" test site
test/**/*.test.ts
scripts/{build.mjs,leak-check.mjs}
.githooks/pre-push
.github/workflows/ci.yml
docs/superpowers/{specs,plans}/
README.md  LICENSE  CONTRIBUTING.md
```

---

### Task 1: Repo scaffold, build, CI and leak check

**Files:**
- Create: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `package.json`, `tsconfig.json`, `scripts/build.mjs`, `bin/baseline`, `src/cli.ts`, `scripts/leak-check.mjs`, `.githooks/pre-push`, `.github/workflows/ci.yml`, `.gitignore`, `LICENSE`, `docs/superpowers/specs/…design.md`, `docs/superpowers/plans/…plan.md`
- Test: `test/cli.test.ts`, `test/leak-check.test.ts`

**Interfaces:**
- Produces: `bin/baseline <subcommand> [args]` → runs `node "$(dirname "$0")/../dist/cli.cjs"`. `src/cli.ts` exports `main(argv: string[]): Promise<number>` and a `register(name, handler)` table later tasks add to. `baseline version` prints the manifest version.
- Produces: `leakCheck(files: string[], bannedTermsFile: string): {file: string; line: number; term: string}[]`.

- [ ] **Step 1:** Write `test/cli.test.ts`: `main(["version"])` returns 0 and prints `0.1.0`; `main(["nope"])` returns 2 and prints usage.
- [ ] **Step 2:** Run `pnpm vitest run test/cli.test.ts`. Expected: FAIL (no module).
- [ ] **Step 3:** Create the manifest (`name: "baseline"`, `version: "0.1.0"`, description from README one-liner, `license: "MIT"`, `userConfig`: `jira_base_url` string, `jira_email` string, `jira_token` string sensitive, `linear_api_key` string sensitive, all optional), marketplace.json (`plugins: [{name:"baseline", source:"./"}]`), package.json scripts `build`, `test`, `check` (`tsc --noEmit && vitest run && node scripts/build.mjs --verify`), build script bundling `src/cli.ts` → `dist/cli.cjs` and `src/mod/pane.ts` → `mod/pane.js` (Playwright marked external), and the CLI router.
- [ ] **Step 4:** Write `test/leak-check.test.ts`: a temp banned file with `acmecorp` and a temp file containing `AcmeCorp` returns one hit (case-insensitive); a missing banned file returns `[]` and the CLI prints "leak check skipped: no banned-terms file".
- [ ] **Step 5:** Implement `leakCheck` and `.githooks/pre-push` calling `node scripts/leak-check.mjs` over `git ls-files`, banned terms read from `~/.config/baseline-private/banned-terms.txt` (one per line, outside the repo). Exit 1 on any hit.
- [ ] **Step 6:** CI: on push/PR run `pnpm i --frozen-lockfile`, `pnpm check`, `npx claude plugin validate .` if available (skip with a notice otherwise), and gitleaks.
- [ ] **Step 7:** Run `pnpm check` and `claude plugin validate .`. Expected: all pass.
- [ ] **Step 8:** Commit `chore: scaffold baseline plugin, build, CI and leak check`.

### Task 2: Config, secrets and production refusal

**Files:**
- Create: `src/config/schema.ts`, `src/config/store.ts`, `src/config/secrets.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces types:
  - `Depth = "look" | "create" | "workflow"`
  - `Category = "live" | "email" | "auth" | "delete" | "finance"`
  - `Runner = { key: string; persona: string; depth: Depth; allow: Category[]; auth: { kind: "form"; loginUrl: string } | { kind: "session" } }`
  - `Patterns = Record<Exclude<Category,"live">, { urls: string[]; words: string[] }>`
  - `ProjectConfig = { runners: Runner[]; patterns: Patterns; readPosts: string[]; productionUrls: string[]; lastUrl?: string; theme: "br2049"|"light"|"dark"; versionProbe?: { url: string; pattern: string }; checklistExtra: string[] }`
- Produces: `loadConfig(projectDir): ProjectConfig` (defaults when absent), `saveConfig(projectDir, cfg)`, `ensureGitignored(projectDir)`, `secretsPath(dataDir, projectDir)` (file per project hash, mode 0600), `getSecret/setSecret(dataDir, projectDir, runnerKey, {username,password})`, `checkTarget(url, cfg, live: boolean): { ok: true } | { ok: false; reason: "production" }`, `describePermissions(runner, patterns): { can: string[]; cannot: string[] }`.
- CLI: `baseline config get|set|allow <runner> <category>|describe`, `baseline target-check <url> [--live]`.

- [ ] **Step 1:** Tests: a fresh project gets `theme: "br2049"` and no runners; a new runner defaults to `depth: "look"`, `allow: []`; `checkTarget("https://shop.acme.dev/x", {productionUrls:["https://shop.acme.dev"]}, false)` → `{ok:false, reason:"production"}` and with `live:true` → ok; secrets file is created with mode `0o600` and never inside the project dir; `ensureGitignored` adds `.baseline/` once (idempotent); `describePermissions` for a default runner lists "send email" etc. under `cannot`.
- [ ] **Step 2:** Run, expect FAIL.
- [ ] **Step 3:** Implement with zod schemas; project config at `<project>/.baseline/config.json`.
- [ ] **Step 4:** Run, expect PASS. **Step 5:** Commit `feat(config): project config, secrets store, production refusal`.

### Task 3: Acme shop fixture site

**Files:**
- Create: `test/fixture-app/server.ts`
- Test: `test/fixture-app.test.ts`

**Interfaces:**
- Produces: `startFixture(): Promise<{ url: string; requests: {method:string; path:string}[]; stop(): Promise<void> }>` — a plain Node http server with: `GET /login` form (user `customer@acme.test` / `pw`), `POST /login`, `GET /cart`, `GET /checkout` with a discount field, `POST /api/search` (read), `POST /api/cart` (write), `POST /api/invoice/send` (button "Send invoice"), `POST /api/users/:id/delete` (button "Delete user"), `GET /version` → `{"commit":"a41c9e2"}`, and a page that fires a `POST /api/track` on load.

- [ ] **Step 1:** Test: server starts, `GET /version` returns the commit, `requests` records method and path. **Step 2:** fail. **Step 3:** implement. **Step 4:** pass. **Step 5:** Commit `test: add Acme shop fixture site`.

### Task 4: Browser session and safety guard

**Files:**
- Create: `src/browser/guard.ts`, `src/browser/session.ts`, `src/browser/runner-script.ts`
- Test: `test/guard.test.ts` (Playwright against the fixture)

**Interfaces:**
- Consumes: `ProjectConfig`, `Runner`, `Category` (Task 2); `startFixture` (Task 3).
- Produces:
  - `BlockedEntry = { at: string; runner: string; method: string; path: string; category: Category | "unknown-write"; reason: string; trigger?: string }`
  - `openSession(opts: { runDir: string; runId: string; runner: Runner; cfg: ProjectConfig; baseUrl: string; storageState?: string }): Promise<Session>`
  - `Session = { page: Page; goto(path: string): Promise<void>; shot(name: string, caption: string): Promise<string>; created(kind: string, label: string, url?: string): void; close(): Promise<void> }`
  - Logs written on close: `<runDir>/logs/<runner>-network.json`, `<runDir>/blocked.json` (append), `<runDir>/created.json` (append).
  - `baseline script <runner> <file.cjs>` runs an agent-written script with `require("baseline")` resolving to the session API, `NODE_PATH` including `${CLAUDE_PLUGIN_DATA}/node_modules`.
- Guard rules (in order): request to a production URL without live permission → abort, category `live`. GET/HEAD/OPTIONS → continue. Non-GET fired while `goto` is loading → learned into `<runDir>/logs/load-requests.json` and allowed for the run. Non-GET whose path matches `cfg.readPosts` → continue. Non-GET matching a protected pattern (URL glob, or the last clicked element's text containing a protected word) for a category not in `runner.allow` → abort with that category. Depth `look` → abort any other non-GET as `unknown-write`. Depth `create`/`workflow` → continue. Redact query values named like token/jwt/session/code or longer than 48 chars in every log.

- [ ] **Step 1:** Tests against the fixture with a look-only runner: visiting `/cart` succeeds; clicking "Apply discount" (POST /api/cart) is aborted and logged as `unknown-write`; the on-load `POST /api/track` is allowed and learned; with `readPosts:["/api/search"]` a search works; a `create` runner may `POST /api/cart` but clicking "Send invoice" is aborted with category `email` when `patterns.email.words` contains "Send invoice"; a `token=abc…` query value is redacted in the network log; the fixture's `requests` never shows an aborted request.
- [ ] **Step 2:** fail. **Step 3:** implement (Playwright `context.route`, click tracking via an exposed binding recording the last clicked element's text). **Step 4:** pass. **Step 5:** Commit `feat(browser): session API and safety guard`.

### Task 5: Sign-in

**Files:**
- Create: `src/browser/signin.ts`
- Test: `test/signin.test.ts`

**Interfaces:**
- Consumes: `getSecret` (Task 2), `openSession` (Task 4).
- Produces: `signIn(runner, cfg, ctx): Promise<{ key: string; ok: boolean; landed?: string; error?: string }>` (form kind: fills the first email/username field and password field on `loginUrl`, submits, saves `storageState` to `${CLAUDE_PLUGIN_DATA}/sessions/<projectHash>/<runner>.json`); `captureSession(runner, cfg, ctx)` (opens a headed browser at `baseUrl`, waits until the user closes it, saves storageState); `isSignedOut(page): Promise<boolean>` (landed on `loginUrl` or a page with a password field). CLI `baseline signin <runner>|--all` prints JSON, never credentials.

- [ ] **Step 1:** Tests: form sign-in against the fixture returns `ok:true` and a storage file exists; wrong password returns `ok:false` with an error that contains neither the username nor the password; an expired storage state (cookie removed) makes `isSignedOut` true and the explorer-facing `goto` throws `SignedOutError` (Review Focus 4). **Step 2:** fail. **Step 3:** implement. **Step 4:** pass. **Step 5:** Commit `feat(browser): form sign-in and saved sessions`.

### Task 6: Inputs

**Files:**
- Create: `src/inputs/resolve.ts`, `src/inputs/github.ts`, `src/inputs/jira.ts`, `src/inputs/linear.ts`, `src/inputs/files.ts`
- Test: `test/inputs.test.ts`

**Interfaces:**
- Produces:
  - `InputRef = { kind: "github-pr"|"github-issue"|"jira"|"linear"|"file"|"folder"|"text"|"url"; ref: string }`
  - `resolveInputs(args: string[], ctx: { trackers: { jira: boolean; linear: boolean }; cwd: string }): InputRef[] | { ambiguous: string; options: InputRef["kind"][] }`
  - `fetchInput(ref: InputRef, env): Promise<{ ref: InputRef; title: string; body: string; links: string[]; changedFiles?: string[]; headSha?: string }>`
  - CLI `baseline inputs <args...>` writes `<runDir>/inputs.json` with fetched items plus `unreadLinks: string[]`.
- Rules: `#123`, `123` or a github.com PR/issue URL → GitHub via `gh` (`gh pr view --json title,body,files,headRefOid` / `gh issue view`). Atlassian URL → jira; linear.app URL → linear. Bare key `[A-Z][A-Z0-9]+-\d+` → the one configured tracker, or `ambiguous` if both. Existing path → file/folder. Anything else → text. Jira REST v3 with basic auth (`jira_email:jira_token`), description rendered to plain text; Linear GraphQL `issue(id)`. Links found in bodies to Confluence/Notion/Google Docs are listed in `links`; the run skill tries to read them with whatever connector Claude has and records failures in `unreadLinks`.

- [ ] **Step 1:** Tests (fetchers mocked): each URL form maps to the right kind; `ABC-12` with both trackers → `ambiguous` (Review Focus 1); with only Linear → linear; a folder lists `.md/.txt/.html/.pdf` files; GitHub PR fetch returns `changedFiles` and `headSha`. **Step 2:** fail. **Step 3:** implement. **Step 4:** pass. **Step 5:** Commit `feat(inputs): resolve and fetch GitHub, Jira, Linear, files and text`.

### Task 7: Run state, progress, sizing, commit check

**Files:**
- Create: `src/run/state.ts`, `src/run/progress.ts`, `src/run/sizing.ts`, `src/run/commit.ts`
- Test: `test/run.test.ts`

**Interfaces:**
- Produces:
  - `newRun(projectDir, sessionId: string | undefined): { runId: string; runDir: string; sessionDir: string }` — runId `r-YYYYMMDD-HHMM`; `sessionDir = .baseline/sessions/<sessionId or runId>`; runs live at `<sessionDir>/runs/<runId>`.
  - `Phase = "gather"|"read-code"|"explore"|"verdicts"|"refute"|"clean-up"`
  - `Progress = { runId: string; label: string; size: "quick"|"full"; agents: number; startedAt: string; phases: { name: Phase; status: "pending"|"active"|"done"|"skipped"; pct?: number; note?: string }[]; active: { persona: string; doing: string }[]; counts: Counts; finishedAt?: string }`
  - `updateProgress(runDir, patch: Partial<Progress>)` (atomic write of `progress.json`, and `.baseline/active-run` pointer); CLI `baseline progress phase <name> <status> [pct] [note]`, `baseline progress agent <persona> "<doing>"`, `baseline progress done`.
  - `sizeRun(inputs, changedFileCount: number, personas: string[]): { size: "quick"|"full"; agents: number; plan: string[] }` — full when any input is a folder, a file over 2,000 words, or a guide; or changed files > 15; or more than 2 personas affected. Quick: 1 code reader (if code), ≤2 explorers, refuter. Full adds guide reader, explorers per persona (max 4), cleaner.
  - `readSiteMap(projectDir): SiteMap` / `mergeSiteMap(projectDir, partial: SiteMap)` where `SiteMap = { routes: { path: string; title: string; personas: string[] }[]; notes: string[] }` in `.baseline/sitemap.json`. Explorers read it before exploring and write what they learned, so later runs skip rediscovery (spec 3.7).
  - `commitInfo(projectDir, cfg): Promise<{ codeRead: boolean; commitRead?: string; deployed?: string; mismatch: boolean }>` — `codeRead` true when cwd is a git repo; deployed from `cfg.versionProbe` regex against the probe URL's body or headers.

- [ ] **Step 1:** Tests: two runs with the same session id share `sessionDir`; without a session id each run gets its own; progress writes are atomic (a reader never sees partial JSON); `mergeSiteMap` merges personas for a repeated route without duplicating it; one PR with 3 files and one persona → quick, ≤3 agents; a spec folder → full; deployed `a41c9e2` vs read `b7…` → `mismatch:true`; no git → `codeRead:false`. **Step 2:** fail. **Step 3:** implement. **Step 4:** pass. **Step 5:** Commit `feat(run): run state, progress file, sizing and commit check`.

### Task 8: Findings, noise filter, counts, dismiss notes

**Files:**
- Create: `src/findings/schema.ts`, `src/findings/filter.ts`, `src/findings/counts.ts`, `src/findings/notes.ts`
- Test: `test/findings.test.ts`

**Interfaces:**
- Produces:
  - `Verdict = "match"|"spec-built"|"built-observed"|"not-built"|"guide-spec"|"unspecced"|"product"|"unverified"|"skipped"`
  - `Finding = { id: string; title: string; verdict: Verdict; severity: "critical"|"high"|"medium"|"low"; personas: string[]; scope: "related"|"unrelated"; route?: string; specced: { text: string; ref: string }; built?: { text: string; ref: string }; observed?: { text: string; shots: string[]; steps: string[] }; refuter?: { kept: boolean; note: string }; checklistItem?: string }`
  - `filterFindings(fs: Finding[], opts: { otherCap: number; codeRead: boolean }): { kept: Finding[]; other: Finding[]; otherHidden: number; dropped: Finding[] }`
  - `countRun(fs: Finding[], skipped: BlockedEntry[]): Counts` where `Counts = { checked: number; passed: number; passRate: number; conflicts: number; product: number; unspecced: number; unverified: number; skipped: number }`. `checked` = all findings except `skipped`; `passed` = `match`; `passRate = round(passed/checked*100)`, 0 when checked is 0. Conflicts = `spec-built|built-observed|not-built|guide-spec`.
  - `addNote(projectDir, findingId, text)` / `listNotes(projectDir): {id; text; findingId; at}[]` in `.baseline/notes.json`; CLI `baseline dismiss <id> "<reason>"`.
- Rules, in order: refuter `kept:false` → dropped. Conflict or product with no `observed.shots`/`steps` and no `built.ref` → verdict becomes `unverified`. With `codeRead:false`, verdicts `spec-built` and `not-built` are not allowed (→ `unverified`). Dedupe: same `route` + same `specced.ref` + same verdict → one finding, personas merged, highest severity kept. `scope:"related"` → kept, never capped. `scope:"unrelated"` → `other`, sorted by severity, first `otherCap` (5) listed, rest counted in `otherHidden`.

- [ ] **Step 1:** Tests: 12 related product findings all kept; 8 unrelated → 5 in `other`, `otherHidden: 3`, highest severities first; a conflict with no evidence becomes `unverified`; Review Focus 5 dedupe case merges personas `["customer","guest"]`; refuter-dropped never appears; counts for 6 match + 2 conflict + 1 product + 1 unverified = checked 10, passRate 60; notes round-trip. **Step 2:** fail. **Step 3:** implement. **Step 4:** pass. **Step 5:** Commit `feat(findings): schema, noise filter, counts and dismiss notes`.

### Task 9: Report renderer (three themes, session grouping)

**Files:**
- Create: `src/render/tokens.ts`, `src/render/report.ts`, `src/report/template.html`
- Test: `test/report.test.ts`

**Interfaces:**
- Consumes: `Finding`, `Counts`, `BlockedEntry`, `Progress`, `Runner`/`describePermissions`.
- Produces:
  - `THEMES: Record<"br2049"|"light"|"dark", Record<string,string>>` — br2049 and light ported from the private hub CSS (see spec 4.1, read-only reference `~/.claude/skills/acceptance-run/hub.html`), dark = spec 3.10 navy tokens verbatim.
  - `RunRecord = { runId; label; inputs: InputRef[]; url: string; size; agents; durationMin: number; commit: Awaited<ReturnType<typeof commitInfo>>; permissions: {runner: string; can: string[]; cannot: string[]}[]; findings: Finding[]; other: Finding[]; otherHidden: number; skipped: BlockedEntry[]; counts: Counts; unreadLinks: string[] }`
  - `renderSessionReport(runs: RunRecord[], theme): string` — one self-contained HTML (inline CSS/JS, screenshots inlined as data URIs, under 16 MiB; shrink JPEG quality until it fits), run switcher newest first when >1 run, theme switcher, layout "option A": case header, big count, tally, persona rows, filterable ledger (verdict, persona, search), finding rows expanding to Specced / Built / Observed (Built column omitted with a "code not read" note when `codeRead:false`), refuter note, copy button; then Other observations (with "+N more"), Skipped (what, why, which permission allows it), Permissions, Unread links.
  - CLI `baseline report <sessionDir>` writes `<sessionDir>/report.html` and prints its path.
- Copy rule: result text is always "Complete".

- [ ] **Step 1:** Tests: rendering two runs shows a switcher and the newest first; `codeRead:false` hides every Built column and shows the note; each theme's `--void` matches its token; no credential string from a fixture secret appears in output; output with 40 screenshots stays under 16 MiB; HTML contains "Complete" and never "Ready for QA" or "Needs work". **Step 2:** fail. **Step 3:** implement (port BR2049 motion — phosphor wipe on filter change — and plain light; navy dark has no glow/scanlines and uses Inter). **Step 4:** pass. **Step 5:** Commit `feat(report): themed session report`.

### Task 10: Terminal renderer

**Files:**
- Create: `src/render/terminal.ts`
- Test: `test/terminal.test.ts`

**Interfaces:**
- Produces: `renderProgress(p: Progress, theme, opts: { color: "truecolor"|"256"|"none"; width: number }): string[]` and `renderSummary(r: RunRecord, theme, opts): string[]`, matching the approved mockups: progress = header, rule, one row per phase (done ✓ / active bar 16 cells with % / pending), one line per active agent, footer with elapsed and counts. Summary = header with duration, pass-rate bar + %, checked/passed, conflicts/product/unverified/skipped counts, `result  Complete`, report link and local path. No finding titles in the summary. `color` from `NO_COLOR` → none, `COLORTERM=truecolor|24bit` → truecolor, else 256.
- CLI `baseline summary <runDir> [--plain]` prints the summary (plain text for the chat).

- [ ] **Step 1:** Tests: summary for the counts in Task 8 shows `60%` and `Complete` and none of the finding titles; `NO_COLOR` output contains no `\x1b[`; width 40 never produces a line longer than 40 visible chars; progress with one active phase at 62% shows 10 filled cells of 16. **Step 2:** fail. **Step 3:** implement. **Step 4:** pass. **Step 5:** Commit `feat(render): themed terminal progress and summary`.

### Task 11: Mod pane

**Files:**
- Create: `src/mod/pane.ts` (built to `mod/pane.js`), `hooks/hooks.json` (`modules` entry)
- Test: `test/pane.test.ts`

**Interfaces:**
- Consumes: `renderProgress`, `renderSummary`, `.baseline/active-run` pointer, `progress.json`.
- Produces: a pane titled "Baseline" shown only while `.baseline/active-run` exists or for 10 minutes after `finishedAt`; redraws every 1s via `$.clock.every` and on file change; shows progress while running and the summary after. Read the mods interface docs (`https://code.claude.com/docs/en/plugins/mods/interface`) before writing; requires Claude Code v2.1.287+.
- `pane.ts` exports a pure `frame(state: { progress?: Progress; record?: RunRecord; now: number }, theme, width): string[]` so it is testable without Claude Code.

- [ ] **Step 1:** Tests on `frame`: no active run → `[]`; active → progress lines; finished 5 min ago → summary; finished 11 min ago → `[]`. **Step 2:** fail. **Step 3:** implement `frame` and the mod wiring. **Step 4:** pass; then load the plugin locally (`claude --plugin-dir .`), write a sample `progress.json` with `baseline progress …` and confirm the pane draws. **Step 5:** Commit `feat(mod): live Baseline pane`.

### Task 12: Agents and product checklist

**Files:**
- Create: `agents/gatherer.md`, `agents/code-reader.md`, `agents/explorer.md`, `agents/guide-reader.md`, `agents/refuter.md`, `agents/cleaner.md`, `checklists/product.md`
- Test: `test/agents.test.ts` (frontmatter and contract lint)

**Interfaces:**
- Models and tools: gatherer `haiku` (Bash, Read; runs `baseline inputs`, follows links); code-reader `sonnet` (Read, Grep, Glob, Bash read-only git; reads diff + callees only, writes `<runDir>/code.json`: requirements → `{built, ref}`); explorer `sonnet` (Bash limited to `baseline script|progress`, Read, Write in runDir; one runner each; accessibility-tree first, screenshots only as evidence; reads `.baseline/sitemap.json` first and writes new routes back via `baseline sitemap merge <file>`; writes `<runDir>/explore-<runner>.json` as `Finding[]` drafts; on anything that looks protected: skip, log, move on); guide-reader `sonnet` (writes `guide.json`); refuter `opus` (Read; gets non-match findings plus spec, code notes, dismiss notes; sets `refuter.kept`, `scope`, and may downgrade to `unverified`; intent check per spec 3.6a); cleaner `haiku` (Bash `baseline script`; removes only objects in `created.json` labelled `Baseline <runId>`).
- Every agent prompt ends with its output contract (file path + JSON shape from Task 8) and the rule "never assume; skip and log anything that looks like email, auth, deletion, payments or live users unless your runner allows it".
- `checklists/product.md`: generic items rewritten without employer examples: workflow can be finished; a request reaches someone; status words match state; one change shows on every surface; twin surfaces offer the same actions; warn before losing work; greyed controls say why; busy state while sending; nothing clips; empty states explain themselves; errors say what to do.

- [ ] **Step 1:** Test: every agent file has `name`, `description`, `model` in the allowed set, `tools` present; every agent body contains its output path and the never-assume rule; `checklists/product.md` passes the leak check. **Step 2:** fail. **Step 3:** write the agents and checklist. **Step 4:** pass, plus `claude plugin validate .`. **Step 5:** Commit `feat(agents): plugin subagents and product checklist`.

### Task 13: Skills and Bash guard hook

**Files:**
- Create: `skills/run/SKILL.md`, `skills/setup/SKILL.md`, `skills/dismiss/SKILL.md`, `skills/theme/SKILL.md`, `src/hooks/bash-guard.ts` (built into `dist/cli.cjs` as `baseline hook bash-guard`), modify `hooks/hooks.json`
- Test: `test/bash-guard.test.ts`, `test/skills.test.ts`

**Interfaces:**
- `/baseline:setup`: first run installs Playwright + Chromium into `${CLAUDE_PLUGIN_DATA}` (`npm install --prefix … playwright@<pinned>` then `npx playwright install chromium`); runs `ensureGitignored`; loops "add a runner?" (key, persona, sign-in kind, credentials → secrets, depth, allowed categories); asks for protected patterns per category, read-only POST paths, production URLs, optional version probe, theme, tracker tokens (via `/plugin configure` userConfig); signs each runner in; ends by printing `baseline config describe` (the can/can't list). Re-running edits instead of starting over.
- `/baseline:run <input...> [--live] [--quick|--full]`: (1) ask for URL with `lastUrl` as default (AskUserQuestion), `baseline target-check`; refuse production without `--live`. (2) `newRun` with `${CLAUDE_SESSION_ID}`; for Jira/Linear inputs use the user's connected Jira/Linear tools when present, else `baseline inputs` (tokens from userConfig); ambiguous key → ask. (3) `commitInfo`, `sizeRun`; say "quick run, N agents" and continue unless the user overrides with the flags. (4) dispatch gatherer then code-reader + explorers (+ guide-reader) in **one message**, updating progress at each phase. (5) verdicts from the drafts, refuter, `filterFindings`. (6) cleaner if anything was created. (7) `baseline report`; publish `report.html` as an artifact when the Artifact tool is available, republishing to the session's saved URL (`<sessionDir>/artifact-url`), else give the local path. (8) `baseline summary --plain` in chat. (9) group `blocked.json` by runner and category; if any, ask which to allow next time and apply with `baseline config allow`. Never changes permissions without that answer.
- `/baseline:dismiss` and `/baseline:theme` call the CLI.
- Bash guard (PreToolUse, matcher `Bash`): while `.baseline/active-run` exists, deny (exit 2 with reason) `curl`/`wget`/`http` calls with a non-GET method to the run's target host, and direct `playwright`/`npx playwright` invocations not going through `baseline script`.

- [ ] **Step 1:** Tests: bash-guard denies `curl -X POST https://shop.acme.dev/api/cart` during an active run and allows it with no active run; allows `curl https://shop.acme.dev/version`; denies `npx playwright test`; skills lint: each SKILL.md has a description and references only `baseline` subcommands that exist in the CLI router. **Step 2:** fail. **Step 3:** implement. **Step 4:** pass, `claude plugin validate .`. **Step 5:** Commit `feat(skills): run, setup, dismiss, theme and Bash guard`.

### Task 14: Docs, dogfood run, release

**Files:**
- Create: `README.md`, `CONTRIBUTING.md`, `docs/permissions.md`, `docs/screenshots/*`
- Modify: `.claude-plugin/plugin.json` (version stays `0.1.0`)

- [ ] **Step 1:** README: badges row at the top (shields.io): CI status (`github/actions/workflow/status/Johnster02/Baseline/ci.yml`), latest release (`github/v/release/Johnster02/Baseline`), licence MIT (`github/license/Johnster02/Baseline`), a static "Claude Code plugin" badge, Node `>=20`, and "PRs welcome". Then one-liner, install (`/plugin marketplace add Johnster02/Baseline`, `/plugin install baseline@baseline`), requirements (Claude Code v2.1.287+ for the live pane; artifact publishing needs a claude.ai login on Pro/Max/Team/Enterprise, otherwise local report), setup, usage examples for each input kind, what it will never do by default, the honest limit (protected-area detection beyond look-only is best effort), themes.
- [ ] **Step 2:** Dogfood: start the fixture (`pnpm fixture`), `/baseline:setup` with a look-only `customer` runner and "Send invoice" under email, then `/baseline:run` with a short spec file saying "expired codes are rejected" against the fixture. Expected: report written, at least one finding, "Send invoice" (if reached) listed under Skipped, the fixture's request log shows no aborted write, summary says Complete. Capture screenshots of the pane and report in all three themes for the README.
- [ ] **Step 3:** `pnpm check`, `claude plugin validate .`, pre-push leak check with the author's banned-terms file present. Expected: all pass, zero leak hits.
- [ ] **Step 4:** Commit `docs: README, permissions guide and screenshots`, push, tag `v0.1.0`.
