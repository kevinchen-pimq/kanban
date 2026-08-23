#!/usr/bin/env node
// Publish the weekly report: upload the HTML, record it, broadcast the link.
//
//   node upload-report.mjs report.html --week 34 --start 2026-08-16 --end 2026-08-22
//   node upload-report.mjs report.html --week 34 --start … --end … --title "W34 週報"
//
// Three steps, one command, because a file in storage that nobody was told about
// is not a published report:
//
//   1. `notifications:trackerReportUploadUrl` → a one-shot upload URL
//   2. POST the file to it with `content-type: text/html` → `{ storageId }`
//   3. `notifications:trackerPublishReport` → records the row and broadcasts a
//      `report` notification, with the file's storage URL as the link
//
// Prints the broadcast link and who received it. Exits non-zero with the reason on
// any failure — including the deliberate one: publishing a week that already has a
// report is refused, so a Monday routine that fires twice cannot broadcast the
// same report again.
//
// Credentials come from KANBAN_URL, KANBAN_TRACKER_ACCOUNT and
// KANBAN_TRACKER_TOKEN_HASH, exactly like tracker-call.mjs — never from a file.

import { readFile } from "node:fs/promises";

const url = process.env.KANBAN_URL;
const account = process.env.KANBAN_TRACKER_ACCOUNT;
const tokenHash = process.env.KANBAN_TRACKER_TOKEN_HASH;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function die(message) {
  console.error(message);
  process.exit(1);
}

function usage() {
  die(
    "usage: upload-report.mjs <file.html> --week <n> --start <YYYY-MM-DD> --end <YYYY-MM-DD> [--title <text>]",
  );
}

const argv = process.argv.slice(2);
const positional = [];
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg.startsWith("--")) {
    const value = argv[++i];
    if (value === undefined) usage();
    flags[arg.slice(2)] = value;
  } else {
    positional.push(arg);
  }
}

const [file] = positional;
if (!file || positional.length > 1) usage();
if (!flags.week || !flags.start || !flags.end) usage();

const weekNumber = Number(flags.week);
if (!Number.isInteger(weekNumber) || weekNumber <= 0) {
  die(`--week must be a positive integer, got "${flags.week}" (use npm run week).`);
}
for (const field of ["start", "end"]) {
  if (!ISO_DATE.test(flags[field])) {
    die(`--${field} must be an ISO date like 2026-08-16, got "${flags[field]}".`);
  }
}
if (flags.end < flags.start) {
  die(`--start ${flags.start} is after --end ${flags.end}; check with npm run week.`);
}

if (!url) die("KANBAN_URL is unset (e.g. https://laudable-buffalo-595.convex.cloud).");
if (!account || !tokenHash) {
  die("KANBAN_TRACKER_ACCOUNT / KANBAN_TRACKER_TOKEN_HASH are unset — ask the user for the tracker credential.");
}

const base = url.replace(/\/$/, "");
const auth = { account, tokenHash };

/** One Convex call, failing loudly: a rejection still arrives as HTTP 200. */
async function call(kind, path, args) {
  const response = await fetch(`${base}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args: { auth, ...args }, format: "json" }),
  });
  const answer = await response.json().catch(() => null);
  if (!answer) die(`${path}: unreadable answer (HTTP ${response.status})`);
  if (answer.status !== "success") {
    die(`${path}: ${answer.errorMessage ?? JSON.stringify(answer.errorData ?? answer)}`);
  }
  return answer.value;
}

let html;
try {
  html = await readFile(file);
} catch (error) {
  die(`cannot read ${file}: ${error.message}`);
}
if (html.length === 0) die(`${file} is empty — there is nothing to publish.`);

const uploadUrl = await call("mutation", "notifications:trackerReportUploadUrl", {});

const upload = await fetch(uploadUrl, {
  method: "POST",
  headers: { "content-type": "text/html" },
  body: html,
});
if (!upload.ok) {
  die(`upload failed: HTTP ${upload.status} ${await upload.text().catch(() => "")}`);
}
const uploaded = await upload.json().catch(() => null);
if (!uploaded?.storageId) {
  die(`upload answered without a storageId: ${JSON.stringify(uploaded)}`);
}

const published = await call("mutation", "notifications:trackerPublishReport", {
  storageId: uploaded.storageId,
  weekNumber,
  startDate: flags.start,
  endDate: flags.end,
  ...(flags.title ? { title: flags.title } : {}),
});

console.log(
  JSON.stringify(
    {
      title: published.title,
      week: weekNumber,
      range: `${flags.start} ~ ${flags.end}`,
      link: published.url,
      sent: published.sent,
      accounts: published.accounts,
      bytes: html.length,
    },
    null,
    2,
  ),
);
