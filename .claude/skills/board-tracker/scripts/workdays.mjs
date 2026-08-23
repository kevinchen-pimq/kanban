#!/usr/bin/env node
// How much *working* time has passed — the "is this PR stuck" arithmetic, done
// here so no agent ever does it in its head.
//
//   node workdays.mjs elapsed 2026-08-20T03:15:00Z
//   node workdays.mjs elapsed 2026-08-20T03:15:00Z 2026-08-25T01:00:00Z
//   node workdays.mjs test
//
//   → {"workingHours": 36.5, "workingDays": 1.52, "stuck": true}
//
// Definitions, and they are the ones the skill means:
//
// - Weekends do not count. Saturday and Sunday **in Asia/Taipei** are removed
//   from the elapsed span, whether the span starts, ends or sits inside one.
//   Taipei is UTC+8 all year with no DST, so the offset is a constant here rather
//   than a timezone database lookup.
// - A **working day is 24 hours** of that remaining time, not an 8-hour shift.
//   The question being asked is "how long has this PR been sitting", which is
//   wall-clock patience with the weekend taken out — an 8-hour day would make
//   1.5 days mean "since yesterday afternoon" and call almost everything stuck.
// - `stuck` is `workingDays > 1.5`, the threshold in the skill's stuck rules.
//
// The end defaults to now, so the common call is one timestamp: the PR's
// `created_at`. Exits 1 on an unusable argument, and on a failed self-check.

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** The threshold in the skill: more than this many working days is stuck. */
const STUCK_WORKING_DAYS = 1.5;

function die(message) {
  console.error(message);
  process.exit(1);
}

function parseInstant(value, label) {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    die(`${label} is not a date/time I can read: "${value}" (use ISO, e.g. 2026-08-20T03:15:00Z)`);
  }
  return ms;
}

/** Day of week in Taipei: 0 = Sunday … 6 = Saturday. */
function taipeiDayOfWeek(ms) {
  return new Date(ms + TAIPEI_OFFSET_MS).getUTCDay();
}

/** Start of the Taipei calendar day containing `ms`, as an instant. */
function taipeiDayStart(ms) {
  return Math.floor((ms + TAIPEI_OFFSET_MS) / DAY_MS) * DAY_MS - TAIPEI_OFFSET_MS;
}

/**
 * Milliseconds of [start, end) that fall on a Taipei Saturday or Sunday.
 *
 * Walks Taipei calendar days and clips each weekend day to the span, so a span
 * that begins mid-Saturday, ends mid-Sunday or covers several weekends all come
 * out right; there is no special case per shape.
 */
export function weekendMs(startMs, endMs) {
  if (endMs <= startMs) return 0;
  let total = 0;
  for (let day = taipeiDayStart(startMs); day < endMs; day += DAY_MS) {
    const dow = taipeiDayOfWeek(day);
    if (dow !== 0 && dow !== 6) continue;
    const from = Math.max(day, startMs);
    const to = Math.min(day + DAY_MS, endMs);
    if (to > from) total += to - from;
  }
  return total;
}

/** Working time between two instants, plus the stuck verdict. */
export function elapsed(startMs, endMs = Date.now()) {
  const span = Math.max(0, endMs - startMs);
  const workingMs = Math.max(0, span - weekendMs(startMs, endMs));
  const workingHours = workingMs / HOUR_MS;
  const workingDays = workingMs / DAY_MS;
  return {
    workingHours: Number(workingHours.toFixed(2)),
    workingDays: Number(workingDays.toFixed(2)),
    stuck: workingDays > STUCK_WORKING_DAYS,
  };
}

// ---------------------------------------------------------------------------
// Self-checks: fixed fixtures, no network, no clock.
// ---------------------------------------------------------------------------

// All fixtures are written in Taipei local time (+08:00) so the weekend boundaries
// are readable. 2026-08-17 is a Monday, so 08-22 is a Saturday and 08-23 a Sunday.
const CASES = [
  {
    name: "one weekday to the next: nothing removed",
    start: "2026-08-17T09:00:00+08:00",
    end: "2026-08-18T09:00:00+08:00",
    workingHours: 24,
    stuck: false,
  },
  {
    name: "Friday to Monday: the whole weekend removed",
    start: "2026-08-21T09:00:00+08:00",
    end: "2026-08-24T09:00:00+08:00",
    workingHours: 24,
    stuck: false,
  },
  {
    name: "starts on a Saturday: only the Monday part counts",
    start: "2026-08-22T10:00:00+08:00",
    end: "2026-08-24T10:00:00+08:00",
    workingHours: 10,
    stuck: false,
  },
  {
    name: "ends on a Sunday: only the Friday part counts",
    start: "2026-08-21T15:00:00+08:00",
    end: "2026-08-23T15:00:00+08:00",
    workingHours: 9,
    stuck: false,
  },
  {
    name: "entirely inside a weekend: no working time at all",
    start: "2026-08-22T09:00:00+08:00",
    end: "2026-08-23T18:00:00+08:00",
    workingHours: 0,
    stuck: false,
  },
  {
    name: "Thursday to the following Monday: over the 1.5-day threshold",
    start: "2026-08-20T09:00:00+08:00",
    end: "2026-08-24T12:00:00+08:00",
    workingHours: 51,
    stuck: true,
  },
  {
    name: "two weeks: two weekends removed",
    start: "2026-08-17T09:00:00+08:00",
    end: "2026-08-31T09:00:00+08:00",
    workingHours: 240,
    stuck: true,
  },
  {
    name: "just under the threshold (36h) is not stuck",
    start: "2026-08-17T09:00:00+08:00",
    end: "2026-08-18T21:00:00+08:00",
    workingHours: 36,
    stuck: false,
  },
  {
    name: "just over the threshold (36h + 1min) is stuck",
    start: "2026-08-17T09:00:00+08:00",
    end: "2026-08-18T21:01:00+08:00",
    workingHours: 36.02,
    stuck: true,
  },
  {
    name: "end before start: zero, not negative",
    start: "2026-08-18T09:00:00+08:00",
    end: "2026-08-17T09:00:00+08:00",
    workingHours: 0,
    stuck: false,
  },
];

function runTests() {
  let failed = 0;
  for (const testCase of CASES) {
    const got = elapsed(Date.parse(testCase.start), Date.parse(testCase.end));
    const ok =
      got.workingHours === testCase.workingHours && got.stuck === testCase.stuck;
    if (!ok) failed++;
    console.log(
      `${ok ? "ok  " : "FAIL"} ${testCase.name}: ` +
        `workingHours=${got.workingHours} (want ${testCase.workingHours}), ` +
        `stuck=${got.stuck} (want ${testCase.stuck})`,
    );
  }
  console.log(`${CASES.length - failed}/${CASES.length} passed`);
  if (failed) process.exit(1);
}

// ---------------------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);

if (command === "test") {
  runTests();
} else if (command === "elapsed") {
  const [rawStart, rawEnd] = rest;
  if (!rawStart) die("usage: workdays.mjs elapsed <iso-datetime> [<iso-datetime-end>]");
  const startMs = parseInstant(rawStart, "start");
  const endMs = rawEnd ? parseInstant(rawEnd, "end") : Date.now();
  console.log(JSON.stringify(elapsed(startMs, endMs)));
} else {
  die("usage: workdays.mjs elapsed <iso-datetime> [<iso-datetime-end>] | workdays.mjs test");
}
