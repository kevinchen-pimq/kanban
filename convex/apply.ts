import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  assertIsoDate,
  cleanKey,
  cleanOptionalText,
  cleanPrUrls,
  cleanTitle,
} from "./validation";

/**
 * Every write the board makes to `tickets`, in one place.
 *
 * Two callers reach these functions: the public `board:*` mutations, when the
 * account holds `permWrite` and its edit lands straight away, and
 * `editRequests:approve`, when a reviewer replays somebody else's proposal.
 * Sharing the code is what makes "approved" mean *exactly* the same thing as
 * "written directly" — same guards, same field validation, same cell ordering —
 * instead of a second implementation that slowly drifts from the first.
 *
 * Nothing in here checks permissions or touches `editRequests`: the callers do
 * that. These functions only know how to change the board correctly, and they
 * throw a readable error when the change is not allowed.
 */

export type TicketStatus = Doc<"tickets">["status"];

/**
 * The editable half of a card, in the shape both callers speak.
 *
 * A field that is absent is left alone; `null` clears it. That difference is the
 * whole reason this is not `Partial<Doc<"tickets">>`: leaving `assignee` out
 * keeps the current assignee, passing `null` unassigns the card, and an edit
 * request has to be able to store the second one.
 */
export type TicketFields = {
  title?: string;
  status?: TicketStatus;
  assignee?: string | null;
  dueDate?: string | null;
  tag?: string | null;
  githubPrs?: readonly string[] | null;
};

/**
 * Validate and normalise the fields of an edit, without writing anything.
 *
 * Both paths run this at the moment the user asks: a proposal that would be
 * refused on approval should never have been stored, so an edit request is
 * validated exactly as strictly as a direct write. Only the fields present in
 * the input come back, so "not mentioned" stays distinguishable from "cleared".
 */
export function cleanTicketFields(fields: TicketFields): TicketFields {
  const clean: TicketFields = {};

  if (fields.title !== undefined) clean.title = cleanTitle(fields.title);
  if (fields.status !== undefined) clean.status = fields.status;
  if (fields.assignee !== undefined) {
    clean.assignee = cleanOptionalText(fields.assignee, "assignee") ?? null;
  }
  if (fields.tag !== undefined) {
    clean.tag = cleanOptionalText(fields.tag, "tag") ?? null;
  }
  if (fields.dueDate !== undefined) {
    const dueDate = fields.dueDate?.trim() || null;
    assertIsoDate(dueDate ?? undefined, "dueDate");
    clean.dueDate = dueDate;
  }
  if (fields.githubPrs !== undefined) {
    const urls = fields.githubPrs?.filter((url) => url.trim() !== "") ?? [];
    clean.githubPrs = urls.length > 0 ? cleanPrUrls(urls) : null;
  }

  return clean;
}

/** Cleaned fields as a document patch: `null` becomes "field absent". */
function toPatch(fields: TicketFields): Partial<Doc<"tickets">> {
  const patch: Partial<Doc<"tickets">> = {};
  if (fields.title !== undefined) patch.title = fields.title;
  if (fields.status !== undefined) patch.status = fields.status;
  if (fields.assignee !== undefined) patch.assignee = fields.assignee ?? undefined;
  if (fields.tag !== undefined) patch.tag = fields.tag ?? undefined;
  if (fields.dueDate !== undefined) patch.dueDate = fields.dueDate ?? undefined;
  if (fields.githubPrs !== undefined) {
    patch.githubPrs = fields.githubPrs ? [...fields.githubPrs] : undefined;
  }
  return patch;
}

