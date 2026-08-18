import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The four status lights the board renders:
 *   todo    — 灰色: to do / backlog
 *   doing   — 藍色: doing
 *   testing — 黃色: test and review / dev done
 *   done    — 綠色: dev test done / done
 */
export const statusValidator = v.union(
  v.literal("todo"),
  v.literal("doing"),
  v.literal("testing"),
  v.literal("done"),
);

/** Colour key for an epic's badge. Resolved to concrete classes in the UI. */
export const accentValidator = v.union(
  v.literal("indigo"),
  v.literal("purple"),
  v.literal("cyan"),
  v.literal("emerald"),
);

/**
 * A row is either a dated week or the undated backlog pool. Weeks carry their
 * own start/end date so "本週" is derived from today rather than stored, and
 * the board never needs a weekly data edit.
 */
export const checkpointKindValidator = v.union(
  v.literal("week"),
  v.literal("backlog"),
);

export default defineSchema({
  // X axis: one column per epic, left to right by `order`.
  epics: defineTable({
    code: v.string(),
    name: v.string(),
    accent: accentValidator,
    order: v.number(),
  })
    // `code` is the natural key imports match on.
    .index("by_code", ["code"])
    .index("by_order", ["order"]),

  // Y axis: one row per checkpoint, top to bottom by `order`.
  checkpoints: defineTable({
    kind: checkpointKindValidator,
    // Present when kind === "week". This is the team's own checkpoint number,
    // which is not the ISO week number, so it is stored rather than computed.
    weekNumber: v.optional(v.number()),
    // ISO calendar dates, "YYYY-MM-DD". Inclusive on both ends.
    startDate: v.optional(v.string()),
    endDate: v.optional(v.string()),
    // Present when kind === "backlog".
    label: v.optional(v.string()),
    order: v.number(),
  })
    // Weeks are matched on their number; the backlog row is matched on kind.
    .index("by_kind_and_week", ["kind", "weekNumber"])
    .index("by_order", ["order"]),

  // Cards, each sitting in exactly one (checkpoint, epic) cell.
  tickets: defineTable({
    key: v.string(),
    title: v.string(),
    epicId: v.id("epics"),
    checkpointId: v.id("checkpoints"),
    status: statusValidator,
    // ISO calendar date, "YYYY-MM-DD". Absent means no due date.
    dueDate: v.optional(v.string()),
    // Pull requests that reference this ticket's key, oldest first. A ticket
    // can span several, so this is a list rather than a single URL.
    githubPrs: v.optional(v.array(v.string())),
    // Both optional: the Jira import carries neither, and the card simply
    // omits whichever is missing.
    tag: v.optional(v.string()),
    assignee: v.optional(v.string()),
    // Position within its (epic, checkpoint) cell, ascending. Optional because
    // no import sets it: cards that have never been dragged into an order have
    // none, and the board falls back to creation order for them.
    order: v.optional(v.number()),
  })
    .index("by_key", ["key"])
    .index("by_checkpoint_and_epic", ["checkpointId", "epicId"]),

  // Accounts that may read or edit the board.
  //
  // `tokenHash` is sha256("kanban:<account>:<password>"), computed in the
  // browser: the password itself never reaches the server, is never stored and
  // never appears in a log. The hash is the whole credential — every query and
  // mutation carries { account, tokenHash } and is checked against this row, so
  // there is no session, no expiry and no revocation beyond deleting or
  // re-seeding the account. See `docs/data-model.md` for the trade-off.
  //
  // The three permissions are independent and default to false, which is what
  // makes a fresh registration a *pending* one: it can log in as far as being
  // told it is awaiting approval, and nothing else.
  users: defineTable({
    // Lowercased, trimmed. Also what the token hash is computed over, so it is
    // normalised on the client before hashing.
    account: v.string(),
    // Hex sha256 of "kanban:<account>:<password>", 64 lowercase hex chars.
    tokenHash: v.string(),
    // Read the board at all. `false` means "registered, awaiting approval".
    permRead: v.boolean(),
    // Edit the board: drag, create, update, delete, cycle status.
    permWrite: v.boolean(),
    // See pending registrations and approve or dismiss them.
    permApproveRegister: v.boolean(),
  })
    // `account` is the natural key every credential check looks up.
    .index("by_account", ["account"]),

  // Board-wide settings, as a single document (the first row wins).
  //
  // These are deployment settings rather than board data: the Jira site the
  // keys link to, and the colour each teammate's avatar gets. Keeping them here
  // instead of in the bundle means changing either one is a `npx convex run
  // data:setConfig` away, with no rebuild and no deploy. Written only through
  // that internal mutation; the board reads it as part of `board:get`.
  config: defineTable({
    // Jira browse root, e.g. "https://example.atlassian.net/browse". Absent
    // means the cards show their key as plain text instead of a link.
    jiraBaseUrl: v.optional(v.string()),
    // Assignee name (exactly as it appears on the ticket) → hex colour, e.g.
    // { "Some Person": "#7c2d12" }. Names absent from the map fall back to a
    // colour derived from the name in the UI.
    assigneeColors: v.optional(v.record(v.string(), v.string())),
  }),
});
