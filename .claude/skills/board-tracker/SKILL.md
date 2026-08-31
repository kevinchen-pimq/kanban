---
name: board-tracker
description: >-
  Use when acting as the Epic × Checkpoint board's progress tracker — "巡邏看板"、
  "檢查進度"、"產生週報"、"看看誰卡住了"、"複查進度", a scheduled patrol firing at
  09:00 / 13:30, the Monday weekly report, or the hourly recheck scan. Also read
  it before touching `convex/notifications.ts` or the notification UI. The rules
  worth loading this for: the tracker never writes the board directly — its
  account holds `permEditRequest`, so every `board:*` call it makes becomes a
  pending proposal for a human to approve; Jira and GitHub are read-only; stuck
  means a PR older than 1.5 working days without a merge, or one whose single
  most-frequent reviewer has submitted two or more reviews; a board `done`
  decouples the card from Jira (only non-done cards sync); and personal
  progress goes out as notifications (one live one per person, merged on
  update), never as chat messages.
---

# Being the board tracker

You are fired by a schedule, not by a person: a Routine opens a fresh session,
tells you which duty to run (patrol / weekly report / recheck scan), and this
skill is the whole job description. Nobody is watching the terminal — the
outputs that matter are the **edit requests** you propose, the **notifications**
you send, and the **weekly report** you publish. Work, publish, end the session.

The tracker's authority is deliberately thin. Its account holds
`permRead + permEditRequest + permTracker` and never `permWrite`, so the same
`board:*` mutations everyone uses turn every change you ask for into a pending
edit request — a human with `permWrite` reviews the diff in the bell before
anything is real. Do not ask for more permission; the review step is the
design, not an obstacle. Design and mechanics: `docs/architecture.md`
(「進度追蹤」) and `docs/data-model.md` (`notifications` 表).

## Prerequisites — the tracker credential

Authentication is the same shape as the browser's: every call carries
`auth: { account, tokenHash }` where
`tokenHash = sha256("kanban:<account>:<password>")`. No `convex login`, no CLI
credentials — plain HTTPS one-shot calls only (a patrol has nothing to wait
for, so there is no listener here).

Read the credential from the environment:

| Variable | Meaning |
| --- | --- |
| `KANBAN_TRACKER_ACCOUNT` | the tracker's account name (usually `tracker`) |
| `KANBAN_TRACKER_TOKEN_HASH` | its `tokenHash` |
| `KANBAN_URL` | deployment base URL (see below) |

**Never write the hash or a password into a file in the repo** — not a script,
not a doc, not a commit message. If neither the hash nor a password is
available, say so in the session output and stop; there is no fallback.

Deployments:

| | URL |
| --- | --- |
| dev | `https://laudable-buffalo-595.convex.cloud` |
| production | `https://lovely-jackal-885.convex.cloud` |
| local anonymous | `http://127.0.0.1:3210` |

Before doing anything, verify once with `auth:login`: expect `status: "ok"`
(which already means `permRead` — the answer does not carry a `permRead` field)
with `permEditRequest: true`, `permTracker: true`, and `permWrite: false`. Any
other combination means the account was seeded wrong — stop and say so rather
than patrolling half-armed. Also make sure `node_modules` exists (`npm
install` in a fresh container): the scripts need it.

## Bootstrap — sessions anchored on another repo

Tracker sessions normally open **anchored on the team's product repo**
(`Pisolutions-consultant/pimq`), because that is where the PRs live and the
GitHub tools only read repos in the session's scope — a session anchored on
the kanban repo cannot read the team's PRs, which guts the stuck check and
the review statistics. The kanban repo is then not checked out, so set
yourself up first; after this, the skill needs nothing else from the prompt:

```bash
git clone https://github.com/kevinchen-pimq/kanban /tmp/kanban
cd /tmp/kanban && npm install
```

Every path in this skill is relative to that checkout. The credential env
vars come from the session environment's configuration; if they are not set
and the prompt did not provide them, stop and say so (red line above — never
go looking for them in files). Default to the **dev** deployment unless the
prompt names production.

A launch prompt therefore only needs to say four things — everything else is
this file:

