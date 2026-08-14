---
name: jira-board-import
description: >-
  Use whenever a Jira epic or its tickets should get onto the Epic × Checkpoint
  board — "import ABC-1234", "把這個 epic 匯入看板", "追蹤這個 epic", "update the
  board", "re-sync the tickets" — and also when changing how tickets are bucketed
  into weeks, updating board data, or editing payload JSON or the import scripts
  bundled in this skill. Reach for it even when the task looks like a small edit;
  the query quirks documented here fail silently, not loudly.
---

# Importing a Jira epic onto the board

Turn one Jira epic into a payload JSON file and import it. Epics are columns,
week checkpoints are rows, each cell holds that epic's tickets for that week.

Payload schema and import rules: `references/updating-board-data.md`.
This skill bundles the tooling in `scripts/` (run from the repo root):

| Script | npm alias | Does |
| --- | --- | --- |
| `scripts/import-board.mjs` | `npm run import -- <file> [--prod] [--dry-run]` | validate payload, push to Convex |
| `scripts/checkpoint-week.mjs` | `npm run week -- …` | date ↔ week, JQL windows, checkpoint entries |
| `scripts/jira-status.mjs` | (imported by the importer) | Jira status name → one of four lights |

The pipeline:

```
enumerate children → assign each a week → find PR links
                  → write payload → validate → import dev + prod → verify
```

Two failure modes are *silent* — no error, just a plausible wrong answer:
the Atlassian MCP search caps results with no cursor, and GitHub's unquoted
search splits ticket keys. The steps below exist to defeat them; check the
counts at the end.

## Step 1 — Enumerate the epic's children

```
parent = <EPIC-KEY> ORDER BY key ASC
```
with `fields: ["summary", "status", "assignee", "duedate"]`.

- **True total = `returned + remainingCount`.** The response caps at 5 issues
  and sets `pageInfo.endCursor` to `null` even when more exist. Record the
  total; it is your check in step 5.
- **Collect the rest with `AND key NOT IN (…already fetched…)`** and repeat
  until your list matches the total. Don't proceed on a partial list.
- `fields` does not suppress `description` — long epics are context-expensive.
  Use `searchResultMode: "count"` queries to narrow before fetching bodies.
- Avoid `<` / `>` in JQL (HTML-escaped in transit); `IN` / `NOT IN` suffice.

## Step 2 — Assign each ticket a week

A ticket's row is **the week the work actually finished**, in three tiers:

**Tier 1 — the week it was cut to Dev Done.** Sweep week windows with JQL:

```
parent = <EPIC-KEY> AND status CHANGED TO "Dev Done" DURING ("<tue>", "<next tue>")
```

Generate windows with `npm run week -- --windows <from> <to>` — never count
Tuesdays by hand (a real off-by-one week happened that way). Bound the sweep
with cheap count-mode queries first, and check one window before your range is
empty. A ticket matching several windows takes the **last** one (it was pushed
back and re-cut). A window with >5 matches needs the `NOT IN` trick again.

**Tier 2 — resolution date.** Spec / prototype / design / QA / POC tickets
never pass through Dev Done; tier 1 alone dumps them into backlog even when
Jira shows them closed. For tickets with no Dev Done transition, fetch
`resolutiondate` (use the local date part, not UTC) and use that week. Record
the date as `resolvedAt` on the ticket — file-level provenance the importer
deliberately does not send to Convex.

**Tier 3 — backlog.** Only tickets with neither signal: genuinely unfinished
work. A backlog row full of *closed* tickets means tier 2 was skipped.

Convert dates with `npm run week -- <date>` and generate payload entries with
`npm run week -- --checkpoints <lo> <hi>`. Weeks run Tuesday–Monday with the
team's own numbering (not ISO). Declare **every** week between the earliest
and latest in use, including empty ones — gaps are real weeks.

## Step 3 — Find the GitHub PRs

No `gh` CLI here and api.github.com is proxy-blocked; use the GitHub MCP PR
search (takes `repo:`, needs no `add_repo`):

```
repo:<owner>/<repo> "ABC-1234"
```

**Quote the ticket key** — unquoted, GitHub tokenises `ABC-1234` into `abc` +
`1234` and matches unrelated PRs. One search per key, `fields: ["number",
"html_url"]`. Results are "PRs that mention this key", not a curated
implements-this list — say so in `_notes`. Multiple PRs per ticket is normal
(`githubPrs` is an array).

## Step 4 — Write the payload

Follow the schema in `references/updating-board-data.md`; `data/example-epic.json`
shows the format. The rules that bite: optional fields are cleared when
absent, `pruneEpics` makes the payload the whole truth for an epic, unmapped
`jiraStatus` fails the import on purpose, unknown ticket fields are rejected.

Fill in `_source`, `_jql`, `_fetchedAt`, `_notes` — `_notes` is where the
judgement calls live (double-window tickets, tier-2 fallbacks, what the PR
search means). Real payloads are gitignored; keep them outside the repo.

## Step 5 — Validate, import, verify

```bash
npm run import -- <payload>.json --dry-run   # validate only
npm run import -- <payload>.json             # dev
npm run import -- <payload>.json --prod      # production
npm run board                                # summary of what's on the board
```

Import is idempotent (upserts on natural keys), so re-running is how you
refresh an epic. Then confirm, don't assume:

- ticket count matches the step-1 total
- per-week spread looks like real delivery, not one big pile
- backlog holds only genuinely unfinished work

```bash
npx convex run board:get '{"fromDate":"2020-01-01"}' --prod
```

If the frontend changed too: `npm run deploy`.

## Traps worth re-reading

| Symptom | Cause |
| --- | --- |
| Ticket list looks complete but is short | 5-result cap with `endCursor: null`; use `remainingCount` + `NOT IN` |
| A PR attached to a ticket that postdates it | unquoted GitHub search split the key |
| Whole phases sitting in Backlog while Jira says Done | tier 2 (resolution date) skipped |
| A ticket one week off | week counted by hand instead of via `npm run week` |
| Rows out of order | not a failure — `convex/board.ts` derives row order from dates, ignores payload `order` |
| Import fails on a status name | intentional; add the mapping to `scripts/jira-status.mjs` deliberately |
| PR links silently vanish | field name typo, now caught by the unknown-field check |

To verify the result visually (screenshots from inside this container), read
`references/visual-verification.md` first — the obvious approach hangs.
