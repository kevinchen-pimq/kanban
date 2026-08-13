/**
 * Dates on the board are ISO calendar dates ("YYYY-MM-DD"), not instants.
 * A checkpoint week belongs to the team's local calendar, so comparing plain
 * date strings avoids the timezone drift that `new Date(iso)` would introduce
 * by parsing them as UTC midnight.
 */

/** Today in the viewer's local calendar, as "YYYY-MM-DD". */
export function todayIso(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** "2026-08-04" -> "08/04", the compact form used in row subtitles. */
export function formatMonthDay(iso: string): string {
  const [, month, day] = iso.split("-");
  return `${month}/${day}`;
}

/** "2026-04-10" -> "Apr 10, 2026", matching the card's due-date badge. */
export function formatDueDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

/** ISO date strings sort lexicographically, so a plain compare is correct. */
export function isBefore(a: string, b: string): boolean {
  return a < b;
}

/**
 * Shift an ISO date back by whole weeks. Built on UTC arithmetic so a DST
 * boundary cannot move the result onto the wrong day.
 */
export function weeksBefore(iso: string, weeks: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day - weeks * 7));
  return shifted.toISOString().slice(0, 10);
}
