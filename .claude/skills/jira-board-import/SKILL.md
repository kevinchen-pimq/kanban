---
name: jira-board-import
description: >-
  Pull a Jira epic's tickets into the Epic × Checkpoint board on Convex: enumerate
  the epic's children, work out which week checkpoint each ticket belongs in, find
  its GitHub PRs, write a data/<epic>.json payload, and import it to dev and
  production. Use this whenever the user wants an epic or its tickets on the board
  — "import ABC-0000", "把這個 epic 匯入看板", "追蹤這個 epic", "update the board",
  "re-sync the tickets", "add this project as a column" — and also when they want to
  change how tickets are bucketed into weeks, or when hand-editing data/*.json or
  scripts/import-board.mjs. The Jira and GitHub query quirks documented here are
  silent-wrong-answer traps rather than errors, so reach for this skill even when
  the task looks like a small edit.
---

# Importing a Jira epic onto the board

The board is a matrix: epics are columns, week checkpoints are rows, each cell
holds that epic's tickets for that week. Your job is to turn one Jira epic into a
`data/<epic-key>.json` payload and import it.

Two things make this harder than it looks, and both fail *quietly*:

- The Atlassian MCP search silently caps results and gives you no cursor to get
  the rest, so a naive read returns a plausible-looking partial ticket list.
- GitHub's unquoted search splits `ABC-0000` into `ca` + `15893` and matches
  unrelated PRs, so you get real URLs attached to the wrong tickets.

Neither raises an error. Follow the steps below and check the counts.

## The pipeline

```
enumerate children  →  assign each a week  →  find PR links
                    →  write payload  →  validate  →  import dev + prod  →  verify
```

Read `README.md` for the payload schema and `scripts/import-board.mjs` for what
the validator enforces. Work in that order; the payload file is the deliverable
and everything before it is research.

---

## Step 1 — Enumerate the epic's children

```
parent = <EPIC-KEY> ORDER BY key ASC
```
with `fields: ["summary", "status", "assignee", "duedate"]`.

**Get the true total from `remainingCount`, not from paging.** The response caps
at 5 issues and — this is the trap — sets `pageInfo.endCursor` to `null` even when
more exist, so there is no cursor to follow. `remainingCount` is the count beyond
what was returned, so `returned + remainingCount` is the real total. Write that
number down; it is your check at the end.

To actually collect the rest, exclude what you already have and re-run:

```
parent = <EPIC-KEY> AND key NOT IN (CA-1, CA-2, …) ORDER BY key ASC
```

Repeat until a page comes back short. Stop when your list length equals the total
you recorded. If it doesn't match, you are missing tickets — keep going rather
than proceeding with a partial list.

**Specifying `fields` does not suppress `description`.** Epics with long
descriptions (POC write-ups, specs) return thousands of words per issue and can
blow through your context in a few calls. If that happens, prefer count-mode
queries (below) to narrow things before fetching issue bodies, and accept that
some pages will be expensive.

**Avoid `<` and `>` in JQL.** They get HTML-escaped in transit and the query
fails or misbehaves. `IN` / `NOT IN` cover everything you need here.

## Step 2 — Assign each ticket a week

A ticket's row is **the week the work actually finished**, resolved in two tiers.

### Tier 1: the week it was cut to Dev Done

```
parent = <EPIC-KEY> AND status CHANGED TO "Dev Done" DURING ("<tue>", "<next tue>")
```

Generate the windows instead of counting Tuesdays yourself:

```bash
node scripts/checkpoint-week.mjs --windows 2026-04-07 2026-08-15
```

Bound the sweep cheaply first. Run a few coarse windows with
`searchResultMode: "count"` — count responses are tiny — to find where the epic's
activity starts and ends, then sweep week by week only inside that range. Also
check one window *before* your range and confirm it is empty, so you know nothing
older is being cut off.

Two rules that matter:

- **A ticket matching several windows takes the last one.** It was pushed back and
  re-cut; the final transition is the one that stuck. Boundary dates also make a
  ticket appear in two adjacent windows, and "last" resolves that correctly too.
- **A window with more than 5 matches needs the `NOT IN` trick again** — same cap,
  same missing cursor.

### Tier 2: the resolution date

Spec, prototype, design, QA and POC tickets never pass through the Dev Done
column. Tier 1 alone dumps all of them into the backlog row even when Jira shows
them closed, which reads as "nothing got done" for whole phases of a project.

So for any ticket with no Dev Done transition, fetch `resolutiondate` and use the
week that date falls in. Record the date on the ticket as `resolvedAt` so a reader
can see why it landed there. `resolvedAt` is deliberately not stored in Convex —
`scripts/import-board.mjs` forwards fields by name and drops it.

```
key IN (CA-1, CA-2, …)     with fields: ["resolutiondate"]
```

Use the local date part of the timestamp (`2026-07-24T11:17+0800` → `2026-07-24`);
the weeks belong to the team's calendar, not to UTC.

### Tier 3: backlog

Only tickets with neither signal. That is genuinely unfinished work, which is what
the backlog row is for. If an epic ends up with a big backlog row full of *closed*
tickets, tier 2 was skipped.

### Converting dates to weeks

```bash
node scripts/checkpoint-week.mjs 2026-07-24 2026-03-23
node scripts/checkpoint-week.mjs --checkpoints 11 29   # payload entries
```

Weeks run Tuesday–Monday and use the team's own numbering, not ISO — W31 sits in
ISO week 32. Always run the script. Hand-counting across a month boundary has
already put a ticket in the wrong week once.

Declare **every** week between the earliest and latest in use, including empty
ones. The gaps are real weeks in the epic's span, and showing them is more honest
than a compressed axis that implies continuous delivery.

## Step 3 — Find the GitHub PRs

There is no `gh` CLI here and direct calls to api.github.com are blocked by the
proxy (403). Use the GitHub MCP PR search, which takes a `repo:` qualifier and
needs no `add_repo`:

```
repo:<owner>/<repo> "ABC-0000"
```

**Quote the ticket key.** Unquoted, GitHub tokenises `ABC-0000` into `ca` and
`15893` and will happily return a PR that predates the ticket. This produced a
confidently wrong mapping once; the quotes are the whole fix.

One search per key, `fields: ["number", "html_url"]` to keep responses small. A
ticket can have several PRs, hence the `githubPrs` array. What you get is "PRs
whose title, body or comments mention this key" — close enough to be useful, not
a curated implements-this list, so say so in `_notes`.

## Step 4 — Write the payload

Create `data/<epic-key>.json`. The `README.md` payload section is the reference;
the parts people get wrong:

- **Optional fields are cleared when absent.** `dueDate`, `githubPrs`, `tag`,
  `assignee` are not merged with what is already stored — the payload is the whole
  truth for each card. That is what makes re-importing safe.
- **`pruneEpics: ["<CODE>"]`** deletes tickets under that epic that the payload
  doesn't mention. Include it for a full epic sync; leave it out if you are only
  topping up a few cards.
- **`jiraStatus` must map.** `scripts/jira-status.mjs` throws on an unmapped status
  rather than defaulting, because a silent default parks real work under the wrong
  colour. If import fails on an unknown status, add it to that table deliberately —
  match Jira's own status category rather than guessing.
- **Unknown ticket fields are rejected** by the validator. That guard exists
  because forwarded fields are picked by name, so a `githubPr` typo would
  otherwise drop every PR link without a word.

Fill in `_source`, `_jql`, `_fetchedAt` and `_notes`. `_notes` is where the
judgement calls live — which tickets matched two windows, which fell back to
tier 2, what the PR search does and doesn't mean. Someone reading the row six
months from now cannot reconstruct that from the data.

Look at `data/example-epic.json` for a worked example.

## Step 5 — Validate, import, verify

```bash
node scripts/import-board.mjs data/<epic>.json --dry-run   # validate only
npm run import -- data/<epic>.json                          # dev
node scripts/import-board.mjs data/<epic>.json --prod       # production
npm run board                                               # what's on the board
```

Import is idempotent — it upserts on natural keys (epic `code`, week
`weekNumber`, backlog `kind`, ticket `key`), so re-running is safe and is how you
refresh an epic.

Then confirm, don't assume:

- ticket count matches the `remainingCount` total from step 1
- the per-week spread looks like real delivery, not everything piled in one row
- the backlog row holds only genuinely unfinished work

```bash
npx convex run board:get '{"fromDate":"2020-01-01"}' --prod
```

If the frontend changed too, deploy it: `npm run deploy` (it prompts for
production confirmation).

---

## Traps worth re-reading

| Symptom | Cause |
| --- | --- |
| Ticket list looks complete but is short | 5-result cap with `endCursor: null`; use `remainingCount` + `NOT IN` |
| A PR attached to a ticket that postdates it | unquoted GitHub search split the key |
| Whole phases sitting in Backlog while Jira says Done | tier 2 (resolution date) skipped |
| A ticket one week off | week counted by hand instead of via `checkpoint-week.mjs` |
| Rows out of order | not a real failure — `convex/board.ts` derives row order from `startDate` and ignores payload `order` |
| Import fails on a status name | intentional; add the mapping to `scripts/jira-status.mjs` on purpose |
| PR links silently vanish | field name typo, now caught by the unknown-field check |

## Verifying visually

Chromium in this container cannot reach external hosts, so a screenshot of the
production URL will hang on "載入中". To see the board, build against a local
anonymous Convex deployment (`CONVEX_AGENT_MODE=anonymous npx convex dev`), import
the same payload there, and screenshot `vite preview`. Say plainly that the
screenshot is of an identical build against local data rather than of production.

One harness caveat: Playwright scrolls an element into view before clicking it,
which moves the scroll container first. If you are testing scroll behaviour, click
via `el.click()` inside `page.evaluate` so the viewport stays put — otherwise you
will "discover" a scroll-position bug that is entirely your test's doing.
