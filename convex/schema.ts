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
  })
    .index("by_key", ["key"])
    .index("by_checkpoint_and_epic", ["checkpointId", "epicId"]),
});
