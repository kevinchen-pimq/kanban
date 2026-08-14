/**
 * A pull request URL is too long for a card badge, so show the number instead.
 * Anything that is not a recognisable GitHub PR URL falls back to the raw
 * string rather than being hidden, so a malformed value stays visible.
 */
export function prLabel(url: string): string {
  const match = /\/pull\/(\d+)/.exec(url);
  return match ? `#${match[1]}` : url;
}
