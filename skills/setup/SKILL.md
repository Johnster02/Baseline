---
name: setup
description: Set up or change Baseline for this project. Installs the browser once, then adds test accounts (runners), how far each may go, which areas are protected, production URLs and the theme. Safe to re-run any time to add runners or change permissions.
allowed-tools: Bash(baseline:*) Read
---

# Baseline setup

Talk to the user in plain words, one question at a time, with AskUserQuestion where there are
choices. Re-running setup edits what is there; it never starts over.

1. **Browser.** If `baseline install-browser` has not been run on this machine (check whether
   `baseline signin` complains that Playwright is missing, or just run it), run
   `baseline install-browser`. It installs Playwright and Chromium into the plugin's own data
   folder, once.
2. **Show what exists:** `baseline config describe`.
3. **Runners.** Ask "Add a test account?" For each one:
   - a short key (lowercase, like `customer` or `admin`) and the persona it plays;
   - how it signs in: **with an email and password** (ask for the sign-in page path, e.g.
     `/login`) or **by hand once** (for SSO, MFA or magic links);
   - `baseline config add-runner <key> <persona> form <loginPath>` or `... session`;
   - for a password runner, run `baseline config secret <key> --form --url <test site URL>`. It
     opens a one-time form in the user's browser, and the details go straight to a private file.
     They are only ever typed on that site, so use the site the user is testing (the form shows it). **Never ask for a
     password in the chat, and never put one in a command.** If the user types one into the chat
     anyway, don't repeat it: tell them it was not saved and to use the form;
   - **depth**, explained plainly: **Look only** (default: browses and reads, never submits
     anything), **Create and tidy** (may create its own test items labelled with the run id, and
     delete only those), **Full workflow** (may take its own test items through every step).
     `baseline config depth <key> <look|create|workflow>`;
   - **how Baseline can tell this account is signed in.** Ask for one page only a signed-in user
     can see (a path like `/account` or `/dashboard`) and one word or button on it that a
     signed-out visitor never gets (their email, "Sign out", "My orders").
     `baseline config set-authed-check <key> <path> --text "<word>"` (or `--role button --name
     "<label>"`). Say why plainly: most sites show their home page to everyone, so without this
     Baseline can only say a sign-in did not obviously fail — it cannot prove it worked, and a
     run can start with an account that is quietly signed out. If they skip it, carry on; every
     sign-in result for that runner will say it could not be proved.
   - **protected areas**, all off unless they say so, multi-select: test a live site or real
     users, send email, change sign-in or accounts, delete projects or users, payments and
     finance. `baseline config allow <key> <live|email|auth|delete|finance>` for each one ticked.
4. **Name the protected areas on this site.** Explain that Baseline already watches for common
   words ("send invoice", "delete user", "pay now"...). Ask for any URL patterns or button words
   on their site that send email, change accounts, delete things or touch money. Add them with
   `baseline config set patterns '{"email":{"words":["…"],"urls":["/notify/**"]}}'`. New entries
   are added to what is saved and to the defaults; nothing is removed. The same goes for
   `readPosts` and `productionUrls`. To replace a list on purpose, add `--replace`.
5. **Read-only POSTs.** Ask whether the site does searches or reads with POST requests (GraphQL
   queries, search endpoints). Add their paths with `baseline config set readPosts '["/api/search"]'`
   so look-only runners can use them. GraphQL mutations to those paths stay blocked.
6. **Production.** Ask for the live site's URL(s): `baseline config set productionUrls '["https://…"]'`.
   Runs refuse these unless someone asks for a live run.
7. **Version (optional).** If the site shows its deployed commit somewhere (a /version endpoint),
   set `baseline config set versionProbe '{"url":"https://staging…/version","pattern":"\"commit\":\"([0-9a-f]+)\""}'`.
8. **Theme:** BR2049 (default), Light or Dark. `baseline config set theme <br2049|light|dark>`.
   **Report link:** ask whether to publish reports as private claude.ai artifacts (a shareable
   link) or keep them as local files only. `baseline config set publish true` or `false`.
9. **Trackers.** If they use Jira or Linear and have no connector for it, tell them to add the URL
   and token with `/plugin configure baseline` (stored in their system's secure store).
10. **Sign in now:** ask for the test URL, check it with `baseline target-check <url>` (if it is
    refused as production, say so and ask for a test or staging URL instead), then
    `baseline signin --all --url <url>`. A runner that
    signs in by hand: `baseline signin <key> --manual --url <url>` opens a browser window; they
    sign in and close it.
11. **Finish** with `baseline config describe`, shown as-is: the plain list of what each runner
    can and cannot do. Tell them to run `/baseline:run <PR, ticket or spec>` next.
