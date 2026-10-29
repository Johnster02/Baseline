# Baseline: eight reported defects, plus Linux/macOS portability

Status: proposed · 2026-10-29 · Author: Claude, from John Chaplin's run notes

## 1. Intent, and why now

A real run of Baseline against the author's own site produced eight defects and took 14 minutes
against a 5-minute target. Three of them together made signing in take several attempts, and one
nearly sent the cleaner to delete the wrong thing. This spec records what each defect actually is
(traced to code, not guessed), what we are changing, and what we are deliberately leaving alone.

The run notes are the requirements. Each numbered item below is one of them, in the author's
order — worst first.

**Platform scope:** Linux and macOS. Windows is parked: existing `win32` branches stay, nothing
new is written for them, and nothing claims Windows support.

## 2. Goals, non-goals, anti-goals

**Goals**
- A sign-in either works and says so, or fails and says why. No third outcome.
- One data folder. A login saved by any Baseline command is visible to every other one.
- The safety guard refuses what it was built to refuse, and nothing else.
- A run's own agents can do their jobs without fighting the plugin.
- The same test suite passes on Linux and macOS, proven in CI.

**Non-goals**
- Windows support.
- A 5-minute run as a committed outcome of this work. We instrument first (see 2.1).
- Reworking the guard's threat model. The holes closed in commits `3eff994`..`7a070db` stay closed.

**Anti-goals (failure even if the code works)**
- A guard change that re-opens any hole an existing test covers.
- A sign-in that reports success without positive evidence of being signed in.
- A cleaner that can be pointed at a record the run did not create.
- Credentials or session state in a second location after migration.

### 2.1 On the 14-minute run

The explorer alone took nearly 10 minutes. Measured on this machine, `baseline`'s own overhead is
~85 ms per CLI call and ~45 ms per guard hook, so the plugin accounts for seconds, not minutes.
The time is agent turns: writing scripts, reading snapshots, and re-planning after a blocked step.
Two of the eight defects (sign-in loops, no file upload) directly cause re-planning.

Decision: we do **not** promise 5 minutes in this work. We add per-command timing to the run
folder and a `baseline timings` command, tune the two waits that can cost seconds per action, and
decide the next move from evidence. (My call.)

## 3. The defects, as traced

### 3.1 Two data folders

`dataDir()` (`src/core/paths.ts:49`) resolves `BASELINE_DATA` → `CLAUDE_PLUGIN_DATA` →
`readPointer(home)` → `~/.config/baseline`. Hooks are given `CLAUDE_PLUGIN_DATA`; plain Bash calls
are not, so they depend on the pointer file the SessionStart hook writes. `readPointer`
(`:34`) rejects a pointer whose target is not an existing directory, and `recordPluginData`
(`:16`) writes the pointer without creating that directory. So until something else creates it,
hook-context commands use the plugin data folder and CLI-context commands use
`~/.config/baseline`.

This is wider than logins. `trustedActiveRun` (`src/hooks/active-run.ts:41`) and
`readTrustedRun` (`src/core/trusted-run.ts:13`) both read `dataDir()`. A split means the guard can
fail to see an active run, and `checkRunDir` can refuse a run Baseline really did start
("Baseline has no record of starting the run in …").

**Decisions.** One resolver, used everywhere. `recordPluginData` creates the target directory, so
a valid pointer is never rejected for not existing. A hook that sees `CLAUDE_PLUGIN_DATA` rewrites
the pointer to agree with it. On first use, if both folders hold state, Baseline migrates
`~/.config/baseline` into the plugin data folder, copying secrets and sessions with their modes,
and leaves a `migrated-to` breadcrumb. `dataDirCandidates()` keeps listing both locations forever,
because the guards must keep protecting the old one. A new `baseline doctor` prints the resolved
folder, the pointer, and what each candidate holds. (My calls, all of them.)

### 3.2 The manual sign-in window loops, and reports success when signed out

`captureSession` (`src/browser/signin.ts:122`):
- launches bundled Chromium with Playwright's defaults, which Google's sign-in refuses; a plain
  Playwright window worked for the author, which points at the launch flags rather than Playwright;
- resolves on the **first** `page.on("close")`, so an OAuth popup closing ends the capture;
- sets `saved = true` from a 2-second timer that saves whatever `storageState()` returns, signed in
  or not (`:134`), and returns `ok: true` on that flag alone (`:140`).

