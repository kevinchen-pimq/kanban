/**
 * Jira status name -> board status light.
 *
 * The board has four lights and Jira has many more statuses, so the mapping
 * lives here rather than being guessed at each import. Keys are compared
 * case-insensitively with surrounding whitespace trimmed.
 *
 * An unknown status is a hard error rather than a default, because a silent
 * fallback would quietly park real work under the wrong light. When Jira grows
 * a new status, add it here.
 */
export const JIRA_STATUS_TO_LIGHT = {
  // 灰 — To Do / Backlog
  "issue open": "todo",
  open: "todo",
  "to do": "todo",
  todo: "todo",
  backlog: "todo",
  reopened: "todo",
  "issue reopened": "todo",

  // 藍 — Doing
  doing: "doing",
  "in progress": "doing",
  "in development": "doing",

  // 黃 — Test and Review / Dev Done
  "dev done": "testing",
  "ready for review": "testing",
  "in review": "testing",
  "code review": "testing",
  review: "testing",
  testing: "testing",
  "in testing": "testing",
  "ready for test": "testing",

  // 綠 — Dev Test Done / Done
  "dev test done": "done",
  done: "done",
  closed: "done",
  resolved: "done",
  complete: "done",
  completed: "done",
};

/**
 * Resolve a Jira status name to one of the four lights.
 * Throws on an unmapped name so the gap surfaces at import time.
 */
export function toStatusLight(jiraStatus) {
  const normalised = String(jiraStatus ?? "").trim().toLowerCase();
  const light = JIRA_STATUS_TO_LIGHT[normalised];
  if (!light) {
    throw new Error(
      `Unmapped Jira status "${jiraStatus}". Add it to ` +
        `scripts/jira-status.mjs (JIRA_STATUS_TO_LIGHT).`,
    );
  }
  return light;
}