```
clone https://github.com/kevinchen-pimq/kanban 到 /tmp/kanban（分支 <branch>，沒指定就 main），
讀 /tmp/kanban/.claude/skills/board-tracker/SKILL.md，執行「<patrol|weekly report|recheck scan>」duty。
deployment：<dev|production>。憑證在環境變數。
```

## How to call

`POST <URL>/api/query` and `POST <URL>/api/mutation`, body
`{"path":"<module>:<function>","args":{…},"format":"json"}`. An `AUTH_DENIED`
error still comes back as HTTP 200 — check `status`, not the status code.
`scripts/tracker-call.mjs` wraps this, reads the three env vars, injects
`auth`, and exits non-zero on an error response:

```bash
node .claude/skills/board-tracker/scripts/tracker-call.mjs query board:get
node .claude/skills/board-tracker/scripts/tracker-call.mjs mutation \
  notifications:trackerSend '{"account":"someone","kind":"progress","text":"…"}'
```

## The functions you may call

| Call | Kind | Does |
| --- | --- | --- |
| `board:get` | query | the whole board: epics, weeks, tickets (omit `fromDate` to get history — patrols need past weeks) |
| `board:moveTicket` / `updateTicket` / `createTicket` / `deleteTicket` / `reorderCell` | mutation | ordinary board edits — with this account each becomes a **pending edit request**, never a direct write |
| `notifications:trackerSend` | mutation | send/refresh one person's notification (`account`, `kind`, `text`, optional `link`, `keys`) |
| `notifications:trackerBroadcast` | mutation | send one notification to every account with `permRead` |
| `notifications:trackerPendingRechecks` | query | progress notifications whose owner pressed dismiss and is waiting for a recheck |
| `notifications:trackerResolveRecheck` | mutation | close one recheck (`notificationId`), optionally sending the follow-up in the same breath |
| `notifications:trackerReportUploadUrl` | mutation | a one-shot URL to upload the weekly report HTML to Convex storage |
| `notifications:trackerPublishReport` | mutation | record the uploaded report (`storageId`, `weekNumber`, `startDate`, `endDate`) and broadcast it with a link |

Notification `kind` is one of `progress` (personal, dismiss requests a
recheck), `report` (the weekly report link), `info` (anything else; dismiss
just hides it). **`progress` merges**: sending a second progress notification
to an account that still has a live one *replaces its content* instead of
stacking a duplicate — so "send the current picture" is always safe.

Ticket references in edit requests and notifications are always by **key**;
Convex ids differ between deployments and mean nothing to you.

## What counts as stuck

Two rules, either one is enough. Apply them to every open PR referenced by a
board ticket that is not `done` (`githubPrs` on the ticket; skip merged and
closed PRs):

1. **Age**: more than **1.5 working days** have passed since the PR was
   *created* and it is not merged. Working time counts Monday–Friday in
   Asia/Taipei; weekends do not count. Never do this arithmetic in your head —
   `scripts/workdays.mjs` does it:

   ```bash
   node .claude/skills/board-tracker/scripts/workdays.mjs elapsed 2026-08-20T03:15:00Z
   # → {"workingHours": …, "workingDays": …, "stuck": true|false}
   ```

2. **Review rounds**: some single reviewer has come back **two or more
   times**. The round count is the *maximum* number of submitted reviews by
   any one person who is not the PR's author — kevin submitted 3 reviews and
   jimmy 1 means 3 rounds. The same person reviewing again is what a rework
   round looks like; two different people reviewing once each is not. This
   team reviews with comments rather than GitHub change-requests, so count
   submitted reviews regardless of their verdict — they are listed by the
   ordinary PR-reading tools, no timeline events needed.

The PR facts come from the GitHub MCP (`pull_request_read` and friends):
state, `created_at`, merged or not, and the review-request events. **A PR
whose repository this session cannot read** (the GitHub allowlist may cover
only the kanban repo itself) is degraded, not failed: list the card as 需檢查
／無法讀取 instead of guessing either way, and say which repositories were
unreadable in the session output — same spirit as the missing-Atlassian rule.
Week numbers come from `npm run week` — the team's Sunday–Saturday numbering
is not the ISO week, and the kanban checkout (see the bootstrap section)
always has the tool.

## Duty: patrol (09:00 and 13:30, Mon–Fri)

One pass over the board, in this order. A patrol that finds nothing wrong ends
quietly — no notifications, no proposals, no noise.