**Decisions.** Launch a real Chrome or Edge channel when one is installed, falling back to bundled
Chromium, with `--enable-automation` removed and `AutomationControlled` disabled. Use a persistent
per-runner profile directory inside the data folder, so a popup-based OAuth flow behaves the way it
does in a normal browser. End the capture on browser disconnect, not on one page closing. Return
`ok: true` only after the captured state passes the signed-in check of 3.3 in a fresh context.
(My calls.)

### 3.3 The sign-in check passes when signed out

`isSignedOut` (`:54`) is a signed-**out** detector used as proof of being signed in. For a
`session` runner it loads `ctx.baseUrl` (`:82`) and asks only whether a password field is visible
on a sign-in-looking path. A home page that signed-out visitors can see satisfies it, so an expired
session reports `ok: true`.

The form path has the same shape. After submitting, `looksSignedOut` (`:48`) compares the current
pathname to the login pathname for **equality**, so Clerk's second screen (`/sign-in/factor-one`,
`/sign-in/factor-two`) is not "the login page"; if that screen asks for a code rather than a
password, nothing is visible to detect, and `signIn` saves the signed-out state and returns
`ok: true` (`:111`-`:113`). `await Promise.all([page.waitForLoadState("load"), pw.press("Enter")])`
(`:109`) also resolves immediately on an SPA, because the page is already loaded.

**Decisions.** Add an optional per-runner `authedCheck` to the config: a path plus something only a
signed-in user sees. Setup asks for it. Verification is positive: load the path, look for the
thing. Without an `authedCheck`, verification reports `weak` and says what it could not prove —
never `ok`. Treat the login path as a **prefix**, so auth sub-steps count as "still signing in".
(My calls.)

### 3.4 The guard blocks its own helpers and harmless commands

Reproduced against `bashGuard` with this project's protected dirs:

| Command | Why |
|---|---|
| `ls ~/.config/nvim/*.lua` | any glob through `.config` is refused (`src/hooks/bash-guard.ts:125`) |
| `ls ~/.claude/plugins/cache/*/skills` | same rule for `.claude` — this is where the plugin's own skills live |
| `sed -n '/[a-z]*\.config/p' notes.txt` | a regex argument is read as a path |
| `grep -rn "BASELINE_DATA=" src/core/paths.ts` | `ENV_OVERRIDE` (`:36`) matches the text anywhere, including inside a quoted pattern |
| `echo "$CLAUDE_PLUGIN_DATA"` | `mentionsDataDir` (`:95`) matches any mention |

The common cause: the guard matches command **text** against path-shaped patterns instead of
deciding whether a path could reach a protected folder. `cat ~/.claude/settings.json` and
`grep -E '^[a-z]*$' /home/johnc/.config/app/list.txt` are allowed, so the behaviour turns on
spelling, not on what the command touches.

The code-reader report (it "stopped its code-reader from saving results") is **not reproduced**.
`writeGuard` allows writes anywhere under `.baseline/sessions/`, which is where run folders live,
and none of the heredoc, redirect, `tee`, `node -e` or `python3 -c` shapes I tried is refused, with
or without an active run. Two things follow. First, the code-reader is declared with
`tools: Read, Grep, Glob, Bash` and no `Write` (`agents/code-reader.md:5`) while being told to
write a file, so it must shell out for something the Write tool does directly — give it `Write`.
Second, we cannot fix what we cannot see, so add `baseline guard explain '<command>'`, which prints
the decision and the rule that made it. (My calls.)

**Decisions.** Replace the blanket `.config`/`.claude` rules with a check of the glob against the
actual protected directories. Match `ENV_OVERRIDE` only on an assignment at the start of a command
segment, using the existing segment normalisation. Treat `$CLAUDE_PLUGIN_DATA` as a hit only in a
path or assignment position. Add a positive corpus of commands that must be allowed, kept beside
the existing adversarial corpus, and require both to pass. (My calls.)

### 3.5 The gatherer writes a file the sizing step cannot read

`inputsFileSchema.unreadLinks` is `z.array(z.string())` (`src/run/schemas.ts:35`). The gatherer is
told only to "add every link you could not read to `unreadLinks`" (`agents/gatherer.md:25`), with
no shape, so it writes objects. `baseline size` reads the file through that schema
(`src/run/cli.ts:113`); one bad field makes the whole file unreadable and the command says
`no readable inputs.json in <runDir>. Run: baseline inputs <input...>`, which is misleading — the
file is there. The report silently falls back to empty for the same reason.

