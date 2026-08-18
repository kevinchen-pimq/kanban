import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  applyCreate,
  applyDelete,
  applyMove,
  applyReorder,
  applyUpdate,
  type TicketFields,
} from "./apply";
import { credentialsValidator, requireEdit, requireRead } from "./auth";
import {
  overlayTickets,
  pendingEditValidator,
  pendingRequestsFor,
  requestCreate,
  requestDelete,
  requestMove,
  requestReorder,
  requestUpdate,
} from "./editRequests";
import {
  accentValidator,
  checkpointKindValidator,
  statusValidator,
  ticketRefValidator,
} from "./schema";

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
  /**
   * A real card's id — or, for a card that so far only exists as the caller's own
   * pending "create" proposal, that request's id. The `board:*` mutations accept
   * either (see `requireRealTicket`), so the client needs no second code path for
   * a card it can see but nobody has approved.
   */
  _id: ticketRefValidator,
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
  /**
   * Set only for the account that proposed the change: this card is showing an
   * edit request of theirs rather than what the board really says. See
   * `convex/editRequests.ts`.
   */
  pendingEdit: v.optional(pendingEditValidator),
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
 * For an account that proposes edits rather than making them, the caller's own
 * pending edit requests are overlaid on the result — their proposed board, on the
 * server, so it survives a reload and stays private to them. Everybody else sees
 * the real rows.
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
    const user = await requireRead(ctx, args.auth);

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

    const requests = await pendingRequestsFor(ctx, user);

    return {
      epics,
      checkpoints,
      tickets: overlayTickets(
        tickets,
        requests,
        new Set(checkpoints.map((checkpoint) => checkpoint._id)),
      ),
      config: config ?? null,
      hasOlder,
      truncated,
    };
  },
});

/**
 * The board's public writes.
 *
 * Everything below this line takes an `auth` credential pair and calls
 * `requireEdit` (`convex/auth.ts`) before it touches anything — the UI hides the
 * editing affordances from a read-only account, but this is the check that
 * actually holds, for the board and for any hand-written request.
 *
 * Each one then forks on what the account may do, and *only* on that:
 *
 * - `permWrite` — the change is applied now, through `apply.ts`. Unchanged
 *   behaviour, unchanged code path.
 * - otherwise `permEditRequest` — the same call becomes a pending edit request
 *   (`editRequests.ts`), validated by the same functions, waiting for somebody
 *   with `permWrite` to approve it.
 *
 * The fork is here rather than in the client on purpose: the board sends the same
 * mutation with the same arguments and the same optimistic update either way, so
 * there is no second UI to keep in step, and no way for a client to pick which
 * path it gets.
 *
 * Authenticated is not the same as trusted, so each handler still validates as
 * strictly as the importer does; the shared field checks live in `validation.ts`
 * and the shared writes in `apply.ts`. Import and config functions stay internal
 * (`data.ts`).
 *
 * None of these writes is a new source of truth. A payload re-import decides
 * again where a ticket sits and what it says, and with `pruneEpics` it deletes
 * cards the payload does not mention — including ones created here.
 */

/**
 * A card id from the client, narrowed to a real ticket.
 *
 * The direct path can only write to rows that exist. An id belonging to a pending
 * `create` request reaches here only if an account gained `permWrite` while
 * holding its own proposals, so it gets an answer that says what to do about it.
 */
function requireRealTicket(
  ctx: MutationCtx,
  ref: Id<"tickets"> | Id<"editRequests">,
): Id<"tickets"> {
  const ticketId = ctx.db.normalizeId("tickets", ref);
  if (!ticketId) {
    throw new Error(
      "這張卡片還只是一筆待審的新增提議，先在鈴鐺裡核准它，才能直接編輯。",
    );
  }
  return ticketId;
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
    ticketId: ticketRefValidator,
    /** The ticket's current epic, echoed back as a guard. */
    epicId: v.id("epics"),
    checkpointId: v.id("checkpoints"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireEdit(ctx, args.auth);

    if (user.permWrite) {
      await applyMove(ctx, {
        ticketId: requireRealTicket(ctx, args.ticketId),
        epicId: args.epicId,
        checkpointId: args.checkpointId,
      });
      return null;
    }

    await requestMove(ctx, user, {
      ref: args.ticketId,
      epicId: args.epicId,
      checkpointId: args.checkpointId,
    });
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
 * a card from somewhere else is rejected whole rather than half-applied. For a
 * proposing account "already in this cell" means *on their board*, so a card they
 * have asked to move here counts.
 */
export const reorderCell = mutation({
  args: {
    auth: credentialsValidator,
    epicId: v.id("epics"),
    checkpointId: v.id("checkpoints"),
    /** Every ticket in the cell, in the order it should be shown. */
    ticketIds: v.array(ticketRefValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireEdit(ctx, args.auth);

    if (user.permWrite) {
      await applyReorder(ctx, {
        epicId: args.epicId,
        checkpointId: args.checkpointId,
        ticketIds: args.ticketIds.map((ref) => requireRealTicket(ctx, ref)),
      });
      return null;
    }

    await requestReorder(ctx, user, {
      epicId: args.epicId,
      checkpointId: args.checkpointId,
      ticketIds: args.ticketIds,
    });
    return null;
  },
});

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
  returns: v.object({
    /** Null when the call became an edit request: no card exists yet. */
    ticketId: v.union(v.id("tickets"), v.null()),
    key: v.string(),
  }),
  handler: async (ctx, args) => {
    const user = await requireEdit(ctx, args.auth);

    const fields: TicketFields = {
      status: args.status,
      assignee: args.assignee,
      dueDate: args.dueDate,
      tag: args.tag,
      githubPrs: args.githubPrs,
    };

    if (user.permWrite) {
      return await applyCreate(ctx, {
        epicId: args.epicId,
        checkpointId: args.checkpointId,
        key: args.key,
        title: args.title,
        fields,
      });
    }

    const { key } = await requestCreate(ctx, user, {
      epicId: args.epicId,
      checkpointId: args.checkpointId,
      title: args.title,
      key: args.key,
      fields,
    });
    return { ticketId: null, key };
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
    ticketId: ticketRefValidator,
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
    const user = await requireEdit(ctx, args.auth);

    const fields: TicketFields = {
      title: args.title,
      status: args.status,
      assignee: args.assignee,
      dueDate: args.dueDate,
      tag: args.tag,
      githubPrs: args.githubPrs,
    };

    if (user.permWrite) {
      await applyUpdate(ctx, {
        ticketId: requireRealTicket(ctx, args.ticketId),
        checkpointId: args.checkpointId,
        fields,
      });
      return null;
    }

    await requestUpdate(ctx, user, {
      ref: args.ticketId,
      checkpointId: args.checkpointId,
      fields,
    });
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
  args: { auth: credentialsValidator, ticketId: ticketRefValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireEdit(ctx, args.auth);

    if (user.permWrite) {
      await applyDelete(ctx, requireRealTicket(ctx, args.ticketId));
      return null;
    }

    await requestDelete(ctx, user, args.ticketId);
    return null;
  },
});
