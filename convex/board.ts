import { v } from "convex/values";
import { query } from "./_generated/server";
import { accentValidator, checkpointKindValidator, statusValidator } from "./schema";

/**
 * Upper bound on cards fetched for one board render. A matrix that a person
 * can actually read tops out far below this, so the cap only exists to keep
 * the query from degrading into a full-table scan as the ticket table grows.
 * Crossing it is the signal to move the board onto per-cell pagination.
 */
const BOARD_TICKET_LIMIT = 2000;

const epicDoc = v.object({
  _id: v.id("epics"),
  _creationTime: v.number(),
  code: v.string(),
  name: v.string(),
  accent: accentValidator,
  order: v.number(),
});

const checkpointDoc = v.object({
  _id: v.id("checkpoints"),
  _creationTime: v.number(),
  kind: checkpointKindValidator,
  weekNumber: v.optional(v.number()),
  startDate: v.optional(v.string()),
  endDate: v.optional(v.string()),
  label: v.optional(v.string()),
  order: v.number(),
});

const ticketDoc = v.object({
  _id: v.id("tickets"),
  _creationTime: v.number(),
  key: v.string(),
  title: v.string(),
  epicId: v.id("epics"),
  checkpointId: v.id("checkpoints"),
  status: statusValidator,
  dueDate: v.optional(v.string()),
  githubPr: v.optional(v.string()),
  tag: v.optional(v.string()),
  assignee: v.optional(v.string()),
});

/**
 * Everything the board needs in one reactive subscription.
 *
 * The dataset is one team's working set, so returning it whole beats
 * per-cell queries: the client already has to hold every cell to lay the
 * matrix out, and searching/filtering stays instant without a round trip.
 *
 * `truncated` tells the UI that cards were dropped, so a silent partial board
 * is never mistaken for a complete one.
 */
export const get = query({
  args: {},
  returns: v.object({
    epics: v.array(epicDoc),
    checkpoints: v.array(checkpointDoc),
    tickets: v.array(ticketDoc),
    truncated: v.boolean(),
  }),
  handler: async (ctx) => {
    const [epics, checkpoints, tickets] = await Promise.all([
      ctx.db.query("epics").withIndex("by_order").order("asc").collect(),
      ctx.db.query("checkpoints").withIndex("by_order").order("asc").collect(),
      ctx.db
        .query("tickets")
        .withIndex("by_checkpoint_and_epic")
        .take(BOARD_TICKET_LIMIT + 1),
    ]);

    const truncated = tickets.length > BOARD_TICKET_LIMIT;

    return {
      epics,
      checkpoints,
      tickets: truncated ? tickets.slice(0, BOARD_TICKET_LIMIT) : tickets,
      truncated,
    };
  },
});
