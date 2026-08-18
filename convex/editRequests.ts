import { v } from "convex/values";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  applyCreate,
  applyDelete,
  applyReorder,
  applyUpdate,
  byCellPosition,
  cleanTicketFields,
  requireCheckpoint,
  requireEpic,
  resolveNewKey,
  ticketInEpic,
  type TicketFields,
} from "./apply";
import {
  AUTH_DENIED,
  credentialsValidator,
  requirePermission,
  requireWrite,
} from "./auth";
import { editRequestKindValidator } from "./schema";
import { cleanTitle } from "./validation";

/**
 * Proposed edits: the board's write path for an account that may ask but not
 * decide.
 *
 * An account with `permEditRequest` and no `permWrite` sees the full editing
 * board — drag between weeks, reorder, create, edit, delete, cycle the status dot
 * — and every one of those calls the same `board:*` mutation everybody else does.
 * The mutation is what forks: `permWrite` applies the change, anything else
 * records it here. That keeps one call surface and one set of optimistic updates
 * in the client, and it keeps the validation honest, because a request is
 * validated by the same functions that would have written it (`apply.ts`).
 *
 * Three ideas carry the whole feature:
 *
 * **Overlay.** `board:get` folds the caller's own pending requests onto the board
 * it returns, so the requester sees their proposal as if it had happened —
 * created cards appear, deleted ones vanish, moves and edits show through — while
 * everyone else still sees the real data. It lives on the server, so a reload
 * changes nothing.
 *
 * **Merge.** There is at most one request per (requester, target). A second
 * operation on the same card folds into the row already there, so "moved it, then
 * retitled it" is one request with one diff; a delete supersedes whatever was
 * pending; deleting a card that only existed as a proposal removes the proposal
 * entirely; and an edit that puts a field back where it started disappears.
 * Reorders merge per cell, last one wins.
 *
 * **Replay.** Approving runs `apply.ts` against today's data, so approval is
 * exactly as validated as a direct write — and fails loudly when the board moved
 * underneath the request (the card was deleted, the key got taken). A failed
 * approval keeps the request; the reviewer can dismiss it.
 *
 * Requests are not an audit log: approving or dismissing deletes the row.
 */

/** Plenty for a live queue; a board with more pending than this has a process problem. */
const MAX_REQUESTS = 500;

type EditRequest = Doc<"editRequests">;
type EditRequestKind = EditRequest["kind"];
/** The stored field shape: absent = untouched, null = cleared. */
type EditFields = NonNullable<EditRequest["fields"]>;
/** A card id as the client sends it: a real ticket, or a pending `create`. */
type TicketRef = Id<"tickets"> | Id<"editRequests">;

/** Marker `board:get` puts on a card the caller has a pending request for. */
export type PendingEdit = {
  requestId: Id<"editRequests">;
  kind: EditRequestKind;
};

/** A board ticket as the requester sees it: possibly patched, possibly invented. */
export type BoardTicket = Doc<"tickets"> & { pendingEdit?: PendingEdit };

export const pendingEditValidator = v.object({
  requestId: v.id("editRequests"),
  kind: editRequestKindValidator,
});

// ---------------------------------------------------------------------------
// Field plumbing
// ---------------------------------------------------------------------------

/** Cleaned edit fields in the shape the table stores. */
function toEditFields(fields: TicketFields): EditFields {
  const stored: EditFields = {};
  if (fields.title !== undefined) stored.title = fields.title;
  if (fields.status !== undefined) stored.status = fields.status;
  if (fields.assignee !== undefined) stored.assignee = fields.assignee;
  if (fields.dueDate !== undefined) stored.dueDate = fields.dueDate;
  if (fields.tag !== undefined) stored.tag = fields.tag;
  if (fields.githubPrs !== undefined) {
    stored.githubPrs = fields.githubPrs ? [...fields.githubPrs] : null;
  }
  return stored;
}

