/**
 * Scroll the board so the row covering today sits directly under the sticky
 * column headers.
 *
 * Shared by the initial scroll on first paint and the「本週」button in the
 * corner cell, so both land in exactly the same place. The header offset has
 * to be subtracted: `thead` is sticky, so aligning the row with the top of the
 * scroller would leave it hidden behind the epic names.
 *
 * Returns false when no row is marked as the current week — the board's data is
 * older (or newer) than today and there is nothing to scroll to.
 */
export function scrollToCurrentWeek(
  scroller: HTMLElement | null,
  behavior: ScrollBehavior = "auto",
): boolean {
  const row = scroller?.querySelector<HTMLElement>("[data-current-week]");
  if (!scroller || !row) return false;

  const head = scroller.querySelector("thead");
  const headOffset = head instanceof HTMLElement ? head.offsetHeight : 0;
  const delta =
    row.getBoundingClientRect().top -
    scroller.getBoundingClientRect().top -
    headOffset;

  scroller.scrollTo({ top: scroller.scrollTop + delta, behavior });
  return true;
}