**Decisions.** The gatherer stops hand-editing the file: `baseline inputs unread-link <url>
[--reason <text>]` appends atomically. The schema accepts a string or `{ url, reason? }` and
normalises to the object form. `baseline size` reports the actual validation error. (My calls.)

### 3.6 The explorer cannot upload a file

The script API has no upload verb (`src/browser/rpc.ts:2`), so a runner whose fixture needs a file
(the author's case: a video clip) cannot build its own test data and falls back to someone else's
record, read-only — which 3.7's "test data" rules then forbid it from touching.

**Decisions.** Add `upload` and `fixture` to the command list. `s.fixture(name)` copies one of a
small set of files shipped with the plugin into the run folder and returns its relative path;
`s.upload(target, paths)` sets a file input from paths that resolve **inside the run folder** and
nowhere else. The sandbox already allows exactly that (`--allow-fs-read=<runDir>`,
`src/browser/runner-script.ts:100`), and the resulting POST still goes through the guard's route
handler, so no new way past it is created. (My calls.)

### 3.7 Created items are recorded with the wrong name and address

`created()` (`src/browser/session.ts:381`) records whatever the agent passes, with no check that
`url` is same-origin, resolvable, or a page the browser ever saw. `appendCreated` does not validate
either. The cleaner is told to use that `url` (`agents/cleaner.md:10`), so a placeholder such as
`/projects/<id>` sends it to the wrong place. `labelled` is computed from the label, so a
mis-formatted name also quietly becomes "not ours".

**Decisions.** `created(kind, label, url?)` defaults `url` to the page's current URL, always
records the real page URL as `at`, refuses a `url` that is not same-origin, and marks a
template-looking one (`<`, `{`, `:id`, `*`) as unusable rather than storing it. Each entry gains
`confirmed`, true when its path is one `OwnedTracker` independently owns. `baseline created`
reports `at` and `confirmed`, and the cleaner is told to navigate by `at` or by the item's label,
never by an unconfirmed `url`. (My calls.)

### 3.8 Smaller things

**Auth kind cannot be changed.** `config add-runner` refuses an existing key
(`src/config/cli.ts:50`) and there is no way to switch `form` ⇄ `session`, so the only route is
`remove-runner` + `add-runner`, which also drops depth, allowed areas and standing instructions.
Add `baseline config auth <runner> <form <loginUrl>|session>`, keeping everything else and
clearing the saved session (and the stored password when leaving `form`).

**Setup's summary hides the user's own risky words.** `describePermissions`
(`src/config/store.ts:63`) prints the first 6 of `[...words, ...urls]`. `patternsSchema` appends
user entries after the defaults (`src/config/schema.ts:41`), and every category already ships 6 or
more defaults, so a user's additions are always cut off — and step 11 of setup shows this output
as the final confirmation. List the user's own additions separately and never truncate them.

## 4. Portability

Already handled: `open`/`xdg-open`/`cmd` (`src/cli.ts:12`), `npm.cmd`, `/proc` with a `ps`
fallback (`src/browser/host.ts:59`), socket-path length for macOS's 104-byte limit (`:48`),
case folding for the script sandbox (`src/browser/runner-script.ts:94`). No GNU-only tools in
`scripts/`, `bin/` or `.githooks/`.

Gaps:
- **Case-sensitive comparison in the guards.** `isInside` compares exactly, so on a
  case-insensitive macOS volume `~/.Config/baseline` is not recognised as the data folder. This is
  a guard bypass on macOS, not a cosmetic issue.
- **Tests build expectations from `mkdtempSync(tmpdir())`** without realpath. On macOS `tmpdir()`
  is under `/var/folders/…`, a symlink to `/private/var/folders/…`, while the code under test calls
  `realPath`. Paths will not match.
- **CI runs `ubuntu-latest` only.** Nothing proves macOS works.

**Decisions.** Fold case in path comparison on `darwin` (and `win32`, which already folds in one
place). Realpath the temp roots in tests. Add a `macos-latest` leg to CI on one Node version.
(My calls.)

## 5. Left to the implementer

- Where the `authedCheck` prompt sits in setup's question order.
- The exact fixture set shipped for `s.fixture` beyond "a small image, a small video, a small PDF,
  a small CSV", and their sizes.
- Whether `baseline doctor` and `baseline timings` share one output renderer.
- Wording of every new message, within the house style: plain words, no jargon, say what to do next.