/** Stored edit fields as `apply.ts` takes them (row and key are separate there). */
function toTicketFields(fields: EditFields): TicketFields {
  const { title, status, assignee, dueDate, tag, githubPrs } = fields;
  const out: TicketFields = {};
  if (title !== undefined) out.title = title;
  if (status !== undefined) out.status = status;
  if (assignee !== undefined) out.assignee = assignee;
  if (dueDate !== undefined) out.dueDate = dueDate;
  if (tag !== undefined) out.tag = tag;
  if (githubPrs !== undefined) out.githubPrs = githubPrs;
  return out;
}

/**
 * The card as it is now, as the left-hand side of a diff.
 *
 * Absent optional fields become `null` rather than staying absent, so comparing
 * "what was asked for" against "what it said" needs no special cases: both sides
 * speak the same language for an empty assignee.
 */
function snapshot(ticket: Doc<"tickets">): EditFields {
  return {
    key: ticket.key,
    title: ticket.title,
    checkpointId: ticket.checkpointId,
    status: ticket.status,
    assignee: ticket.assignee ?? null,
    dueDate: ticket.dueDate ?? null,
    tag: ticket.tag ?? null,
    githubPrs: ticket.githubPrs ?? null,
  };
}

const CHANGEABLE = [
  "checkpointId",
  "title",
  "status",
  "assignee",
  "dueDate",
  "tag",
  "githubPrs",
] as const satisfies readonly (keyof EditFields)[];

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Drop everything the card already says.
 *
 * A field asked to become what it already is, is not a change: retitling A → B
 * → A leaves an empty request, and an empty request is deleted rather than left
 * for somebody to approve into a no-op.
 */
