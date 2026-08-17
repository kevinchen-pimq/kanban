#!/usr/bin/env node
/**
 * Checkpoint week arithmetic.
 *
 * The team's checkpoint weeks run Sunday to Saturday and are numbered by the
 * team, not by ISO. Because the numbering is a convention rather than a
 * formula the calendar knows, every date/week conversion has to go through
 * the anchor below.
 *
 * Do this arithmetic here rather than in your head. Counting week starts by
 * hand across a month boundary is exactly the kind of step that looks obvious
 * and lands a ticket in the wrong row — a real off-by-one week happened that
 * way, and the boundary itself has been corrected once already (the weeks were
 * first assumed to run Tuesday–Monday; the team's real weeks are Sun–Sat).
 *
 * Usage:
 *   npm run week -- 2026-07-24 [...more dates]
 *       -> the week each date falls in
 *   npm run week -- --checkpoints 11 29
 *       -> checkpoint entries for a payload, W11..W29 inclusive
 *   npm run week -- --windows 2026-04-07 2026-08-15
 *       -> the (Sun, next Sun) pairs to sweep with a "CHANGED TO" JQL query
 */

/**
 * W32 is known to run 2026-08-09 (Sun) .. 2026-08-15 (Sat) — confirmed by the
 * team — and weeks are contiguous, so W1 starts 31 weeks earlier. Anchoring on
 * a checkpoint someone can verify beats a bare magic date: if the team ever
 * renumbers or moves the boundary again, this is the one line to fix.
 */
const ANCHOR = { week: 32, startDate: "2026-08-09" };
const DAY = 86_400_000;
const WEEK = 7 * DAY;

const toUtc = (iso) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new Error(`expected an ISO date "YYYY-MM-DD", got ${JSON.stringify(iso)}`);
  }
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const toIso = (ms) => new Date(ms).toISOString().slice(0, 10);

const W1_START = toUtc(ANCHOR.startDate) - (ANCHOR.week - 1) * WEEK;

/** The checkpoint week an ISO date falls in. Weeks run Sun..Sat inclusive. */
export function weekOf(iso) {
  return Math.floor((toUtc(iso) - W1_START) / WEEK) + 1;
}

/** Sunday that opens the week. */
export function weekStart(week) {
  return toIso(W1_START + (week - 1) * WEEK);
}

/** Saturday that closes the week. */
export function weekEnd(week) {
  return toIso(W1_START + (week - 1) * WEEK + 6 * DAY);
}

/** A payload `checkpoints` entry for one week. */
export function checkpoint(week) {
  return {
    kind: "week",
    weekNumber: week,
    startDate: weekStart(week),
    endDate: weekEnd(week),
    order: week,
  };
}

/**
 * Half-open [start, next start) pairs for a JQL `DURING` sweep. A transition
 * landing exactly on a boundary shows up in both neighbours, which is why the
 * import rule takes the last window a ticket appears in.
 */
export function windows(fromIso, untilIso) {
  toUtc(untilIso); // reject a malformed bound before looping on it
  const out = [];
  // ISO dates sort lexicographically, so a plain string compare is the correct
  // one here — and avoids mixing a date string with a millisecond number.
  for (let w = weekOf(fromIso); weekStart(w) <= untilIso; w++) {
    out.push({ week: w, from: weekStart(w), to: weekStart(w + 1) });
  }
  return out;
}

// ---------------------------------------------------------------- CLI

if (import.meta.url === `file://${process.argv[1]}`) {
  const [mode, ...rest] = process.argv.slice(2);
  try {
    if (mode === "--checkpoints") {
      const [lo, hi] = rest.map(Number);
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || hi < lo) {
        throw new Error("--checkpoints needs a low and high week number");
      }
      const list = [];
      for (let w = lo; w <= hi; w++) list.push(checkpoint(w));
      console.log(JSON.stringify(list, null, 2));
    } else if (mode === "--windows") {
      const [from, to] = rest;
      if (!from || !to) throw new Error("--windows needs a start and end date");
      for (const w of windows(from, to)) {
        console.log(`W${w.week}\tDURING ("${w.from}", "${w.to}")`);
      }
    } else {
      const dates = mode ? [mode, ...rest] : [];
      if (dates.length === 0) throw new Error("give one or more ISO dates, or --checkpoints / --windows");
      for (const d of dates) {
        const w = weekOf(d);
        console.log(`${d}\tW${w}\t(${weekStart(w)} .. ${weekEnd(w)})`);
      }
    }
  } catch (error) {
    console.error(`checkpoint-week: ${error.message}`);
    process.exit(1);
  }
}
