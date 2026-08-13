#!/usr/bin/env node
/**
 * Push a board payload file into Convex.
 *
 *   node scripts/import-board.mjs data/example-epic.json
 *   node scripts/import-board.mjs data/example-epic.json --prod
 *   node scripts/import-board.mjs data/example-epic.json --dry-run
 *
 * The payload is normalised and validated here so mistakes surface with a file
 * and a ticket key attached, rather than as a validator error from the server.
 * It is then handed to `convex run data:importBoard`, which authenticates with
 * the Convex CLI credentials — no deploy key is needed and no public endpoint
 * is involved.
 *
 * Payload shape (every section optional except that tickets need their axes to
 * exist, either already on the board or in the same payload):
 *
 *   {
 *     "epics":       [{ "code", "name", "accent"?, "order"? }],
 *     "checkpoints": [{ "kind": "week"|"backlog", "weekNumber"?, "startDate"?,
 *                       "endDate"?, "label"?, "order"? }],
 *     "tickets":     [{ "key", "title", "epicCode", "checkpoint": <week#|"backlog">,
 *                       "status"|"jiraStatus", "tag", "dueDate"?, "assignee" }],
 *     "pruneEpics":  ["EPIC-CODE"]
 *   }
 *
 * Tickets may carry either `status` (already one of the four lights) or
 * `jiraStatus` (the raw Jira name, mapped via scripts/jira-status.mjs).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { toStatusLight } from "./jira-status.mjs";

const LIGHTS = new Set(["todo", "doing", "testing", "done"]);
const ACCENTS = new Set(["indigo", "purple", "cyan", "emerald"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const prod = args.includes("--prod");
const dryRun = args.includes("--dry-run");

if (!file) {
  console.error("Usage: node scripts/import-board.mjs <payload.json> [--prod] [--dry-run]");
  process.exit(1);
}

const problems = [];
const fail = (where, message) => problems.push(`${where}: ${message}`);

let raw;
try {
  raw = JSON.parse(readFileSync(file, "utf8"));
} catch (error) {
  console.error(`Could not read ${file}: ${error.message}`);
  process.exit(1);
}

const checkDate = (where, value) => {
  if (value !== undefined && !ISO_DATE.test(value)) {
    fail(where, `expected an ISO date like 2026-08-11, got ${JSON.stringify(value)}`);
  }
};

const epics = (raw.epics ?? []).map((epic, i) => {
  const where = `epics[${i}]${epic.code ? ` (${epic.code})` : ""}`;
  if (!epic.code) fail(where, "missing code");
  if (!epic.name) fail(where, "missing name");
  if (epic.accent !== undefined && !ACCENTS.has(epic.accent)) {
    fail(where, `accent must be one of ${[...ACCENTS].join(", ")}`);
  }
  return epic;
});

const checkpoints = (raw.checkpoints ?? []).map((checkpoint, i) => {
  const where = `checkpoints[${i}]`;
  if (checkpoint.kind !== "week" && checkpoint.kind !== "backlog") {
    fail(where, 'kind must be "week" or "backlog"');
  }
  if (checkpoint.kind === "week" && typeof checkpoint.weekNumber !== "number") {
    fail(where, "a week needs a numeric weekNumber");
  }
  checkDate(`${where}.startDate`, checkpoint.startDate);
  checkDate(`${where}.endDate`, checkpoint.endDate);
  if (
    checkpoint.startDate &&
    checkpoint.endDate &&
    checkpoint.endDate < checkpoint.startDate
  ) {
    fail(where, "endDate is before startDate");
  }
  return checkpoint;
});

const seen = new Set();
const tickets = (raw.tickets ?? []).map((ticket, i) => {
  const where = `tickets[${i}]${ticket.key ? ` (${ticket.key})` : ""}`;
  if (!ticket.key) fail(where, "missing key");
  if (!ticket.title) fail(where, "missing title");
  if (!ticket.epicCode) fail(where, "missing epicCode");
  if (!ticket.assignee) fail(where, "missing assignee");
  if (seen.has(ticket.key)) fail(where, "duplicate key in this payload");
  seen.add(ticket.key);

  if (
    typeof ticket.checkpoint !== "number" &&
    ticket.checkpoint !== "backlog"
  ) {
    fail(where, 'checkpoint must be a week number or "backlog"');
  }
  checkDate(`${where}.dueDate`, ticket.dueDate);

  let status = ticket.status;
  if (!status && ticket.jiraStatus) {
    try {
      status = toStatusLight(ticket.jiraStatus);
    } catch (error) {
      fail(where, error.message);
    }
  }
  if (!status) fail(where, "needs either status or jiraStatus");
  else if (!LIGHTS.has(status)) {
    fail(where, `status must be one of ${[...LIGHTS].join(", ")}`);
  }

  return {
    key: ticket.key,
    title: ticket.title,
    epicCode: ticket.epicCode,
    checkpoint: ticket.checkpoint,
    status,
    tag: ticket.tag ?? "",
    ...(ticket.dueDate ? { dueDate: ticket.dueDate } : {}),
    assignee: ticket.assignee,
  };
});

if (problems.length > 0) {
  console.error(`${problems.length} problem(s) in ${file}:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const payload = {
  ...(epics.length ? { epics } : {}),
  ...(checkpoints.length ? { checkpoints } : {}),
  ...(tickets.length ? { tickets } : {}),
  ...(raw.pruneEpics?.length ? { pruneEpics: raw.pruneEpics } : {}),
};

const target = prod ? "production" : "dev";
const counts =
  `${epics.length} epic(s), ${checkpoints.length} checkpoint(s), ` +
  `${tickets.length} ticket(s)`;

if (dryRun) {
  console.log(`${file} is valid: ${counts}. Would import into ${target}.`);
  const byStatus = {};
  for (const ticket of tickets) byStatus[ticket.status] = (byStatus[ticket.status] ?? 0) + 1;
  console.log("status split:", byStatus);
  if (payload.pruneEpics) console.log("would prune epics:", payload.pruneEpics.join(", "));
  process.exit(0);
}

console.log(`Importing ${counts} into ${target}...`);

const result = spawnSync(
  "npx",
  ["convex", "run", "data:importBoard", JSON.stringify(payload), ...(prod ? ["--prod"] : [])],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);