function withoutNoOps(asked: EditFields, before: EditFields): EditFields {
  const kept: EditFields = {};
  for (const field of CHANGEABLE) {
    if (asked[field] === undefined) continue;
    if (sameValue(asked[field], before[field])) continue;
    Object.assign(kept, { [field]: asked[field] });
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

async function myRequests(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<EditRequest[]> {
  return await ctx.db
    .query("editRequests")
    .withIndex("by_requester", (q) => q.eq("requestedBy", userId))
    .take(MAX_REQUESTS);
}

/** The one pending `update`/`delete` this account has for a card, if any. */
async function myRequestForTicket(
  ctx: QueryCtx,
  userId: Id<"users">,
  ticketId: Id<"tickets">,
): Promise<EditRequest | null> {
  const requests = await myRequests(ctx, userId);
  return (
    requests.find(
      (request) =>
        request.ticketId === ticketId &&
        (request.kind === "update" || request.kind === "delete"),
    ) ?? null
  );
}

type Target =
  | { kind: "ticket"; ticket: Doc<"tickets"> }
  /** One of the caller's own pending `create` requests — a card that isn't real yet. */
  | { kind: "proposed"; request: EditRequest };

/**
 * What a card id from the client points at.
 *
 * A proposed card carries its request's id (see `ticketRefValidator`), which is
 * how "create then edit" and "create then delete" reach the row they need to
 * merge into. Somebody else's request is not a valid target: it is not on this
 * caller's board.
 */
async function resolveRef(
  ctx: MutationCtx,
  user: Doc<"users">,
  ref: TicketRef,
): Promise<Target> {
  const requestId = ctx.db.normalizeId("editRequests", ref);
  if (requestId) {
    const request = await ctx.db.get(requestId);
    if (
      !request ||
      request.kind !== "create" ||
      request.requestedBy !== user._id
    ) {
      throw new Error("這張待審的新卡片已經不存在了，重新載入看板再試一次。");
    }
    return { kind: "proposed", request };
  }

  const ticketId = ctx.db.normalizeId("tickets", ref);
  if (!ticketId) throw new Error(`不認得的卡片 id ${ref}`);
  const ticket = await ctx.db.get(ticketId);
  if (!ticket) throw new Error(`No ticket with id ${ticketId}`);
  return { kind: "ticket", ticket };
}

// ---------------------------------------------------------------------------
// Writing requests — the `permEditRequest` half of every board mutation
// ---------------------------------------------------------------------------

/** Propose a new card. Validated exactly as `applyCreate` would validate it. */
export async function requestCreate(
  ctx: MutationCtx,
  user: Doc<"users">,
  args: {
    epicId: Id<"epics">;
    checkpointId: Id<"checkpoints">;
    title: string;
    key?: string;
    fields: TicketFields;
  },
): Promise<{ key: string }> {
  await requireEpic(ctx, args.epicId);
  await requireCheckpoint(ctx, args.checkpointId);

  const fields = toEditFields(cleanTicketFields(args.fields));
  // Resolved now rather than at approval so the card on the requester's board
  // shows the key it would get; `applyCreate` checks it is still free later.
  const key = await resolveNewKey(ctx, args.key);

  await ctx.db.insert("editRequests", {
    requestedBy: user._id,
    account: user.account,
    kind: "create",
    epicId: args.epicId,
    checkpointId: args.checkpointId,
    fields: { ...fields, key, title: cleanTitle(args.title) },
  });

  return { key };
}

/**
 * Fold a change to one card into this account's pending request for it.
 *
 * This is the merge: an existing request is patched rather than joined by a
 * second one, and its `before` snapshot is kept from the first touch, so the
 * reviewer sees "what it said originally → what is being asked for now" however
 * many times the requester adjusted it.
 */
async function mergeChange(
  ctx: MutationCtx,
  user: Doc<"users">,
  target: Target,
  change: { checkpointId?: Id<"checkpoints">; fields: TicketFields },
): Promise<void> {
  const fields = toEditFields(cleanTicketFields(change.fields));
  if (change.checkpointId !== undefined) {
    await requireCheckpoint(ctx, change.checkpointId);
  }

  // A card that only exists as a proposal: keep it one `create` request carrying
  // the final field values, so approving it creates the card the requester sees.
  if (target.kind === "proposed") {
    const { request } = target;
    await ctx.db.patch(request._id, {
      checkpointId: change.checkpointId ?? request.checkpointId,
      fields: { ...request.fields, ...fields },
    });
    return;
  }

  const { ticket } = target;
  const existing = await myRequestForTicket(ctx, user._id, ticket._id);
  if (existing?.kind === "delete") {
    throw new Error(
      `卡片 ${ticket.key} 已經有一筆待審的刪除提議，先撤回它才能提議其他修改。`,
    );
  }

  const before = existing?.before ?? snapshot(ticket);
  const asked: EditFields = { ...existing?.fields, ...fields };
  if (change.checkpointId !== undefined) asked.checkpointId = change.checkpointId;

  const merged = withoutNoOps(asked, before);
  if (Object.keys(merged).length === 0) {
    // Everything is back where it started; there is nothing left to approve.
    if (existing) await ctx.db.delete(existing._id);
    return;
  }

  if (existing) {
    await ctx.db.patch(existing._id, { fields: merged, before });
    return;
  }
  await ctx.db.insert("editRequests", {
    requestedBy: user._id,
    account: user.account,
    kind: "update",
    ticketId: ticket._id,
    before,
    fields: merged,
  });
}

/** Propose editing a card's fields (and possibly its week). */
export async function requestUpdate(
  ctx: MutationCtx,
  user: Doc<"users">,
  args: {
    ref: TicketRef;
    checkpointId?: Id<"checkpoints">;
    fields: TicketFields;
  },
): Promise<void> {
  const target = await resolveRef(ctx, user, args.ref);
  await mergeChange(ctx, user, target, {
    checkpointId: args.checkpointId,
    fields: args.fields,
  });
}

/**
 * Propose moving a card to another week.
 *
 * `epicId` is the guard the direct path uses too: a card may change rows, never
 * columns, and a mismatch is refused rather than silently reassigning the work.
 */
export async function requestMove(
  ctx: MutationCtx,
  user: Doc<"users">,
  args: {
    ref: TicketRef;
    epicId: Id<"epics">;
    checkpointId: Id<"checkpoints">;
  },
): Promise<void> {
  const target = await resolveRef(ctx, user, args.ref);

  if (target.kind === "proposed") {
    if (target.request.epicId !== args.epicId) {
      throw new Error("卡片不能換到別的 Epic 欄位。");
    }
  } else {
    await ticketInEpic(ctx, target.ticket._id, args.epicId);
  }

  await mergeChange(ctx, user, target, {
    checkpointId: args.checkpointId,
    fields: {},
  });
}

/**
 * Propose deleting a card.
 *
 * A delete supersedes anything else pending for that card — there is no point
 * approving a retitle of a card that is about to go — but keeps the original
 * `before` snapshot so the reviewer still sees which card it is. Deleting a card
 * that was itself only a proposal takes the proposal away: create-then-delete
 * asked for nothing.
 */
export async function requestDelete(
  ctx: MutationCtx,
  user: Doc<"users">,
  ref: TicketRef,
): Promise<void> {
  const target = await resolveRef(ctx, user, ref);

  if (target.kind === "proposed") {
    await ctx.db.delete(target.request._id);
    return;
  }

  const { ticket } = target;
  const existing = await myRequestForTicket(ctx, user._id, ticket._id);
  if (existing) {
    await ctx.db.patch(existing._id, {
      kind: "delete",
      fields: undefined,
      before: existing.before ?? snapshot(ticket),
    });
    return;
  }

  await ctx.db.insert("editRequests", {
    requestedBy: user._id,
    account: user.account,
    kind: "delete",
    ticketId: ticket._id,
    before: snapshot(ticket),
  });
}

/**
 * Propose an arrangement for one cell.
 *
 * Cell-level, not card-level: dragging within a cell is about the whole column of
 * cards, so several drags in the same cell collapse to the last arrangement — one
 * request per cell, replacing itself.
 *
 * The membership check runs against the requester's *own* view of the board: a
 * card they have already proposed moving into this cell belongs in the list, even
 * though the real row still says otherwise.
 */
export async function requestReorder(
  ctx: MutationCtx,
  user: Doc<"users">,
  args: {
    epicId: Id<"epics">;
    checkpointId: Id<"checkpoints">;
    ticketIds: readonly TicketRef[];
  },
): Promise<void> {
  await requireCheckpoint(ctx, args.checkpointId);

  const seen = new Set<string>();
  for (const ref of args.ticketIds) {
    if (seen.has(ref)) throw new Error(`Ticket ${ref} is listed twice`);
    seen.add(ref);
  }

  const mine = await myRequests(ctx, user._id);
  const movedTo = new Map<string, Id<"checkpoints">>();
  for (const request of mine) {
    if (request.kind === "update" && request.ticketId && request.fields?.checkpointId) {
      movedTo.set(request.ticketId, request.fields.checkpointId);
    }
  }

  for (const ref of args.ticketIds) {
    const requestId = ctx.db.normalizeId("editRequests", ref);
    if (requestId) {
      const proposed = mine.find(
        (request) => request._id === requestId && request.kind === "create",
      );
      if (
        !proposed ||
        proposed.checkpointId !== args.checkpointId ||
        proposed.epicId !== args.epicId
      ) {
        throw new Error("排序清單裡有一張不屬於這一格的待審新卡片。");
      }
      continue;
    }

    const ticketId = ctx.db.normalizeId("tickets", ref);
    if (!ticketId) throw new Error(`不認得的卡片 id ${ref}`);
    const ticket = await ticketInEpic(ctx, ticketId, args.epicId);
    const where = movedTo.get(ticket._id) ?? ticket.checkpointId;
    if (where !== args.checkpointId) {
      throw new Error(
        `Ticket ${ticket.key} is not in the checkpoint being reordered. ` +
          `Move it first, then reorder.`,
      );
    }
  }

  const existing = mine.find(
    (request) =>
      request.kind === "reorder" &&
      request.checkpointId === args.checkpointId &&
      request.epicId === args.epicId,
  );

  if (existing) {
    await ctx.db.patch(existing._id, { ticketIds: [...args.ticketIds] });
    return;
  }
  await ctx.db.insert("editRequests", {
    requestedBy: user._id,
    account: user.account,
    kind: "reorder",
    epicId: args.epicId,
    checkpointId: args.checkpointId,
    ticketIds: [...args.ticketIds],
  });
}

// ---------------------------------------------------------------------------
// Overlay — the requester's own board
// ---------------------------------------------------------------------------

/**
 * The pending requests `board:get` should overlay for this caller.
 *
 * Only for an account that cannot write: `permWrite` edits land for real, so such
 * an account has nothing pending to overlay, and a leftover row from before it
 * was promoted belongs in the review list rather than on top of the board.
 */
export async function pendingRequestsFor(
  ctx: QueryCtx,
  user: Doc<"users">,
): Promise<EditRequest[]> {
  if (user.permWrite) return [];
  return await myRequests(ctx, user._id);
}

/** An arriving card sorts last until the cell is renumbered. */
const ARRIVING = Number.MAX_SAFE_INTEGER;

function cellKey(
  checkpointId: Id<"checkpoints">,
  epicId: Id<"epics">,
): string {
  return `${checkpointId}:${epicId}`;
}

/** Stored fields as a patch onto a ticket document: `null` clears the field. */
function patchFromFields(fields: EditFields): Partial<Doc<"tickets">> {
  const patch: Partial<Doc<"tickets">> = {};
  if (fields.title !== undefined) patch.title = fields.title;
  if (fields.status !== undefined) patch.status = fields.status;
  if (fields.checkpointId !== undefined) patch.checkpointId = fields.checkpointId;
  if (fields.assignee !== undefined) patch.assignee = fields.assignee ?? undefined;
  if (fields.dueDate !== undefined) patch.dueDate = fields.dueDate ?? undefined;
  if (fields.tag !== undefined) patch.tag = fields.tag ?? undefined;
  if (fields.githubPrs !== undefined) {
    patch.githubPrs = fields.githubPrs ?? undefined;
  }
  return patch;
}

/**
 * The board as the requester asked for it.
 *
 * Deleted cards go, edits and moves show through, proposed cards appear, and a
 * proposed arrangement is applied — every affected card carrying a `pendingEdit`
 * marker so the UI can badge it. Requests pointing outside the loaded window
 * (a card moved to a week that is not on screen) are simply not rendered.
 */
export function overlayTickets(
  tickets: readonly Doc<"tickets">[],
  requests: readonly EditRequest[],
  checkpointIds: ReadonlySet<Id<"checkpoints">>,
): BoardTicket[] {
  if (requests.length === 0) return [...tickets];

  const perTicket = new Map<string, EditRequest>();
  const creates: EditRequest[] = [];
  const reorders: EditRequest[] = [];
  for (const request of requests) {
    if (request.kind === "create") creates.push(request);
    else if (request.kind === "reorder") reorders.push(request);
    else if (request.ticketId) perTicket.set(request.ticketId, request);
  }

  const result: BoardTicket[] = [];
  /** Cells a card arrived in, which have to be renumbered so it lands last. */
  const arrivals = new Set<string>();

  for (const ticket of tickets) {
    const request = perTicket.get(ticket._id);
    if (!request) {
      result.push(ticket);
      continue;
    }
    if (request.kind === "delete") continue; // gone, as asked

    const fields = request.fields ?? {};
    const checkpointId = fields.checkpointId ?? ticket.checkpointId;
    if (!checkpointIds.has(checkpointId)) continue; // moved out of the window
    const moved = checkpointId !== ticket.checkpointId;

    result.push({
      ...ticket,
      ...patchFromFields(fields),
      order: moved ? ARRIVING : ticket.order,
      pendingEdit: { requestId: request._id, kind: request.kind },
    });
    if (moved) arrivals.add(cellKey(checkpointId, ticket.epicId));
  }

  for (const request of creates) {
    const { epicId, checkpointId, fields } = request;
    if (!epicId || !checkpointId || !checkpointIds.has(checkpointId)) continue;

    result.push({
      // The request's own id stands in for the ticket id the card does not have
      // yet. Every board mutation accepts it (`ticketRefValidator`), which is
      // what lets the requester keep editing, moving and deleting this card
      // without the client needing a second code path for it.
      _id: request._id as unknown as Id<"tickets">,
      _creationTime: request._creationTime,
      key: fields?.key ?? "LOCAL-?",
      title: fields?.title ?? "",
      epicId,
      checkpointId,
      status: fields?.status ?? "todo",
      assignee: fields?.assignee ?? undefined,
      dueDate: fields?.dueDate ?? undefined,
      tag: fields?.tag ?? undefined,
      githubPrs: fields?.githubPrs ?? undefined,
      order: ARRIVING,
      pendingEdit: { requestId: request._id, kind: "create" },
    });
    arrivals.add(cellKey(checkpointId, epicId));
  }

  const orders = new Map<string, number>();

  // Renumber every cell that received a card, in the order the board would show
  // it — the same thing `appendToCell` does on a real write, and for the same
  // reason: an arriving card keeping its old position would sort into the middle.
  if (arrivals.size > 0) {
    const cells = new Map<string, BoardTicket[]>();
    for (const ticket of result) {
      const key = cellKey(ticket.checkpointId, ticket.epicId);
      if (!arrivals.has(key)) continue;
      const cell = cells.get(key);
      if (cell) cell.push(ticket);
      else cells.set(key, [ticket]);
    }
    for (const cell of cells.values()) {
      cell.sort(byCellPosition);
      cell.forEach((ticket, index) => orders.set(ticket._id, index));
    }
  }

  // An explicit arrangement wins over the appended position: it is the last thing
  // the requester said about this cell.
  const reordered = new Map<string, Id<"editRequests">>();
  for (const request of reorders) {
    (request.ticketIds ?? []).forEach((ref, index) => {
      orders.set(ref, index);
      reordered.set(ref, request._id);
    });
  }

  return result.map((ticket) => {
    const order = orders.get(ticket._id);
    const reorder = reordered.get(ticket._id);
    if (order === undefined && reorder === undefined) return ticket;
    return {
      ...ticket,
      order: order ?? ticket.order,
      // A card only involved in a reorder still gets a marker: something about it
      // on this board is waiting for approval.
      pendingEdit:
        ticket.pendingEdit ??
        (reorder ? { requestId: reorder, kind: "reorder" as const } : undefined),
    };
  });
}

// ---------------------------------------------------------------------------
// Reading requests — the review list and the requester's own list
// ---------------------------------------------------------------------------

const changeValidator = v.object({
  label: v.string(),
  /** What the card said when the request was made; null when there was nothing. */
  from: v.union(v.string(), v.null()),
  /** What is being asked for; null when the field is being cleared. */
  to: v.union(v.string(), v.null()),
});

const requestViewValidator = v.object({
  requestId: v.id("editRequests"),
  account: v.string(),
  kind: editRequestKindValidator,
  /** The card this is about, named the way the board names it. */
  key: v.string(),
  title: v.string(),
  changes: v.array(changeValidator),
  requestedAt: v.number(),
  /** Why this cannot be applied as-is, if that is already knowable. */
  warning: v.union(v.string(), v.null()),
});

const FIELD_LABEL: Record<(typeof CHANGEABLE)[number], string> = {
  checkpointId: "週次",
  title: "標題",
  status: "狀態",
  assignee: "負責人",
  dueDate: "到期日",
  tag: "標籤",
  githubPrs: "GitHub PR",
};

/** Short status names for the review list; the board's own legend is the long form. */
const STATUS_TEXT: Record<Doc<"tickets">["status"], string> = {
  todo: "To Do",
  doing: "Doing",
  testing: "Testing",
  done: "Done",
};

function weekLabel(checkpoint: Doc<"checkpoints"> | undefined): string {
  if (!checkpoint) return "(已刪除的週次)";
  if (checkpoint.kind === "backlog") return checkpoint.label ?? "Backlog";
  return `W${checkpoint.weekNumber}`;
}

function displayValue(
  field: (typeof CHANGEABLE)[number],
  value: EditFields[(typeof CHANGEABLE)[number]],
  weeks: Map<string, Doc<"checkpoints">>,
): string | null {
  if (value === undefined || value === null) return null;
  if (field === "checkpointId") return weekLabel(weeks.get(value as string));
  if (field === "status") return STATUS_TEXT[value as Doc<"tickets">["status"]];
  if (field === "githubPrs") {
    const urls = value as string[];
    return urls.length === 0 ? null : urls.join(" ");
  }
  return String(value);
}

/**
 * One request as the review list shows it: who, which card, and what would
 * change — field by field, "what it said → what is asked for".
 */
async function describe(
  ctx: QueryCtx,
  request: EditRequest,
  weeks: Map<string, Doc<"checkpoints">>,
): Promise<{
  requestId: Id<"editRequests">;
  account: string;
  kind: EditRequestKind;
  key: string;
  title: string;
  changes: { label: string; from: string | null; to: string | null }[];
  requestedAt: number;
  warning: string | null;
}> {
  const fields = request.fields ?? {};
  const before = request.before ?? {};
  const changes: { label: string; from: string | null; to: string | null }[] = [];
  let warning: string | null = null;

  let key = fields.key ?? before.key ?? "?";
  let title = fields.title ?? before.title ?? "";

  if (request.kind === "update" || request.kind === "delete") {
    const ticket = request.ticketId ? await ctx.db.get(request.ticketId) : null;
    if (!ticket) {
      warning = "這張卡片已經不在看板上了，只能忽略這筆提議。";
    } else {
      key = ticket.key;
      title = before.title ?? ticket.title;
    }
  }

  if (request.kind === "create") {
    changes.push({
      label: "新增卡片",
      from: null,
      to: `${key} · ${title}`,
    });
    if (request.checkpointId) {
      changes.push({
        label: FIELD_LABEL.checkpointId,
        from: null,
        to: weekLabel(weeks.get(request.checkpointId)),
      });
    }
  }

  if (request.kind === "delete") {
    changes.push({ label: "刪除卡片", from: `${key} · ${title}`, to: null });
  }

  if (request.kind === "reorder") {
    const names: string[] = [];
    for (const ref of request.ticketIds ?? []) {
      const ticketId = ctx.db.normalizeId("tickets", ref);
      const ticket = ticketId ? await ctx.db.get(ticketId) : null;
      names.push(ticket?.key ?? "(新卡片)");
    }
    key = weekLabel(
      request.checkpointId ? weeks.get(request.checkpointId) : undefined,
    );
    title = `這一格的 ${names.length} 張卡片`;
    changes.push({ label: "格內順序", from: null, to: names.join(" → ") });
  }

  if (request.kind === "create" || request.kind === "update") {
    for (const field of CHANGEABLE) {
      // `create` states the week in its own line above, and its title is the
      // card's name rather than a change to it.
      if (request.kind === "create" && (field === "checkpointId" || field === "title")) {
        continue;
      }
      if (fields[field] === undefined) continue;
      changes.push({
        label: FIELD_LABEL[field],
        from: displayValue(field, before[field], weeks),
        to: displayValue(field, fields[field], weeks),
      });
    }
  }

  return {
    requestId: request._id,
    account: request.account,
    kind: request.kind,
    key,
    title,
    changes,
    requestedAt: request._creationTime,
    warning,
  };
}

async function describeAll(ctx: QueryCtx, requests: readonly EditRequest[]) {
  const checkpoints = await ctx.db.query("checkpoints").take(500);
  const weeks = new Map(checkpoints.map((c) => [c._id as string, c]));
  const ordered = [...requests].sort(
    (a, b) => a._creationTime - b._creationTime,
  );
  return await Promise.all(ordered.map((request) => describe(ctx, request, weeks)));
}

/**
 * Everything waiting for a decision, oldest first.
 *
 * Requires `permWrite` — the same permission that applies an edit directly is the
 * one that may apply somebody else's. It is a subscription, so the bell's dot
 * lights up the moment a request arrives.
 */
export const list = query({
  args: { auth: credentialsValidator },
  returns: v.array(requestViewValidator),
  handler: async (ctx, args) => {
    await requireWrite(ctx, args.auth);
    const requests = await ctx.db.query("editRequests").take(MAX_REQUESTS);
    return await describeAll(ctx, requests);
  },
});

/** The caller's own pending requests — the list they withdraw from. */
export const mine = query({
  args: { auth: credentialsValidator },
  returns: v.array(requestViewValidator),
  handler: async (ctx, args) => {
    const user = await requirePermission(ctx, args.auth, "permEditRequest");
    return await describeAll(ctx, await myRequests(ctx, user._id));
  },
});

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

/** Take back one of my own requests; the overlay disappears with it. */
export const withdraw = mutation({
  args: { auth: credentialsValidator, requestId: v.id("editRequests") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requirePermission(ctx, args.auth, "permEditRequest");
    const request = await ctx.db.get(args.requestId);
    if (!request) return null; // already gone: the outcome asked for
    if (request.requestedBy !== user._id) {
      throw new Error(`${AUTH_DENIED}: 只能撤回自己提出的編輯提議。`);
    }
    await ctx.db.delete(request._id);
    return null;
  },
});

/**
 * Do what a request asks, for real.
 *
 * Straight through `apply.ts`, so approval is the same write with the same
 * validation the requester would have performed with `permWrite` — including the
 * checks that may now fail. Anything the request can no longer do (its card was
 * deleted, its key has been taken) throws, and because a Convex mutation is a
 * transaction, the request survives for the reviewer to dismiss.
 */
async function applyRequest(ctx: MutationCtx, request: EditRequest) {
  const fields = request.fields ?? {};

  switch (request.kind) {
    case "create": {
      if (!request.epicId || !request.checkpointId || !fields.title) {
        throw new Error("這筆新增提議缺少必要欄位。");
      }
      await applyCreate(ctx, {
        epicId: request.epicId,
        checkpointId: request.checkpointId,
        key: fields.key,
        title: fields.title,
        fields: toTicketFields(fields),
      });
      return;
    }
    case "update": {
      if (!request.ticketId) throw new Error("這筆修改提議沒有目標卡片。");
      await applyUpdate(ctx, {
        ticketId: request.ticketId,
        checkpointId: fields.checkpointId,
        fields: toTicketFields(fields),
      });
      return;
    }
    case "delete": {
      if (!request.ticketId) throw new Error("這筆刪除提議沒有目標卡片。");
      await applyDelete(ctx, request.ticketId);
      return;
    }
    case "reorder": {
      if (!request.epicId || !request.checkpointId) {
        throw new Error("這筆排序提議沒有目標格子。");
      }
      // Only cards that are really in this cell now can be given a position: a
      // card still waiting to be created has no row, and one that has left the
      // cell is no longer part of its arrangement.
      const ticketIds: Id<"tickets">[] = [];
      for (const ref of request.ticketIds ?? []) {
        const ticketId = ctx.db.normalizeId("tickets", ref);
        if (!ticketId) continue;
        const ticket = await ctx.db.get(ticketId);
        if (
          ticket &&
          ticket.checkpointId === request.checkpointId &&
          ticket.epicId === request.epicId
        ) {
          ticketIds.push(ticketId);
        }
      }
      if (ticketIds.length === 0) {
        throw new Error("這一格已經沒有可以排序的卡片了。");
      }
      await applyReorder(ctx, {
        epicId: request.epicId,
        checkpointId: request.checkpointId,
        ticketIds,
      });
      return;
    }
  }
}

/** Apply a request and clear it. Requires `permWrite`. */
export const approve = mutation({
  args: { auth: credentialsValidator, requestId: v.id("editRequests") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireWrite(ctx, args.auth);

    const request = await ctx.db.get(args.requestId);
    if (!request) throw new Error("這筆提議已經不在了（可能剛被處理或撤回）。");

    try {
      await applyRequest(ctx, request);
    } catch (caught: unknown) {
      const reason = caught instanceof Error ? caught.message : String(caught);
      throw new Error(
        `無法套用這筆提議：${reason} —— 看板資料可能在等待期間變過了，` +
          `確認之後可以用「忽略」把它清掉。`,
      );
    }

    await ctx.db.delete(request._id);
    return null;
  },
});

/** Turn a request down: the row goes, and the requester's board reverts. */
export const dismiss = mutation({
  args: { auth: credentialsValidator, requestId: v.id("editRequests") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireWrite(ctx, args.auth);
    const request = await ctx.db.get(args.requestId);
    if (!request) return null; // already gone: the outcome asked for
    await ctx.db.delete(request._id);
    return null;
  },
});
