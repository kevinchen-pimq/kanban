import { STATUS_ORDER, type TicketStatus } from "./board";

/**
 * The toolbar's filter selections, remembered between visits.
 *
 * Somebody who works on one epic opens this board every morning and wants the
 * same view they left; re-ticking three menus each time is a small tax paid
 * daily. So the three *selections* persist — and only the selections.
 *
 * **The search box deliberately does not.** A typed query is a question being
 * asked right now ("where is CA-15807?"), not a way of looking at the board;
 * restoring it a day later would open the board showing two cards with no
 * obvious reason why, and the reader would have to notice the box to explain it.
 * Filters announce themselves in the toolbar; a stale search hides.
 *
 * Epics and assignees are stored by their names — epic `code`, assignee string —
 * rather than by Convex id, so a re-imported epic that got a new document keeps
 * its filter. Anything the board no longer has is dropped on load rather than
 * kept as a ghost that quietly hides everything.
 */

/** Bump the suffix when the stored shape changes; old keys are then ignored. */
const STORAGE_KEY = "kanban.filters.v1";

export type StoredFilters = {
  /** Epic codes. */
  epics: string[];
  statuses: TicketStatus[];
  /** Assignee names; `null` is the "unassigned" option. */
  assignees: (string | null)[];
};

export const NO_FILTERS: StoredFilters = {
  epics: [],
  statuses: [],
  assignees: [],
};

const isStatus = (value: unknown): value is TicketStatus =>
  typeof value === "string" && (STATUS_ORDER as readonly string[]).includes(value);

/**
 * Read the saved selections.
 *
 * Anything unreadable — no storage, malformed JSON, a shape from a future
 * version — is treated as "no filters" rather than an error: a broken
 * preference must never keep the board from opening.
 */
export function loadFilters(): StoredFilters {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return NO_FILTERS;

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return NO_FILTERS;
    const { epics, statuses, assignees } = parsed as Partial<StoredFilters>;

    return {
      epics: Array.isArray(epics) ? epics.filter((e) => typeof e === "string") : [],
      statuses: Array.isArray(statuses) ? statuses.filter(isStatus) : [],
      assignees: Array.isArray(assignees)
        ? assignees.filter((a) => a === null || typeof a === "string")
        : [],
    };
  } catch {
    return NO_FILTERS;
  }
}

/** Save the selections. Storage being unavailable is not worth a broken board. */
export function saveFilters(filters: StoredFilters): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
  } catch {
    // Private mode, full quota, no storage: the board works, it just forgets.
  }
}
