# Baseline: open-source acceptance-testing plugin for Claude Code

Status: design, awaiting approval · 2026-10-22 · Author: John Chaplin (with Claude)

## 1. What it is, and why

Baseline is a Claude Code plugin that does a manual-style QA pass on a change. You point it at
something that says what should happen (a PR, issue, Jira or Linear ticket, spec, guide, bug
report, a file or pasted text) and a URL. It reads the code when it has it, sends agents through
the running site as the user's test accounts, and reports where **the spec, the code and the live
site** disagree. It also reports things that work but make no product sense.

Every finding is **advisory**. Baseline never passes or fails a change; the user decides.

**Why it exists.** One QA engineer cannot keep up with a team that ships many PRs a day. Most
issues that reach QA are easy to catch. Baseline lets the person who made the change (or a QA
engineer) catch those first, so human QA time goes on the hard-to-find issues.

**Who it is for.**
- Primary: QA engineers at any company, on any web product. It is open source.
- Secondary: developers on the author's team, running it on their own PR or task before it goes
  to QA. "Ready for QA" is the signal they are done.

**Prior art.** It generalises a private skill the author built for his employer ("acceptance-run",
`~/.claude/skills/acceptance-run/`). That skill stays separate and untouched. The new plugin may
borrow its *ideas and visual style*, never its content (see 4.1).

## 2. Goals, non-goals, anti-goals

**Goals**
- Works in any codebase and against any web app, with no product-specific code.
- Setup is the only manual step: install, be logged in to Claude Code, run setup, add test accounts.
- Cheap on tokens and easy to feed.
- Quick run on a single bug or PR in about 10 minutes; a full run on a large feature in about
  30 minutes or more.
- A report a developer can act on without asking anyone.
- **Low noise.** A short report of relevant findings beats a long one. (The private tool's
  multi-region runs produced many findings that were unrelated, not applicable, or
  misunderstandings of the product flow, while manual QA found only a few real issues.)
- Safe on other people's sites by default.

**Non-goals**
- It does not write or commit tests, e2e specs or code. It only reports.
- It is not a load, security or performance testing tool.
- No standalone CLI binary and no Anthropic API key. It runs inside Claude Code on the user's own
  Claude login.

**Anti-goals (failure even if it "works")**
- Anything employer-specific leaking into the public repo: names, URLs, accounts, workspace IDs,
  domain words, internal API endpoints, the private hub URL.
- Changing data on a live site or touching real users without explicit permission.
- Sending email, changing auth, deleting projects/users, or touching payments without explicit
  permission.
- Calling something a pass that it never actually saw on the site.
- Token-hungry runs: whole-repo sweeps, transcripts passed between agents, screenshots used for
  navigation.

## 3. Decisions made in conversation

### 3.1 Form and home
- **A Claude Code plugin**, installable with `/plugin install` from a public repo.
- Repo: **`baseline`** on the author's **personal GitHub account** (not the employer's org).
  Name: **Baseline**.
- It runs on each user's own Claude Code login. Agents run through Claude Code's own agent tooling.

### 3.2 Code is optional, recommended
- When run inside the product's repo, Baseline reads the code (the diff and what it calls) and the
  report has all three columns: Specced, Built, Observed.
- Without code (e.g. a QA engineer with no checkout), it tests the spec, guide, ticket or PR
  description against the live site. The Built column is omitted, verdicts that need code are not
  produced, and the report says clearly that code was not read.
- *My call:* with code, it records which commit it read and, where the site exposes one, the
  deployed commit. If they differ, the report says so, so version gaps aren't mistaken for bugs.

