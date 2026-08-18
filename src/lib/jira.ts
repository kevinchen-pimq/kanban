/**
 * The Jira site is a deployment setting, not a constant: it lives in the Convex
 * `config` document (`npx convex run data:setConfig`), so pointing the board at
 * a different Jira site takes no rebuild. That is why the base URL is a
 * parameter here rather than a value in this file.
 */

/**
 * Issue page for a ticket key, or null when the board has no `jiraBaseUrl`
 * configured — the card then shows its key as plain text rather than a link
 * that would 404.
 */
export function jiraIssueUrl(
  baseUrl: string | undefined,
  key: string,
): string | null {
  if (!baseUrl?.trim()) return null;
  // Tolerate a trailing slash, since the value is typed by hand.
  return `${baseUrl.trim().replace(/\/+$/, "")}/${encodeURIComponent(key)}`;
}