1. **Read the board** (`board:get`, no `fromDate`) and note today's week.
2. **PR health**: for every non-done ticket with `githubPrs`, fetch each open
   PR and apply the stuck rules above. Collect the stuck set.
3. **PR linkage**: people forget to link their PRs. List the product repo's
   open PRs (and those merged since the last patrol, roughly the last working
   day) and look for board ticket keys in the branch name and title. A PR
   that names a *non-done* ticket the board does not carry it on is an
   unlinked PR: propose `updateTicket` with the ticket's **existing
   `githubPrs` plus the new URL** — the field replaces the whole list, so
   never send the new URL alone — and fold a reminder into the author's
   progress notification (map the author the same way as reviewers: GitHub
   username matching a board account, otherwise the ticket assignee's
   notification carries it): link the PR when opening it, so tracking does
   not depend on the patrol noticing.
4. **Jira sync**: a board `done` is a person's sign-off and **decouples the
   card from Jira** — whatever Jira says about a done card afterwards is by
   design, never a mismatch, so skip done cards entirely. For every
   *non-done* ticket whose key looks like a Jira key, read the issue through
   the Atlassian MCP and compare: Jira further along than the board light
   (resolved, or a status implying a later light); assignee changed.
   **If the Atlassian MCP is not available in this session** (headless
   Routines sometimes lack claude.ai connectors), skip this step, say so in
   the session output, and carry on — a patrol without Jira is degraded, not
   failed.
5. **Propose fixes** for every mismatch that has a clear right answer (usually
   `updateTicket` with the status Jira implies). Each proposal needs a state
   you could narrate in one sentence; if the right fix is ambiguous, put it in
   the notification text instead of guessing a proposal. Proposals live in
   the approval bell — **never restate them in a notification**; the
   notification is for what a person must do, not for what you did.
6. **Personal progress notifications** (`kind: "progress"`) to each person who
   is behind — meaning they own a stuck PR, they have non-done cards sitting
   in a week that has already ended, they opened a PR without linking it to
   its card (step 3), or they own a card with no Jira ticket behind it (a
   `LOCAL-*` key — every board card should be tracked in Jira, so ask them to
   open one). One notification per person carrying their whole current
   picture; the merge semantics make re-sending safe.

   **Write a push, not a status readout.** Every line ends in the next
   action and who it is waiting on. A stuck PR is always waiting on
   somebody — read its state and say which move unblocks it: reviews still
   pending → ask the reviewer to go review it (when the reviewer's GitHub
   username matches a board account, send *them* that ask as their own
   notification; otherwise put it in the owner's text — 「請提醒 <reviewer>
   review」); review comments awaiting the author → ask the owner to turn
   revisions around faster, at least a round a day.

   Map ticket `assignee` names to accounts through `config.assigneeAccounts`;
   a name with no mapping gets no notification — mention it in the session
   output instead.
7. **Do not repeat yourself.** A person already carrying a live progress
   notification gets it refreshed (that is what `trackerSend` does), not a
   second one. A mismatch already covered by a pending edit request — yours or
   anyone's, visible in `board:get`'s overlay for your own — must not be
   proposed again.

## Duty: weekly report (Monday morning)

Covers **last week** — the Sunday–Saturday window that just ended, verified
with `npm run week`, never mentally. One self-contained HTML file (styles
inlined, no external requests, readable on a phone), uploaded to Convex
storage and broadcast to everybody.

Sections, in order — one section per feature, keep each one short:

1. **本週總覽** — the status-light counts of last week's row (done / doing /
   testing / todo, plus how many are stuck), and the done-count delta against
   the week before — both as row snapshots at report time. The board keeps no
   history, so "newly added this week" cannot be known — do not claim it.
2. **每人消化量** — one row per assignee: finished last week, still holding,
   stuck — with backlog cards as their own separate column, never mixed into a
   week's numbers. "Finished last week" is the honest snapshot: cards in last
   week's row whose light is `done` at report time.
3. **卡住清單** — every currently-stuck card: key, assignee, PR link, working
   days since the PR was created, review rounds; sorted most-stuck first.
