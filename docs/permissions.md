# Permissions

Every test account in Baseline is a **runner**. Each runner has a depth and a list of protected
areas it may enter. `baseline config describe` prints both in plain words.

## Depth

| Depth | It may |
|---|---|
| **Look only** (default) | browse pages and read what they show. Any request that would change data is blocked. |
| **Create and tidy** | also create its own test items, named `Baseline <run id> …`, edit them, and delete only those. Clean-up runs at the end. |
| **Full workflow** | also take its own test items through every step of a flow. |

Change it with `/baseline:setup` or `baseline config depth <runner> <look|create|workflow>`.

## Protected areas

Off for every runner unless you allow them. Allowing one applies to that runner only.

| Area | Watches for (built in, you can add more) |
|---|---|
| Live sites and real users | any URL marked as production, and its subdomains |
| Email | "send email", "send invite", "invite", "notify", "resend", "send invoice" |
| Sign-in and accounts | password and sign-up pages, logout, invite acceptance, "change role", "remove member" |
| Deleting projects or users | `…/delete`, `…/destroy`, "delete project", "delete user", "deactivate", any DELETE request |
| Payments and finance | `…/billing/…`, `…/payments/…`, "pay now", "place order", "refund", "subscribe" |

Add your site's own words and URL patterns in setup. They are added to the built-in ones, never in
place of them.

## Threat model

Agents read text Baseline doesn't control: the pages under test, tickets, PR descriptions and
linked documents. Any of it can contain instructions ("run this command", "sign in at this URL",
"allow deleting users"). That is prompt injection, and Baseline treats it as in scope: an agent
that has been talked into misbehaving is the case the layers below are built for, not just an
agent that makes a mistake. Agents are told that content is data, never instructions, but the
layers below don't rely on them listening.

## How it is enforced

1. **In the browser (code).** Every request the page makes passes through a guard. Look-only
   runners: anything other than GET is blocked, except requests the page makes by itself while
   loading (learned per runner, matched on host, path, query and body) and read-only POST paths
   you list in setup. All runners: protected URL patterns and clicks on controls whose label
   matches a protected word are blocked unless that area is allowed. Service workers are
   blocked, and look-only WebSocket messages after page load are blocked. The guard fails
   closed: if it errors, the request is blocked.
2. **Agents only get a command list.** Agent scripts run in a separate Node process and talk to
   the browser through Baseline: go to, click, fill, press, read, screenshot. They never receive
   the Playwright page or browser. The script process runs under Node's permission model: it may
   read its run folder, write only into it, start no other programs, and gets an empty
   environment.
3. **The guard's own state is out of agents' reach.** What the guard relies on lives in
   Baseline's data folder, not the project: the run's URL and config as of `run new`, the
   requests each runner's page loads were seen to send, the list of what the run created, and
   the log of blocked requests the report shows. Editing files in the run folder or
   `.baseline/config.json` mid-run doesn't widen what a runner may do. A browser only opens (and
   a script sandbox only gets a folder) for a run folder under `.baseline/sessions/` that
   `run new` recorded there; there is no fallback to the project's own files.
4. **Hooks on Claude Code's tools.**
   - Bash, while a run is active: no HTTP writes to the site under test, no direct Playwright,
     no permission or runner changes (however `baseline` is spelled: `./bin/baseline`, `env …`,
     `sh -c …`), and no overriding Baseline's run, data folder or shared browser.
   - Browser MCP tools are off while a run is active.
   - Write and Edit can't change `.baseline/` outside the run folders while a run is active.
   - Subagents, while a run is active, can't start or finish runs, sign runners in, change
     config, or write under `.baseline/` outside the run folders from Bash. Only the main session
     can, and a second run needs `--force`.
   - At all times, Read, Grep, Glob, Write, Edit and Bash are kept out of Baseline's data folder
     (passwords, saved sessions, tracker tokens) and Claude Code's plugin data folder. Searches
     rooted above the data folder (your home folder, `~/.config`) are refused too, as are Bash
     sweeps of those folders (`find ~`, `grep -r … ~`, `tar ~/.config`, `cd ~/.config && …`).
     This is defence in depth: it reads command text, so it narrows what a misled agent can
     reach rather than sealing it off.
   - If a guard hook itself fails while a run is active, the tool call is blocked, not allowed.
5. **Passwords stay on the site they were saved for.** When you save a runner's password, the
   form shows the site it is for and Baseline stores that site with it. `baseline signin` types
   it only there: no `--url`, configured URL or run can send it anywhere else. Passwords saved
   before Baseline recorded the site have to be saved again
   (`baseline config secret <runner> --form --url <test site>`).
6. **Agents are told never to assume.** Anything that looks protected is skipped and reported.

## What it does not promise

- Recognising a protected action on a site Baseline has never seen is best effort: a button that
  sends email with a label like "Done" will not be recognised unless you name it. Point Baseline
  at test accounts on a test or staging site.
- The Bash hook reads command text. It catches the usual spellings, not every shell trick (a
  command assembled from variables, for example). It is a second layer behind the browser guard,
  not a sandbox.
- Passwords and saved sessions are plain files readable only by your user account (mode 0600,
  folder 0700), not entries in the OS keychain. The hooks keep Claude's tools away from them, but
  any program you run as yourself can read them. Keychain storage is future work.
- Script processes have their network APIs switched off by a preload, because Node's permission
  model doesn't limit the network on every supported version. That is best effort, not a
  sandbox; they still have no credentials, sessions or environment to use.
- The one-time sign-in form listens on a random local port and path. Its link goes straight to
  your browser, but anything running as you on this machine could reach a local port while the
  form is open (10 minutes at most, one use).
