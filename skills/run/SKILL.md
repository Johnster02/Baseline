---
name: run
description: Run a Baseline acceptance check. Point it at a PR, issue, Jira or Linear ticket, spec, guide, file, folder or pasted text, and a URL. It reads the code if there is any, walks the site as your test accounts, and reports where the spec, the code and the site disagree, plus product-sense problems. Every finding is advisory.
argument-hint: <PR | issue | ticket | file | folder | "text"> [--live] [--quick | --full]
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
8. **Permissions never change during a run.** Only step 7, after `run finish`, may change them,
   and only with the user's answer.

## 0. Preflight

1. `baseline config describe`. If there are no runners, stop and tell the user to run
   `/baseline:setup` first.
2. Ask which URL to test with AskUserQuestion. Offer the saved `lastUrl` (from
   `baseline config show`) as the first option, labelled "(last used)", plus "Another URL".
   Then `baseline config set lastUrl <url>`.
3. `baseline target-check <url>` (add `--live` only if the user passed `--live`). If it refuses,
   stop and tell the user why, in one line.
4. `baseline run new --url <url> --label "<short name of what is being checked>" --session ${CLAUDE_SESSION_ID}`.
   Keep `runDir` and `sessionDir` from its JSON.
5. Sign in: `baseline signin --all --url <url>` (add `--live` if the user passed `--live`). A
   runner that fails is left out of the run; say which, and why, in one line. If none sign in,
   close the run (rule 7) and stop.

## 1. Gather and plan

1. `baseline progress phase gather active`
2. Dispatch the **gatherer** agent with the run folder and the inputs. If it reports an ambiguous
   key, ask the user Jira or Linear with AskUserQuestion, then have it rerun
   `baseline inputs --run <runDir> --as <kind> ...`.
3. Read `<runDir>/inputs.json` and `<runDir>/linked/`. Write `<runDir>/requirements.json`:
   `[{ "id": "R-01", "text": "one testable statement", "source": "where it came from", "personas": ["..."] }]`.
   Requirements come only from what the inputs say. A bug report becomes "the bug no longer
   happens" plus the expected behaviour it describes.
4. `baseline commit --out <runDir>/commit.json`. If `codeRead` is false, there is no code reader this
   run. If `mismatch` is true, tell the user in one line that the site runs a different commit.
5. Pick the personas each requirement affects from the runners. Then
   `baseline size --personas <comma list>` (add `--guide` if a guide is among the inputs). Respect
   `--quick` or `--full` if the user gave one. Say in one line: "Quick run, N agents" or
   "Full run, N agents", then carry on without waiting.
6. `baseline progress start <quick|full> <agents>` and `baseline progress phase gather done`.

## 2. Read code and explore (agents in parallel, one message)

`baseline progress phase read-code active` (or `skipped` with no code) and
`baseline progress phase explore active`. Then dispatch, all in ONE message:

- **code-reader** (if `codeRead`): the run folder, the changed files (`changedFiles` in
  `inputs.json`, or `git diff --name-only` against the base branch).
- **explorer**, one per runner in the size plan (max 2 quick, 4 full): its runner key, persona,
  depth and the `can` / `cannot` lists from `baseline config describe`, the run folder, the run
  id, and the product checklist at `${CLAUDE_PLUGIN_ROOT}/checklists/product.md` plus any
  `checklistExtra` from the config.
- **guide-reader** (full runs with a guide).

As each agent returns, update the phase percentage (`baseline progress phase explore active <pct>`).
When all are back, mark `read-code` and `explore` done.

## 3. Verdicts

`baseline progress phase verdicts active`. Join requirements, `code.json`, every
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
| code `matches` but the site never showed it (not reachable, skipped, no runner) | `unverified` |
| everything agrees, seen on the site | `match` |

Severity: `critical` for money, data loss, or someone seeing or changing what they should not;
`high` for a core flow that is broken; otherwise `medium` or `low`. Mark `scope: unrelated` for
anything outside the screens and requirements this change is about.

## 4. Refute

`baseline progress phase refute active`. Dispatch the **refuter** with the run folder. Then apply
`refuted.json`: set each finding's `refuter` to `{ "kept", "note" }`, apply any corrected `scope`
or `verdict`, and write the result to `<runDir>/findings.json`. Do not filter here:
`baseline report` drops what the refuter did not keep, caps unrelated findings and merges duplicates.

## 5. Clean up

If `<runDir>/created.json` has entries: `baseline progress phase clean-up active`, dispatch the
**cleaner**, then mark it done. Otherwise mark `clean-up skipped`.

## 6. Report

1. `baseline progress done`, then `baseline report <sessionDir>`. It prints the report path.
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