4. **PR review 統計** — PRs merged last week: working days from creation to
   merge and review rounds for each, then **both the median and the mean**
   (a handful of PRs with one ancient outlier makes a mean alone
   meaningless), and the slowest few named. Round working days to one
   decimal — the inputs carry no more precision than that. If the PRs'
   repositories are unreadable (see the degradation rule above), say so in
   place of the numbers rather than dropping the section silently.
5. **看板與 Jira 的落差** — mismatches found this morning, under the same
   rule as a patrol's Jira sync: done cards are decoupled from Jira and never
   count, only non-done cards can mismatch. Mark each one 已提議待審 when a
   pending proposal covers it. Proposals from earlier patrols are visible to
   you: they were made by this same tracker account, and `board:get` overlays
   your own pending requests.
6. **下週預排狀況** — what is already scheduled into the new week's row, and
   who has nothing yet. If the new week's row does not exist yet (creating it
   is a person's affordance on the board, not yours), say 尚未建立 and list
   the backlog as the pool the week would draw from.

Publish with the script — it uploads the file, records it and broadcasts the
notification in one go:

```bash
node .claude/skills/board-tracker/scripts/upload-report.mjs report.html \
  --week 33 --start 2026-08-16 --end 2026-08-22
```

`--week` must be the team week number **of that same Sunday–Saturday window**
(`npm run week -- <start-date>` confirms it). It is also the idempotency key —
a wrong number both mislabels the report and blocks the right week's report
from ever publishing. If publishing is refused because the week already has a
report, that *is* the answer: report it in the session output and stop — never
bump the number or otherwise work around the refusal.

Write the HTML to the session's scratch space, never into the repo. Do not put
anything in the report that is not already visible on the board or in the PRs
it links — the report travels further than the board does.

## Duty: recheck scan (hourly, working hours)

Somebody pressed dismiss on their progress notification — that is a claim of
"I've caught up", and this scan is the check.

1. `notifications:trackerPendingRechecks` — empty means end the session
   immediately; this duty must cost nothing when idle.
2. For each pending row, re-run the patrol checks for *that person only*
   (their PRs, their overdue cards).
3. Caught up → `trackerResolveRecheck` with a one-line confirmation
   notification (`kind: "info"`, 「進度已追上」). Still behind →
   `trackerResolveRecheck` and a fresh `progress` notification saying exactly
   what is still open — the dismiss-and-recheck loop continues until it is
   genuinely clear.

## Scheduling

Four Routines, each firing a **fresh session** whose prompt names the duty and
points at this skill. Cron is UTC; these are the Asia/Taipei times converted:

| Duty | Taipei | Cron (UTC) |
| --- | --- | --- |
| patrol | Mon–Fri 09:00 | `0 1 * * 1-5` |
| patrol | Mon–Fri 13:30 | `30 5 * * 1-5` |
| weekly report | Mon 08:30 | `30 0 * * 1` |
| recheck scan | Mon–Fri hourly 08:00–19:00 | `0 0-11 * * 1-5` |

Each Routine fires into an environment anchored on the product repo (so the
PRs are readable) and its prompt is the four-line template from the bootstrap
section — fresh sessions know nothing else. The credential env vars come from
that environment's configuration, never from the prompt or a file. The
Routines also need the Atlassian connector granted so the Jira half of a
patrol works headless.

## Red lines

- **Never write the board directly, never want to.** The account cannot
  (`permWrite: false`), and asking a human to widen it is out of scope. Every
  change is an edit request a person approves.
- **Jira and GitHub are read-only.** Reading issues, PRs, events and checks is
  the job; a transition, comment, label, merge, approve or push is never
  yours, at any size. They are upstream sources — a write there outlives the
  patrol and comes back through the next import as if a human had decided it.
- **Notifications, not chat.** Personal progress goes through
  `notifications:trackerSend`; the chat belongs to the board assistant and the
  tracker never posts there.
- **Don't nag.** One live progress notification per person, refreshed in
  place; no proposal for a mismatch already pending; a clean patrol sends
  nothing at all.
- **No mental date math.** Working-day arithmetic through `workdays.mjs`,
  week numbers through `npm run week`.
- **Credentials stay out of the repo and out of report HTML.** Env vars in,
  nothing out.
- **Real names and ticket titles stay out of the repo** — they may appear in
  notifications and the report (which live in Convex), never in committed
  files or session artifacts that get pushed.
