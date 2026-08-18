import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { credentialsValidator, requireRead, requireWrite } from "./auth";
import { accentValidator, checkpointKindValidator, statusValidator } from "./schema";
import {
  assertIsoDate,
  cleanKey,
  cleanOptionalText,
  cleanPrUrls,
  cleanTitle,
} from "./validation";

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
  order: v.optional(v.number()),
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
 *
 * Requires `permRead`. Nothing about the board — not the epic names, not the
 * ticket titles — is readable without a credential the `users` table knows.
 */
export const get = query({
  args: {
    auth: credentialsValidator,
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
    await requireRead(ctx, args.auth);

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
 * The board's public writes.
 *
 * Everything below this line takes an `auth` credential pair and requires
 * `permWrite` (`convex/auth.ts`) before it touches anything — the UI hides the
 * editing affordances from a read-only account, but this is the check that
 * actually holds, for the board and for any hand-written request.
 *
 * Authenticated is not the same as trusted, so each handler still validates as
 * strictly as the importer does; the shared field checks live in
 * `validation.ts`. Import and config functions stay internal (`data.ts`).
 *
 * None of these writes is a new source of truth. A payload re-import decides
 * again where a ticket sits and what it says, and with `pruneEpics` it deletes
 * cards the payload does not mention — including ones created here.
 */

/** Resolve a ticket and check the caller's epic guard against it. */
async function ticketInEpic(
  ctx: MutationCtx,
  ticketId: Id<"tickets">,
  epicId: Id<"epics">,
) {
  const ticket = await ctx.db.get(ticketId);
  if (!ticket) throw new Error(`No ticket with id ${ticketId}`);
  if (ticket.epicId !== epicId) {
    throw new Error(
      `Ticket ${ticket.key} belongs to a different epic than the one given. ` +
        `A card cannot change epic column.`,
    );
  }
  return ticket;
}

/**
 * Number a cell 0..n-1 and return the next free position.
 *
 * `order` is optional, so a cell can hold a mix: cards someone has arranged by
 * hand, and imported cards that have never been touched. The board reads that
 * mix as "ordered cards first, then the rest by age" — which means simply taking
 * `max(order) + 1` for an arriving card would file it *above* the untouched ones
 * rather than at the end.
 *
 * So placing a card into a cell also fills in the orders the cell was missing,
 * in exactly the order the board was already showing them. The arrangement on
 * screen does not move, the mix is gone, and the arriving card genuinely lands
 * last. A cell only gets numbered when someone puts a card in it; cells nobody
 * has touched keep their orders empty and sort by age, as they always did.
 */
async function appendToCell(
  ctx: MutationCtx,
  checkpointId: Id<"checkpoints">,
  epicId: Id<"epics">,
): Promise<number> {
  const cell = await ctx.db
    .query("tickets")
    .withIndex("by_checkpoint_and_epic", (q) =>
      q.eq("checkpointId", checkpointId).eq("epicId", epicId),
    )
    .collect();

  // Same comparison as `sortCellTickets` in the UI, so numbering a cell never
  // rearranges what the reader is looking at.
  cell.sort((a, b) => {
    if (a.order !== undefined && b.order !== undefined) return a.order - b.order;
    if (a.order !== undefined) return -1;
    if (b.order !== undefined) return 1;
    return a._creationTime - b._creationTime;
  });

  await Promise.all(
    cell.map((ticket, index) =>
      ticket.order === index
        ? undefined
        : ctx.db.patch(ticket._id, { order: index }),
    ),
  );
  return cell.length;
}

/**
 * Move one card to a different checkpoint row, keeping it in its epic column.
 *
 * `epicId` is the column the card must *stay* in, not one to move it to: a
 * value that differs from the ticket's own epic is rejected. The board already
 * refuses cross-epic drops in the UI; validating here makes the rule hold for
 * any caller, and rules out an epic swap through a hand-written request.
 *
 * The card lands at the end of the target cell. Dropping it *between* two
 * specific cards of another cell is not supported: dnd-kit only previews the
 * shuffle inside the list being dragged in, so a between-cells drop would
 * animate as an append and then jump somewhere else. Within one cell, ordering
 * is `reorderCell`'s job.
 */
export const moveTicket = mutation({
  args: {
    auth: credentialsValidator,
    ticketId: v.id("tickets"),
    /** The ticket's current epic, echoed back as a guard. */
    epicId: v.id("epics"),
    checkpointId: v.id("checkpoints"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireWrite(ctx, args.auth);

    const ticket = await ticketInEpic(ctx, args.ticketId, args.epicId);

    const checkpoint = await ctx.db.get(args.checkpointId);
    if (!checkpoint) {
      throw new Error(`No checkpoint with id ${args.checkpointId}`);
    }

    if (ticket.checkpointId !== args.checkpointId) {
      await ctx.db.patch(ticket._id, {
        checkpointId: args.checkpointId,
        order: await appendToCell(ctx, args.checkpointId, args.epicId),
      });
    }
    return null;
  },
});

/**
 * Write the order of every card in one cell.
 *
 * The client sends the cell's complete list of ticket ids, top to bottom, and
 * each one is stamped with its index. Sending the whole list rather than "card X
 * moved to position 3" keeps the stored order dense and makes the write
 * idempotent: replaying it lands on the same arrangement.
 *
 * One write per drop, not per hover — dnd-kit previews the shuffle with
 * transforms while the pointer moves, so nothing needs saving until the card is
 * let go.
 *
 * Every ticket must already be in this cell and in this epic; a list that names
 * a card from somewhere else is rejected whole rather than half-applied.
 */
export const reorderCell = mutation({
  args: {
    auth: credentialsValidator,
    epicId: v.id("epics"),
    checkpointId: v.id("checkpoints"),
    /** Every ticket in the cell, in the order it should be shown. */
    ticketIds: v.array(v.id("tickets")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireWrite(ctx, args.auth);

    const seen = new Set<string>();
    for (const ticketId of args.ticketIds) {
      if (seen.has(ticketId)) {
        throw new Error(`Ticket ${ticketId} is listed twice`);
      }
      seen.add(ticketId);
    }

    const tickets = await Promise.all(
      args.ticketIds.map((ticketId) => ticketInEpic(ctx, ticketId, args.epicId)),
    );

    for (const ticket of tickets) {
      if (ticket.checkpointId !== args.checkpointId) {
        throw new Error(
          `Ticket ${ticket.key} is not in the checkpoint being reordered. ` +
            `Move it first, then reorder.`,
        );
      }
    }

    await Promise.all(
      tickets.map((ticket, index) =>
        ticket.order === index
          ? undefined
          : ctx.db.patch(ticket._id, { order: index }),
      ),
    );
    return null;
  },
});

/** Prefix and shape of the keys generated for cards created on the board. */
const LOCAL_KEY_PREFIX = "LOCAL-";
const LOCAL_KEY = /^LOCAL-(\d+)$/;

/**
 * Next free `LOCAL-<n>` key.
 *
 * Cards created on the board have no Jira issue behind them, so they get a key
 * that says so at a glance instead of something that looks like a real ticket.
 * The number is one past the highest existing one, found through the key index
 * rather than by scanning the table.
 */
async function nextLocalKey(ctx: MutationCtx): Promise<string> {
  const existing = await ctx.db
    .query("tickets")
    .withIndex("by_key", (q) =>
      q.gte("key", LOCAL_KEY_PREFIX).lt("key", "LOCAL."),
    )
    .collect();

  let max = 0;
  for (const ticket of existing) {
    const match = LOCAL_KEY.exec(ticket.key);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${LOCAL_KEY_PREFIX}${max + 1}`;
}

async function assertKeyIsFree(ctx: MutationCtx, key: string) {
  const clash = await ctx.db
    .query("tickets")
    .withIndex("by_key", (q) => q.eq("key", key))
    .first();
  if (clash) {
    throw new Error(
      `A ticket with key ${key} is already on the board. Keys identify a card ` +
        `across imports, so they have to be unique.`,
    );
  }
}

/**
 * Create a card directly on the board.
 *
 * `key` is optional: give one to match a real Jira issue (it must be free), or
 * leave it out and get a generated `LOCAL-<n>`, which reads as "this card was
 * typed here, it is not a Jira issue". Either way the payload still wins later —
 * a `pruneEpics` re-import of this epic deletes cards it does not mention, this
 * one included.
 */
export const createTicket = mutation({
  args: {
    auth: credentialsValidator,
    title: v.string(),
    epicId: v.id("epics"),
    checkpointId: v.id("checkpoints"),
    key: v.optional(v.string()),
    status: v.optional(statusValidator),
    assignee: v.optional(v.string()),
    dueDate: v.optional(v.string()),
    tag: v.optional(v.string()),
    githubPrs: v.optional(v.array(v.string())),
  },
  returns: v.object({ ticketId: v.id("tickets"), key: v.string() }),
  handler: async (ctx, args) => {
    await requireWrite(ctx, args.auth);

    const epic = await ctx.db.get(args.epicId);
    if (!epic) throw new Error(`No epic with id ${args.epicId}`);
    const checkpoint = await ctx.db.get(args.checkpointId);
    if (!checkpoint) {
      throw new Error(`No checkpoint with id ${args.checkpointId}`);
    }

    const title = cleanTitle(args.title);
    assertIsoDate(args.dueDate, "dueDate");

    let key: string;
    if (args.key !== undefined && args.key.trim() !== "") {
      key = cleanKey(args.key);
      await assertKeyIsFree(ctx, key);
    } else {
      key = await nextLocalKey(ctx);
    }

    const ticketId = await ctx.db.insert("tickets", {
      key,
      title,
      epicId: args.epicId,
      checkpointId: args.checkpointId,
      status: args.status ?? "todo",
      dueDate: args.dueDate,
      githubPrs: args.githubPrs ? cleanPrUrls(args.githubPrs) : undefined,
      tag: cleanOptionalText(args.tag, "tag"),
      assignee: cleanOptionalText(args.assignee, "assignee"),
      // New cards go under whatever is already in the cell.
      order: await appendToCell(ctx, args.checkpointId, args.epicId),
    });

    return { ticketId, key };
  },
});

/**
 * Edit a card's fields.
 *
 * Only the fields present in the call change, so the status dot can send status
 * alone. `null` clears an optional field — the difference matters: leaving
 * `assignee` out keeps the current one, passing `null` unassigns the card.
 *
 * Two things are deliberately not editable here. **Epic** is fixed for the same
 * reason dragging across columns is refused: which project a ticket belongs to
 * comes from Jira, and a board that can silently move work between projects
 * makes the matrix lie. **Key** is fixed because it is what the importer matches
 * on; renaming it would orphan the card and re-create it on the next import.
 */
export const updateTicket = mutation({
  args: {
    auth: credentialsValidator,
    ticketId: v.id("tickets"),
    title: v.optional(v.string()),
    checkpointId: v.optional(v.id("checkpoints")),
    status: v.optional(statusValidator),
    assignee: v.optional(v.union(v.string(), v.null())),
    dueDate: v.optional(v.union(v.string(), v.null())),
    tag: v.optional(v.union(v.string(), v.null())),
    githubPrs: v.optional(v.union(v.array(v.string()), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireWrite(ctx, args.auth);

    const ticket = await ctx.db.get(args.ticketId);
    if (!ticket) throw new Error(`No ticket with id ${args.ticketId}`);

    const patch: Partial<Doc<"tickets">> = {};

    if (args.title !== undefined) patch.title = cleanTitle(args.title);
    if (args.status !== undefined) patch.status = args.status;

    if (args.checkpointId !== undefined) {
      const checkpoint = await ctx.db.get(args.checkpointId);
      if (!checkpoint) {
        throw new Error(`No checkpoint with id ${args.checkpointId}`);
      }
      if (checkpoint._id !== ticket.checkpointId) {
        patch.checkpointId = args.checkpointId;
        patch.order = await appendToCell(ctx, args.checkpointId, ticket.epicId);
      }
    }

    if (args.assignee !== undefined) {
      patch.assignee = cleanOptionalText(args.assignee, "assignee");
    }
    if (args.tag !== undefined) {
      patch.tag = cleanOptionalText(args.tag, "tag");
    }
    if (args.dueDate !== undefined) {
      const dueDate = args.dueDate?.trim() || undefined;
      assertIsoDate(dueDate, "dueDate");
      patch.dueDate = dueDate;
    }
    if (args.githubPrs !== undefined) {
      const urls = args.githubPrs?.filter((url) => url.trim() !== "") ?? [];
      patch.githubPrs = urls.length > 0 ? cleanPrUrls(urls) : undefined;
    }

    await ctx.db.patch(ticket._id, patch);
    return null;
  },
});

/**
 * Delete one card.
 *
 * No soft delete and no undo: the board is a view of work tracked in Jira, so
 * the payload can put back anything deleted here by mistake. The UI asks for a
 * second click before calling this.
 */
export const deleteTicket = mutation({
  args: { auth: credentialsValidator, ticketId: v.id("tickets") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireWrite(ctx, args.auth);

    const ticket = await ctx.db.get(args.ticketId);
    if (!ticket) throw new Error(`No ticket with id ${args.ticketId}`);
    await ctx.db.delete(ticket._id);
    return null;
  },
});