### 3.2a Inputs
One command takes whatever it is pointed at and works out the type. Inputs can be mixed ("this PR
plus this spec").
- GitHub PR or issue (link or number, via `gh`)
- **Jira tickets and Linear issues, day one.** Use the user's Jira/Linear connector if one is
  connected to Claude Code, otherwise an API token stored in setup.
- A file, a folder, or pasted text.
- It follows links inside a ticket to specs (Confluence, Notion, Google Docs, etc.) when it can reach
  them, and lists the ones it could not read.

### 3.3 Target site
- **Every run asks which URL to test.** The last one used is offered as the default. It can be
  staging, a preview deploy or localhost.
- A URL the user has marked as production in setup is refused unless the user explicitly asks
  for live testing on that run.

### 3.4 Setup (re-runnable)
`/baseline setup` can be run any time to add or change things. It covers:
- **Runners**: one per test account, with credentials, a persona name (e.g. "customer", "admin"),
  and a **depth level**. Users can add as many as they like.
- **Depth levels** (per runner):
  1. **Look only** (default): browse and read, never submit anything.
  2. **Create and tidy**: may create its own test objects, labelled with the run ID, edit them, and
     delete only what it created. Cleanup at the end of the run.
  3. **Full workflow**: may take its own test objects through every step of a flow.
- **Protected areas, off for every runner unless ticked:**
  - live sites and real users
  - sending email
  - auth and accounts (passwords, invites, roles, sign-up)
  - deleting projects or users
  - payments and finance
- For protected areas, setup asks the user to name them on *their* site: URL patterns, and button
  or link words ("Send invoice", "Delete user").
- Setup ends by showing a **plain list of what each runner can and cannot do**.
- Production URLs.
- Theme (BR2049, Light, Dark).
- *My call:* **Sign-in.** Form login with stored credentials, or for SSO/MFA/magic-link sites the
  user signs in by hand once during setup and the saved session is reused (setup re-run refreshes
  it).

Credentials and setup live outside the repo being tested, or in a gitignored file. They never go
into a report, log or screenshot caption.

### 3.5 Safety enforcement
- **Look only is a hard block in code**: any request that would change data is stopped in the
  browser layer. *My call, taken from the private skill:* GET is allowed; requests a page fires
  while it is simply loading are learned and allowed; setup adds sign-in and any read-only
  requests the site sends as POST (search, GraphQL queries) to an allowlist; any other non-GET is
  aborted. A wrongly blocked read is logged as **skipped**, never as a bug.
- **Protected areas** use two layers: code blocks what setup named, and agents are told to
  **never assume, always skip**. Anything that looks like a protected action is skipped and logged.
- The README states plainly that protected-area detection on an unknown site is best effort on top
  of the hard look-only block.
- Each run records the permissions it ran with; the report shows them.

### 3.6 Skipped actions and learning
- The report has a **Skipped** section: what was skipped, why, and which permission would allow it.
- At the end of the run, the plugin asks in the terminal whether to allow any of those for that
  runner next time, and saves the answer to setup. Permission changes happen only in the
  terminal on the user's machine, never from the hub.

### 3.6a Noise control
Relevance matters more than volume. A finding reaches the report only if it passes these:
- **In scope.** It ties to a requirement in the input, or to a screen or flow the change touches.
  Anything else is dropped, or kept in a collapsed "Other observations" list (*my call:* capped at 5).
- **Intent check.** Before a finding is kept, the refuter asks whether the product's own flow,
  copy, spec or code explains it as deliberate or out of reach for this persona (e.g. a role that
  can't see a page). Misunderstandings of the flow are dropped.
- **Evidence.** A conflict or product finding needs something seen on the site (screenshot or step
  log) or a cited line of code. No evidence means "unverified", never a bug.
- **Caps apply to unrelated findings only.** Product and unspecced findings that relate to the
  change are never capped. Anything unrelated goes in "Other observations", capped (*my call:* 5,
  ranked by severity); the rest are counted, not listed.
- **Dedupe.** The same issue seen by several personas is one finding listing those personas.
- *My call:* **Learning from dismissals.** `/baseline dismiss <finding> "<reason>"` records a
  not-applicable note about the site (e.g. "admins can't see billing by design"). Later runs read
  these notes so the same noise doesn't come back.

### 3.7 Run sizing and token efficiency
- The run sizes itself from its input and says so before starting ("quick run, 3 agents" /
  "full run, 7 agents"). The user can push it either way.
- **Quick run** (single bug/PR, ~10 min): a code reader on the changed files and what they call,
  one explorer per affected persona (usually one or two), a refuter on non-matches only.
- **Full run** (feature + spec + guide, ~30+ min): code reader, explorers per persona, guide
  reader, product-sense checks, refuter, cleanup.
- Ways to keep tokens down:
  - read the diff, not the repo
  - each agent writes a compact findings file, and the next phase reads that, not a transcript
  - explore with the page's accessibility tree, and take screenshots only as evidence
  - smaller models for mechanical work (gather, sign-in, cleanup), the stronger model for verdicts
    and the refuter
  - setup and earlier runs save a site map (routes, personas, where things live) that later runs
    reuse

### 3.8 Verdicts (carried from the private skill)
- **match**: spec, code and site agree (spec and site, when there is no code).
- **conflict** variants: spec ≠ built, built ≠ observed, not built, guide ≠ spec.
- **unspecced**: built/observed but not in the spec.
- **product**: works, but fails a product-sense check.
- **unverified**: code says yes, but the site was never seen doing it. Never reported as a match.
- **skipped**: blocked by permissions (3.6).
- A **refuter** agent re-checks every non-match before the report is written.
- The spec is the only oracle. No special pleading for "deliberate" states.
- A generic **product-sense checklist** ships with the plugin. For example: a greyed-out control
  says why, nothing clips, empty states explain themselves, errors say what to do, actions show a
  busy state. Users can extend it in setup.

### 3.9 Output
**While it runs** (in Claude Code): a header with the run size and agent count; one row per phase
(gather, read code, explore, verdicts, refute, clean up) showing done / in progress with a
progress bar / pending; one line per active agent saying what it's doing; elapsed time and counts
found so far. Approved mockup: "While it runs" in the session's `terminal-style.html` and
`dark-navy.html`.

**When it ends** (in Claude Code): **totals only, no bug titles.**
- pass rate (bar + %), number checked, number passed
- counts by verdict: conflicts, product, unverified, skipped
- result line: always **Complete** (findings are advisory; there is no pass/fail result)
- the hub link (and the local report path)

**The hub/report**: one page per run, with the author's existing hub layout ("option A").
Runs from the same Claude Code session stay together: if a user runs, pulls new work, and runs
again, the second run is added to the same page (a run switcher at the top, newest first). If
that turns out hard to do, fall back to one page per run. A new session starts a new page.
- case header: title, input reference, run ID, run size, duration, URL and commit
- the big count, a tally strip, per-persona rows
- the findings ledger, worst first, filterable by verdict and persona, with search
- each finding expands to Specced / Built / Observed columns with references (spec section,
  file:line, screenshot, repro steps), then the refuter's note and a copy action
- Skipped section and the run's permissions
- **Always written as a local self-contained HTML file.** Also published as a claude.ai artifact
  when the user's Claude Code can do so, with that link shown in the summary.

### 3.10 Look and themes
Three themes, the same in the terminal (colours only) and the hub. Default: BR2049.
- **BR2049**: the author's current hub look (worn terminal, phosphor green, dust orange, Michroma /
  IBM Plex, scanlines, glow, phosphor-wipe transitions).
- **Light**: the current hub's plain light theme.
- **Dark (navy, new)**: professional, not retro. No glow, scanlines or display font. Inter + IBM
  Plex Mono. Tokens from the approved mockup:
  `void #0b1220 · deck #111a2e · panel #16213a · rule #1f2b45 · rule-hi #2c3a5a · ink #e6ebf5 ·
  ink-2 #a9b4cb · ink-3 #6f7c98 · accent #7aa7ff · accent-dim #2a3f6b · conflict #f2777a ·
  amber #f5b25c · product #d58be8 · unverified #7c8aa6 · match #5fcf9f`

The terminal can't change fonts or show glow, so it matches colours and block characters only.

## 4. Constraints

### 4.1 No leakage
The builder may read the private skill (`~/.claude/skills/acceptance-run/`: `SKILL.md`,
`hub.html`, `lib/browser.cjs`, `lib/signin.cjs`, `qa-checklist.md`) **for structure, ideas and CSS
only**. Example data in docs and fixtures uses a made-up product (e.g. "Acme shop").
*My call:* the list of banned employer terms (names, domains, emails, IDs, domain vocabulary) lives
only on the author's machine, outside the repo, and a local pre-push hook scans every push against
it. Publishing the list would leak what it protects. Public CI runs only generic checks (no
emails, tokens or private URLs in the repo).

### 4.2 Platform limits
- A plugin cannot redraw or colour Claude Code's chat area, and cannot set the status line
  (checked against the plugin docs, 2026-10-22). The only live, themed surface is a **mod pane**
  (`hooks/hooks.json` `modules`, Claude Code v2.1.287+, interactive sessions only). So: the
  themed live progress and themed end summary render in the Baseline pane; the chat gets the same
  end summary as plain text. On older Claude Code, or in `-p`/SDK runs, progress is plain text
  phase updates in the chat. This is a sanctioned deviation from the mockups' "in Claude Code"
  framing; content and look are unchanged.
- Claude.ai artifact publishing is not available to every Claude Code user, which is why the
  local HTML file is always written.

## 5. Left to the builder
- Plugin layout (skills, commands, agents, hooks, scripts), language for the scripts, and the
  browser driver (Playwright is what the private skill uses).
- Exact command names beyond `/baseline <input>` and `/baseline setup`.
- File formats for setup, run data and the site map; where runs are stored (e.g. `.baseline/`,
  gitignored).
- The exact model split between agents.
- How the progress view is drawn, within 4.2.
- Packaging, versioning, licence (an open-source licence is expected), README and contributing
  docs.
