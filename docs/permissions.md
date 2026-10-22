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

## How it is enforced

1. **In the browser (code).** Every request the page makes passes through a guard. Look-only
   runners: anything other than GET is blocked, except requests the page makes by itself while
   loading (learned per runner, matched on host, path and body) and read-only POST paths you list
   in setup. All runners: protected URL patterns and clicks on controls whose label matches a
   protected word are blocked unless that area is allowed. Service workers are blocked, and
   look-only WebSocket messages after page load are blocked.
2. **Agents only get a command list.** Agent scripts run in a separate process and talk to the
   browser through Baseline: go to, click, fill, press, read, screenshot. They never receive the
   Playwright page or browser, so they cannot remove the guard by accident.
3. **A Bash hook** blocks HTTP writes to the site under test and direct Playwright use while a run
   is active.
4. **Agents are told never to assume.** Anything that looks protected is skipped and reported.

## What it does not promise

Recognising a protected action on a site Baseline has never seen is best effort: a button that
sends email with a label like "Done" will not be recognised unless you name it. Point Baseline at
test accounts on a test or staging site. A deliberately hostile script could read the saved
session file or use its own HTTP client; the guard is designed against accidents, not attacks.
