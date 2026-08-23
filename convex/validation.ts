import { v } from "convex/values";

/**
 * Field-level checks shared by the import path (`data.ts`) and the board's
 * public mutations (`board.ts`).
 *
 * Both write the same table, so both have to hold the same line: a card typed
 * into the board by hand cannot be sloppier than one that came from Jira, or
 * the board slowly fills with values the importer would have refused.
 */

/** Which row a ticket belongs to: a week number, or the backlog pool. */
export const checkpointRefValidator = v.union(v.number(), v.literal("backlog"));

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Longest title the card layout can show without becoming a wall of text. */
const MAX_TITLE = 200;

/** Keys are matched on by the importer, so they carry no whitespace. */
const KEY_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_KEY = 40;

export function assertIsoDate(value: string | undefined, field: string) {
  if (value !== undefined && !ISO_DATE.test(value)) {
    throw new Error(`${field} must be an ISO date like 2026-08-11, got "${value}"`);
  }
}

/** Trims and rejects the empty string: a card with no title is unreadable. */
export function cleanTitle(value: string): string {
  const title = value.trim();
  if (!title) throw new Error("A ticket needs a title");
  if (title.length > MAX_TITLE) {
    throw new Error(`Title is longer than ${MAX_TITLE} characters`);
  }
  return title;
}

/**
 * Ticket keys identify a card across imports, so they have to survive being
 * pasted into a URL and compared as a string: no spaces, no slashes.
 */
export function cleanKey(value: string): string {
  const key = value.trim();
  if (!key) throw new Error("A ticket key cannot be empty");
  if (key.length > MAX_KEY) {
    throw new Error(`Ticket key is longer than ${MAX_KEY} characters`);
  }
  if (!KEY_SHAPE.test(key)) {
    throw new Error(
      `Ticket key "${key}" may only contain letters, digits, dot, dash and ` +
        `underscore`,
    );
  }
  return key;
}

/**
 * Anything the UI turns into a link: it has to be an http(s) URL, or it is
 * refused rather than rendered as a link that goes nowhere.
 */
export function cleanHttpUrl(value: string, field = "URL"): string {
  const url = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${field} "${url}" must be http or https`);
  }
  return url;
}

/** Pull request badges are links, so each one goes through `cleanHttpUrl`. */
export function cleanPrUrls(urls: readonly string[]): string[] {
  return urls.map((raw) => cleanHttpUrl(raw, "Pull request URL"));
}

/** Optional single-line text such as a tag or an assignee name. */
export function cleanOptionalText(
  value: string | null | undefined,
  field: string,
  max = 120,
): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > max) {
    throw new Error(`${field} is longer than ${max} characters`);
  }
  return text;
}