/** Resolve a ticket and check the caller's epic guard against it. */
export async function ticketInEpic(
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

/** The checkpoint row, or a readable error if it is gone. */
export async function requireCheckpoint(
  ctx: MutationCtx,
  checkpointId: Id<"checkpoints">,
) {
  const checkpoint = await ctx.db.get(checkpointId);
  if (!checkpoint) throw new Error(`No checkpoint with id ${checkpointId}`);
  return checkpoint;
}

/** The epic column, or a readable error if it is gone. */
export async function requireEpic(ctx: MutationCtx, epicId: Id<"epics">) {
  const epic = await ctx.db.get(epicId);
  if (!epic) throw new Error(`No epic with id ${epicId}`);
  return epic;
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
  cell.sort(byCellPosition);

  await Promise.all(
    cell.map((ticket, index) =>
      ticket.order === index
        ? undefined
        : ctx.db.patch(ticket._id, { order: index }),
    ),
  );
  return cell.length;
}

/** Display order within a cell: arranged cards first, then the rest by age. */
export function byCellPosition(
  a: { order?: number; _creationTime: number },
  b: { order?: number; _creationTime: number },
): number {
  if (a.order !== undefined && b.order !== undefined) return a.order - b.order;
  if (a.order !== undefined) return -1;
  if (b.order !== undefined) return 1;
  return a._creationTime - b._creationTime;
}

/** Prefix and shape of the keys generated for cards created on the board. */
const LOCAL_KEY_PREFIX = "LOCAL-";
const LOCAL_KEY = /^LOCAL-(\d+)$/;

/**
 * Next free `LOCAL-<n>` key.
 *
 * Cards created on the board have no Jira issue behind them, so they get a key
 * that says so at a glance instead of something that looks like a real ticket.
 * The number is one past the highest existing one, found through the key index
 * rather than by scanning the table — and one past any key a pending create
 * request has already claimed, so two proposals in flight do not both ask for
 * `LOCAL-7`.
 */
async function nextLocalKey(ctx: MutationCtx): Promise<string> {
  const [existing, requests] = await Promise.all([
    ctx.db
      .query("tickets")
      .withIndex("by_key", (q) =>
        q.gte("key", LOCAL_KEY_PREFIX).lt("key", "LOCAL."),
      )
      .collect(),
    ctx.db.query("editRequests").take(500),
  ]);

  const keys = [
    ...existing.map((ticket) => ticket.key),
    ...requests.map((request) => request.fields?.key ?? ""),
  ];

  let max = 0;
  for (const key of keys) {
    const match = LOCAL_KEY.exec(key);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${LOCAL_KEY_PREFIX}${max + 1}`;
}

/** Refuse a key another card already carries; keys identify a card across imports. */
export async function assertKeyIsFree(ctx: MutationCtx, key: string) {
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
 * The key a new card should carry: the one that was typed (it must be free), or
 * a generated `LOCAL-<n>` that reads as "this card was typed here".
 */
export async function resolveNewKey(
  ctx: MutationCtx,
  key: string | undefined,
): Promise<string> {
  if (key !== undefined && key.trim() !== "") {
    const clean = cleanKey(key);
    await assertKeyIsFree(ctx, clean);
    return clean;
  }
  return await nextLocalKey(ctx);
}

/** Create a card. `key` is already resolved and checked by `resolveNewKey`. */
export async function applyCreate(
  ctx: MutationCtx,
  args: {
    epicId: Id<"epics">;
    checkpointId: Id<"checkpoints">;
    key?: string;
    title: string;
    fields?: TicketFields;
  },
): Promise<{ ticketId: Id<"tickets">; key: string }> {
  await requireEpic(ctx, args.epicId);
  await requireCheckpoint(ctx, args.checkpointId);

  const fields = cleanTicketFields(args.fields ?? {});
  const key = await resolveNewKey(ctx, args.key);

  const ticketId = await ctx.db.insert("tickets", {
    key,
    title: cleanTitle(args.title),
    epicId: args.epicId,
    checkpointId: args.checkpointId,
    status: fields.status ?? "todo",
    assignee: fields.assignee ?? undefined,
    dueDate: fields.dueDate ?? undefined,
    tag: fields.tag ?? undefined,
    githubPrs: fields.githubPrs ? [...fields.githubPrs] : undefined,
    // New cards go under whatever is already in the cell.
    order: await appendToCell(ctx, args.checkpointId, args.epicId),
  });

  return { ticketId, key };
}

/**
 * Edit a card's fields, and optionally its row.
 *
 * Epic and key are not editable here for the same reasons the board refuses a
 * cross-column drag: which project a ticket belongs to comes from Jira, and the
 * key is what the importer matches on.
 */
export async function applyUpdate(
  ctx: MutationCtx,
  args: {
    ticketId: Id<"tickets">;
    checkpointId?: Id<"checkpoints">;
    fields?: TicketFields;
  },
): Promise<void> {
  const ticket = await ctx.db.get(args.ticketId);
  if (!ticket) throw new Error(`No ticket with id ${args.ticketId}`);

  const patch = toPatch(cleanTicketFields(args.fields ?? {}));

  if (args.checkpointId !== undefined) {
    const checkpoint = await requireCheckpoint(ctx, args.checkpointId);
    if (checkpoint._id !== ticket.checkpointId) {
      patch.checkpointId = args.checkpointId;
      patch.order = await appendToCell(ctx, args.checkpointId, ticket.epicId);
    }
  }

  await ctx.db.patch(ticket._id, patch);
}

/**
 * Move one card to a different checkpoint row, keeping it in its epic column.
 *
 * `epicId` is the column the card must *stay* in, not one to move it to: a value
 * that differs from the ticket's own epic is rejected. The card lands at the end
 * of the target cell; arranging it within a cell is `applyReorder`'s job.
 */
export async function applyMove(
  ctx: MutationCtx,
  args: {
    ticketId: Id<"tickets">;
    epicId: Id<"epics">;
    checkpointId: Id<"checkpoints">;
  },
): Promise<void> {
  const ticket = await ticketInEpic(ctx, args.ticketId, args.epicId);
  await requireCheckpoint(ctx, args.checkpointId);

  if (ticket.checkpointId !== args.checkpointId) {
    await ctx.db.patch(ticket._id, {
      checkpointId: args.checkpointId,
      order: await appendToCell(ctx, args.checkpointId, args.epicId),
    });
  }
}

/**
 * Write the order of every card in one cell.
 *
 * The caller sends the cell's complete list of ticket ids, top to bottom, and
 * each one is stamped with its index. Sending the whole list rather than "card X
 * moved to position 3" keeps the stored order dense and makes the write
 * idempotent: replaying it lands on the same arrangement.
 *
 * Every ticket must already be in this cell and in this epic; a list that names
 * a card from somewhere else is rejected whole rather than half-applied.
 */
export async function applyReorder(
  ctx: MutationCtx,
  args: {
    epicId: Id<"epics">;
    checkpointId: Id<"checkpoints">;
    ticketIds: readonly Id<"tickets">[];
  },
): Promise<void> {
  const seen = new Set<string>();
  for (const ticketId of args.ticketIds) {
    if (seen.has(ticketId)) throw new Error(`Ticket ${ticketId} is listed twice`);
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
}

/**
 * Delete one card.
 *
 * No soft delete and no undo: the board is a view of work tracked in Jira, so
 * the payload can put back anything deleted here by mistake.
 */
export async function applyDelete(
  ctx: MutationCtx,
  ticketId: Id<"tickets">,
): Promise<void> {
  const ticket = await ctx.db.get(ticketId);
  if (!ticket) throw new Error(`No ticket with id ${ticketId}`);
  await ctx.db.delete(ticket._id);
}
