---
name: run
description: Run a Baseline acceptance check. Point it at a PR, issue, Jira or Linear ticket, spec, guide, file, folder or pasted text, and a URL. It reads the code if there is any, walks the site as your test accounts, and reports where the spec, the code and the site disagree, plus product-sense problems. Every finding is advisory.
argument-hint: <PR | issue | ticket | file | folder | "text"> [--live] [--pr | --quick | --full]
allowed-tools: Bash(baseline:*) Bash(git diff:*) Bash(git log:*) Bash(git show:*) Read Write(.baseline/**) Glob Grep
---

# Baseline run

Inputs: $ARGUMENTS

You orchestrate one acceptance run. Agents do the reading and exploring; you plan, join their
results and write the verdicts. Use `baseline` (on PATH) for every mechanical step. Keep your own
messages short: the band above the prompt shows progress, and the report holds the detail.

## Rules that are never relaxed

1. **Report only.** Never edit, create or commit files in the project, except inside `.baseline/`.
2. **The spec is the oracle.** Write the requirements from the inputs before anyone looks at the
   site, and never rewrite them to fit what was seen.
3. **Never assume.** A step that looks like it could send email, change sign-in or accounts,
   delete a project or user, take payment or touch real users is skipped unless that runner is
   allowed it. Skipped is reported as skipped, never as broken.
4. **The browser is only driven through `baseline script`.** It carries the safety guard.
5. **Evidence or it did not happen.** A finding needs something seen on the site or a cited line
   of code. Code alone never makes a `match`: that is `unverified`.
6. **Every finding is advisory.** The run ends with result `Complete`. Never say pass or fail.
7. **Always close the run.** Once `baseline run new` has run, any stop (an error, no runner
   signed in, the user cancels) ends with `baseline progress done` and `baseline run finish`, so
   the guards switch off.
8. **Permissions never change during a run.** Only two places may change them, both after
   `run finish` and only with the user's answer: the reach check (step 1.6), which restarts the
   run, and step 7.

## 0. Preflight

1. `baseline config describe`. If there are no runners, stop and tell the user to run
   `/baseline:setup` first. Note each runner's **standing instructions**: things the user
   already decided about what that account may do ("may submit, never pay", "only in the test
   workspace"). Also look through this conversation and your project memory for any such
   instruction about test accounts that isn't saved yet, and save it now with
   `baseline config note <runner> "<their words>"`, so the user never has to say it twice.
   Standing instructions are followed on every run and never asked about again; only the user
   can change one (`baseline config note <runner> --clear [n]`). A note only narrows or explains
   what a runner does ("never pay", "test workspace only"): it never grants a permission. Grants
   (`allow`, `depth`) persist on their own once the user has said yes.
2. Ask which URL to test with AskUserQuestion. Offer the saved `lastUrl` (from
   `baseline config show`) as the first option, labelled "(last used)", plus "Another URL".
   Then `baseline config set lastUrl <url>`.
3. `baseline target-check <url>` (add `--live` only if the user passed `--live`). If it refuses,
   stop and tell the user why, in one line.
4. `baseline run new --url <url> --label "<short name of what is being checked>" --session ${CLAUDE_SESSION_ID}`
   (add `--live` only if the user passed `--live`). Keep `runDir` and `sessionDir` from its JSON.
   On a live run, name any runner that is not allowed `live` in `baseline config describe`: the
   guard will block everything it does, so leave it out and say so in one line.
5. Sign in: start `baseline signin --all --url <url>` (add `--live` if the user passed `--live`)
   with Bash `run_in_background`, so it signs in while step 1 gathers. It only touches the
   runners' saved sessions, which nothing in step 1 reads. Check its result before step 2: a
   runner that fails is left out of the run; say which, and why, in one line. If none sign in,
   close the run (rule 7) and stop, unless the run is code-only (step 1.5), which needs no browser.

## 1. Gather and plan

1. `baseline progress phase gather active`. Every active phase's bar moves on its own by
   estimated time; the `<pct>` milestones below jump it forward to the real position.
2. Jira or Linear tickets: if this session has a Jira or Linear connector, fetch each ticket
   yourself with it and save it as `<runDir>/linked/ticket-<KEY>.md` (title on the first line,
   then the description). Pass those files to the gatherer in place of the keys. Without a
   connector, pass the keys and the CLI uses the token from `/plugin configure baseline`.
   Then dispatch the **gatherer** agent with the run folder and the inputs. If it reports an ambiguous
   key, ask the user Jira or Linear with AskUserQuestion, then have it rerun
   `baseline inputs --run <runDir> --as <kind> ...`. When it returns:
   `baseline progress phase gather active 50`.
3. Read `<runDir>/inputs.json` and `<runDir>/linked/`. Write `<runDir>/requirements.json`:
   `[{ "id": "R-01", "text": "one testable statement", "source": "where it came from", "personas": ["..."] }]`.
   Requirements come only from what the inputs say. A bug report becomes "the bug no longer
   happens" plus the expected behaviour it describes. Then `baseline progress phase gather active 70`.
4. `baseline commit --out <runDir>/commit.json`. If `codeRead` is false, there is no code reader this
   run. If `mismatch` is true, tell the user in one line that the site runs a different commit.
   Then `baseline progress phase gather active 85`.
5. Pick the personas each requirement affects from the runners. Send a persona only when the
   change can look or behave differently for it. Check, in this order:
   - the inputs name that persona or role ("admins can...", "customers see...");
   - the changed code checks roles or permissions (`role`, `isAdmin`, `permission`, `can(`,
     `policy`, guards, feature flags by plan or org): look with `git diff` or Grep on the changed
     files only;
   - the change sits on a screen or route only that persona reaches.
   One persona is the default. Add a second only when one of these checks says the other persona
   sees something different. If the code checks roles but you can't tell which way, send both:
   a missed role is worse than a slower run. Note why in the persona list you keep.
   Then `baseline size --personas <comma list>` (add `--guide` if a guide is among the inputs).
   Respect `--pr`, `--quick` or `--full` if the user gave one.
   **Code-only:** if `codeOnly` is true, also read the requirements: if none of them describe
   something a user would see or do on the site (a refactor, a test, a backend job, a fix whose
   only effect is in logs or data shape), the run is code-only: no explorers, `explore` is
   `skipped`, and every requirement the code matches ends `unverified`. If any requirement is
   visible on the site, or you are unsure, explore as normal.
   Say in one line: "PR run, N agents" (add "code only" when it is), "Quick run, N agents" or
   "Full run, N agents", then carry on without waiting.
6. **Setup plan and reach check, before any agent runs.** For each requirement, write down the
   setup it needs to be checkable: the data that must exist (an order with a discounted item and
   a full-price one, gift wrap, the spec's acceptance example item for item) and every step to
   get it there and see it (create the order, add the items, submit it, go to checkout). Runners
   always build this on records they create, never on an existing record someone else made, so
   plan for create-and-delete; the cleaner removes it at the end. Then ask whether any of those steps
   needs an action the chosen runners can't do: a category in their `cannot` list (finance,
   email, auth, delete), or any write when their depth is `look` (creating the record counts).
   Pressing a button that starts a payment, sends an invite, submits work or saves a form
   counts, even when the thing to check is only on the page after it. Read each runner's `can`
   and `cannot` from `baseline config describe`.
   If the requirements this change is about (the bug it fixes, the headline behaviour) can only
   be seen past such an action, do not run on and report them skipped: that run tests nothing
   the change is about. Stop and ask with AskUserQuestion, naming the action and the runner,
   for example "The fix only shows on the payment page, which needs 'Pay now' (finance).
   customer is look only." Offer:
   - **"Allow <runner>: <category> and restart (Recommended)"**: `baseline progress done`,
     `baseline run finish`, then, in a separate Bash call (the guard reads the whole command
     before any of it runs, so chaining it after `run finish` is refused),
     `baseline config allow <runner> <category>` (for any write at depth `look`, also
     `baseline config depth <runner> create`). If the user narrows the grant ("open the payment page
     but don't pay"), save it with `baseline config note <runner> "<their words>"` in the same
     separate call, and pass it to the explorer word for word. Start a new run (step 0.4, same
     URL and label), copy `inputs.json`, `linked/`, `requirements.json` and `commit.json` from
     the old run folder into the new one, delete the old run folder (it is inside `.baseline/`
     and never reached the site), and carry on from step 1.5 with the new `runDir`.
   - **"Stop the run"**: `baseline progress done`, `baseline run finish`, delete the run folder,
     and tell the user in one line what the run would need.
   - **"Run anyway"**: carry on. Those requirements end `skipped` and the summary says the
     change itself was not seen.
   A step the runner's saved permissions already allow is not blocked: don't ask again, and
   follow its standing instructions while doing it. A note never stands in for a permission: if
   the runner lacks one, ask (quoting the note helps the user say yes in one click).
   Ask once per run, covering every blocked step in one question, setup steps included: name
   each one ("create an order, add gift wrap, submit it, then open the payment page"). Requirements that are only
   partly affected (a side screen, an edge case) don't trigger it: they end `skipped` as usual.
7. `baseline progress start <pr|quick|full> <agents>` and `baseline progress phase gather done`.

## 2. Read code and explore (agents in parallel, one message)

`baseline progress phase read-code active` (or `skipped` with no code) and
`baseline progress phase explore active`. Then dispatch, all in ONE message:

- **code-reader** (if `codeRead`): the run folder, the changed files (`changedFiles` in
  `inputs.json`, or `git diff --name-only` against the base branch).
- **explorer**, one per runner in the size plan (max 2 pr and quick, 4 full, none code-only): its
  runner key, persona, depth and the `can` / `cannot` lists from `baseline config describe`, the
  setup plan from step 1.6, the runner's standing instructions and any limit the user put on a
  grant (word for word), the
  run folder, the run id, the run size, and the product checklist at
  `${CLAUDE_PLUGIN_ROOT}/checklists/product.md` plus any `checklistExtra` from the config.
- **guide-reader** (full runs with a guide).

The code-reader reports its own `read-code` percentage as it works. As each explorer returns,
update the explore percentage (`baseline progress phase explore active <pct>`, explorers back
out of explorers sent).

**An explorer that comes back `BLOCKED:` pauses the run, it never ends it.** Read its
`explore/<runner>/blocker.json`, look at the screenshot, and ask the user right away with
AskUserQuestion: name the step and quote what the site said, then offer the explorer's options
(best first), plus "Finish with these skipped" last. Then:
- an option the runner may already do: send the explorer the user's answer with SendMessage,
  and it carries on from the same page (its browser is still open);
- an option the user does themselves (add a balance, fix data): wait for them to say it's done,
  then resume the explorer the same way;
- a missing permission: say the run must close to change it, and on yes close it, grant it
  (separate Bash call), and restart from step 1.5 as in the reach check.
Only "Finish with these skipped" lets those requirements end `skipped`. Never finish a run on
its own because a step on the main path was blocked.
When all explorers are back and nothing is blocked, mark `read-code` and `explore` done.

## 3. Verdicts

`baseline progress phase verdicts active`. Once every result is read, before writing the file,
`baseline progress phase verdicts active 50`. Join requirements, `code.json`, every
`explore-<runner>.json` and `guide.json` by id into `<runDir>/findings.draft.json`, in this shape:

```json
[{ "id": "R-01", "title": "Short, specific", "verdict": "...", "severity": "critical|high|medium|low",
   "personas": ["customer"], "scope": "related|unrelated", "route": "/cart",
   "specced": { "text": "what the spec says", "ref": "where" },
   "built": { "text": "what the code does", "ref": "file:line" },
   "observed": { "text": "what the site did", "shots": ["shots/x.jpg"], "steps": ["..."] },
   "checklistItem": "U-01" }]
```

| Situation | verdict |
|---|---|
| code `missing` and the site can't do it | `not-built` |
| code `differs` from the spec | `spec-built` |
| code `matches`, site `differs` or `broken` | `built-observed` |
| spec, code and site agree, the guide says otherwise | `guide-spec` |
| an explorer `U-` item no requirement covers | `unspecced` (or `product` if it fails a checklist item) |
| an explorer result `skipped` (a permission stopped it, or the explorer held back on purpose) | `skipped`, with `observed.text` naming the permission that would allow it |
| code `matches` but the site never showed it (not reachable, no runner for that persona) | `unverified` |
| everything agrees, seen on the site | `match` |

Copy each explorer item's `observed.shots` across as-is. If an explorer left them out, look in
`<runDir>/shots.json` for that runner's captions and attach the matching files.

Severity: `critical` for money, data loss, or someone seeing or changing what they should not;
`high` for a core flow that is broken; otherwise `medium` or `low`. Mark `scope: unrelated` for
anything outside the screens and requirements this change is about.

## 4. Refute

`baseline progress phase refute active`. Dispatch the **refuter** with the run folder and the run
size. On a PR run, dispatch it with `model: "sonnet"`. If every finding is a `match`, skip the
refuter and mark `refute skipped`: there is nothing to disprove. Then apply
`refuted.json`: set each finding's `refuter` to `{ "kept", "note" }`, apply any corrected `scope`
or `verdict`, and write the result to `<runDir>/findings.json`. Do not filter here:
`baseline report` drops what the refuter did not keep, caps unrelated findings and merges duplicates.

## 5. Clean up

If `<runDir>/created.json` has entries: `baseline progress phase clean-up active`, dispatch the
**cleaner**, then mark it done. Otherwise mark `clean-up skipped`.

## 6. Report

1. `baseline progress done`, then `baseline report <sessionDir> --open`. It writes the report,
   opens it in the user's browser, and prints its path. The local page is the report: it works
   offline, with every filter, theme and screenshot.
2. Publishing: if `publish` is true in `baseline config show` and the Artifact tool is
   available, publish the report as a private artifact. On a `--live` run, ask first with
   AskUserQuestion, because the report holds data from the live site. If
   `<sessionDir>/artifact-url` exists, publish to that URL so this session's runs stay on one
   page; otherwise publish a new artifact and save its URL there. Otherwise, or if publishing
   fails, give the local path.
3. `baseline summary <runDir> --plain --link <artifact url, if any>` and show its output as-is in
   a code block. No finding titles in your message: the detail is in the report.
4. `baseline run finish`.

## 7. Skipped actions

Read `<runDir>/blocked.json`. If anything was skipped, group it by runner and category and ask
the user with AskUserQuestion (multi-select) which of these the runner may do next time, for
example "customer: send email (3 skipped)". For each one they choose, run
`baseline config allow <runner> <category>`. For `unknown-write`, offer
`baseline config depth <runner> create` instead. Never change permissions without that answer.

Finish with one line telling the user that `/baseline:dismiss <id> "<why>"` marks a finding as
not applicable so later runs skip it.
