/**
 * Every ticket on the board comes from the same Jira Cloud site, so the browse
 * URL is one constant here rather than a per-ticket field in the payload.
 */
const JIRA_BROWSE_BASE = "https://pimq.atlassian.net/browse";

/** Issue page for a ticket key: "CA-15807" -> ".../browse/CA-15807". */
export function jiraIssueUrl(key: string): string {
  return `${JIRA_BROWSE_BASE}/${encodeURIComponent(key)}`;
}
