import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { accentValidator, checkpointKindValidator, statusValidator } from "./schema";

/**
 * Upper bound on cards fetched for one board render. A matrix that a person
 * can actually read tops out far below this, so the cap only exists to keep
 * the query from degrading into a full-table scan as the ticket table grows.
 * Crossing it is the signal to narrow the window further.
 */
const BOARD_TICKET_LIMIT = 2000;

/** Guard on the checkpoint axis; a board with more rows than this is unusable. */
const CHECKPOINT_LIMIT = 500;

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
  githubPrs: v.optional(v.array(v.string())),
  tag: v.optional(v.string()),
  assignee: v.optional(v.string()),
});

const configDoc = v.object({
  _id: v.id("config"),
  _creationTime: v.number(),
  jiraBaseUrl: v.optional(v.string()),
  assigneeColors: v.optional(v.record(v.string(), v.string())),
});

/**
 * A week belongs to the window when any part of it falls on or after
 * `fromDate`. The backlog row has no dates and is always in: it is the
 * undated pool, not a point in time.
 */
function isInWindow(checkpoint: Doc<"checkpoints">, fromDate: string | undefined) {
  if (checkpoint.kind === "backlog") return true;
  if (!fromDate || !checkpoint.endDate) return true;
  return checkpoint.endDate >= fromDate;
}

/**
 * The board for one time window, in a single reactive subscription.
 *
 * `fromDate` trims the checkpoint axis to weeks ending on or after it, so a
 * board carrying years of delivery history does not have to ship all of it to
 * render the recent weeks. The client widens the window as the reader scrolls
 * up, and `hasOlder` tells it when to stop asking.
 *
 * Tickets are fetched per included checkpoint through the index rather than
 * scanned wholesale, so the cost tracks the window rather than the table.
 *
 * The board's configuration rides along in the same result rather than living in
 * a query of its own: it is one small document that every card needs, and the
 * board already has exactly one subscription to keep track of. A second query
 * would add a second loading state, and cards would paint once without their
 * Jira links and again with them.
 */
export const get = query({
  args: {
    /** ISO date, "YYYY-MM-DD". Omit for the whole history. */
    fromDate: v.optional(v.string()),
  },
  returns: v.object({
    epics: v.array(epicDoc),
    checkpoints: v.array(checkpointDoc),
    tickets: v.array(ticketDoc),
    /** Board settings, or null when this deployment has none set yet. */
    config: v.union(configDoc, v.null()),
    /** True when weeks exist before the window, i.e. scrolling up can load more. */
    hasOlder: v.boolean(),
    /** True when the ticket cap clipped the result, so the board can say so. */
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const [epics, allCheckpoints, config] = await Promise.all([
      ctx.db.query("epics").withIndex("by_order").order("asc").collect(),
      ctx.db.query("checkpoints").withIndex("by_order").order("asc").take(CHECKPOINT_LIMIT),
      ctx.db.query("config").first(),
    ]);

    // Row order is derived, not trusted. Weeks carry real dates, so sorting on
    // them makes a mis-assigned `order` in an import payload unable to scramble
    // the axis. The undated backlog pool always sits last.
    const checkpoints = allCheckpoints
      .filter((c) => isInWindow(c, args.fromDate))
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "backlog" ? 1 : -1;
        if (a.kind === "backlog") return a.order - b.order;
        return (a.startDate ?? "").localeCompare(b.startDate ?? "");
      });

    const hasOlder = checkpoints.length < allCheckpoints.length;

    const tickets: Doc<"tickets">[] = [];
    let truncated = false;
    for (const checkpoint of checkpoints) {
      if (tickets.length >= BOARD_TICKET_LIMIT) {
        truncated = true;
        break;
      }
      const page = await ctx.db
        .query("tickets")
        .withIndex("by_checkpoint_and_epic", (q) =>
          q.eq("checkpointId", checkpoint._id as Id<"checkpoints">),
        )
        .take(BOARD_TICKET_LIMIT - tickets.length + 1);

      if (tickets.length + page.length > BOARD_TICKET_LIMIT) {
        truncated = true;
        tickets.push(...page.slice(0, BOARD_TICKET_LIMIT - tickets.length));
      } else {
        tickets.push(...page);
      }
    }

    return {
      epics,
      checkpoints,
      tickets,
      config: config ?? null,
      hasOlder,
      truncated,
    };
  },
});

/**
 * Move one card to a different checkpoint row, keeping it in its epic column.
 *
 * This is the board's only public write, and it is **unauthenticated**: there
 * is no auth system in front of the board, so anyone who can load the site can
 * re-date a card. That is the accepted trade for the drag-and-drop the team
 * asked for on an internal, unlisted deployment — if the board is ever exposed
 * more widely, this handler is the one place to put a check.
 *
 * `epicId` is the column the card must *stay* in, not one to move it to: a
 * value that differs from the ticket's own epic is rejected. The board already
 * refuses cross-epic drops in the UI; validating here makes the rule hold for
 * any caller, and rules out an epic swap through a hand-written request.
 *
 * A move is not a new source of truth. Re-importing the epic's payload puts the
 * ticket back in the week the payload says, since the payload still decides
 * where a ticket belongs.
 */
export const moveTicket = mutation({
  args: {
    ticketId: v.id("tickets"),
    /** The ticket's current epic, echoed back as a guard. */
    epicId: v.id("epics"),
    checkpointId: v.id("checkpoints"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const ticket = await ctx.db.get(args.ticketId);
    if (!ticket) throw new Error(`No ticket with id ${args.ticketId}`);

    if (ticket.epicId !== args.epicId) {
      throw new Error(
        `Ticket ${ticket.key} belongs to a different epic than the drop target. ` +
          `A move may change the checkpoint row only.`,
      );
    }

    const checkpoint = await ctx.db.get(args.checkpointId);
    if (!checkpoint) {
      throw new Error(`No checkpoint with id ${args.checkpointId}`);
    }

    if (ticket.checkpointId !== args.checkpointId) {
      await ctx.db.patch(ticket._id, { checkpointId: args.checkpointId });
    }
    return null;
  },
});
