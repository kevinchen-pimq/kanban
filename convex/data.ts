import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { accentValidator, checkpointKindValidator, statusValidator } from "./schema";

/**
 * Import and maintenance entry points for the board.
 *
 * These are the functions to reach for when loading real work into the board,
 * as opposed to `seed.ts`, which only replays the original fixture. Everything
 * here is internal, so it is callable from `npx convex run` (which is
 * authenticated) but never from a browser.
 *
 * Rows are matched on natural keys rather than Convex ids, so the same payload
 * can be replayed as often as you like: epics by `code`, weeks by
 * `weekNumber`, the backlog row by its kind, and tickets by `key`.
 */

/** Which row a ticket belongs to: a week number, or the backlog pool. */
const checkpointRefValidator = v.union(v.number(), v.literal("backlog"));

const epicInput = v.object({
  code: v.string(),
  name: v.string(),
  accent: v.optional(accentValidator),
  order: v.optional(v.number()),
});

const checkpointInput = v.object({
  kind: checkpointKindValidator,
  weekNumber: v.optional(v.number()),
  startDate: v.optional(v.string()),
  endDate: v.optional(v.string()),
  label: v.optional(v.string()),
  order: v.optional(v.number()),
});

const ticketInput = v.object({
  key: v.string(),
  title: v.string(),
  epicCode: v.string(),
  checkpoint: checkpointRefValidator,
  status: statusValidator,
  dueDate: v.optional(v.string()),
  githubPrs: v.optional(v.array(v.string())),
  tag: v.optional(v.string()),
  assignee: v.optional(v.string()),
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertIsoDate(value: string | undefined, field: string) {
  if (value !== undefined && !ISO_DATE.test(value)) {
    throw new Error(`${field} must be an ISO date like 2026-08-11, got "${value}"`);
  }
}

/** Append-at-the-end ordering for rows the payload did not place explicitly. */
async function nextOrder(
  ctx: MutationCtx,
  table: "epics" | "checkpoints",
): Promise<number> {
  const last = await ctx.db.query(table).withIndex("by_order").order("desc").first();
  return last ? last.order + 1 : 0;
}

/**
 * Upsert epics, checkpoints and tickets in one pass.
 *
 * Tickets reference their epic by code and their checkpoint by week number, so
 * a payload is readable on its own and survives a rebuild of either axis.
 * Omitted optional fields on an existing row keep their current value, except
 * `dueDate`, which is cleared when absent so a date removed upstream also
 * disappears here.
 */
export const importBoard = internalMutation({
  args: {
    epics: v.optional(v.array(epicInput)),
    checkpoints: v.optional(v.array(checkpointInput)),
    tickets: v.optional(v.array(ticketInput)),
    /**
     * Delete every ticket of the touched epics that the payload does not
     * mention. Use it when the payload is the complete truth for those epics,
     * for example a full re-sync of one Jira epic.
     */
    pruneEpics: v.optional(v.array(v.string())),
  },
  returns: v.object({
    epicsCreated: v.number(),
    epicsUpdated: v.number(),
    checkpointsCreated: v.number(),
    checkpointsUpdated: v.number(),
    ticketsCreated: v.number(),
    ticketsUpdated: v.number(),
    ticketsDeleted: v.number(),
  }),
  handler: async (ctx, args) => {
    let epicsCreated = 0;
    let epicsUpdated = 0;
    let checkpointsCreated = 0;
    let checkpointsUpdated = 0;
    let ticketsCreated = 0;
    let ticketsUpdated = 0;
    let ticketsDeleted = 0;

    for (const epic of args.epics ?? []) {
      const existing = await ctx.db
        .query("epics")
        .withIndex("by_code", (q) => q.eq("code", epic.code))
        .unique();

      if (existing) {
        await ctx.db.patch(existing._id, {
          name: epic.name,
          ...(epic.accent !== undefined && { accent: epic.accent }),
          ...(epic.order !== undefined && { order: epic.order }),
        });
        epicsUpdated++;
      } else {
        await ctx.db.insert("epics", {
          code: epic.code,
          name: epic.name,
          accent: epic.accent ?? "indigo",
          order: epic.order ?? (await nextOrder(ctx, "epics")),
        });
        epicsCreated++;
      }
    }

    for (const checkpoint of args.checkpoints ?? []) {
      assertIsoDate(checkpoint.startDate, "checkpoint.startDate");
      assertIsoDate(checkpoint.endDate, "checkpoint.endDate");
      if (checkpoint.kind === "week" && checkpoint.weekNumber === undefined) {
        throw new Error("A week checkpoint needs a weekNumber");
      }

      const existing = await ctx.db
        .query("checkpoints")
        .withIndex("by_kind_and_week", (q) =>
          q.eq("kind", checkpoint.kind).eq("weekNumber", checkpoint.weekNumber),
        )
        .first();

      if (existing) {
        await ctx.db.patch(existing._id, {
          ...(checkpoint.startDate !== undefined && { startDate: checkpoint.startDate }),
          ...(checkpoint.endDate !== undefined && { endDate: checkpoint.endDate }),
          ...(checkpoint.label !== undefined && { label: checkpoint.label }),
          ...(checkpoint.order !== undefined && { order: checkpoint.order }),
        });
        checkpointsUpdated++;
      } else {
        await ctx.db.insert("checkpoints", {
          kind: checkpoint.kind,
          weekNumber: checkpoint.weekNumber,
          startDate: checkpoint.startDate,
          endDate: checkpoint.endDate,
          label: checkpoint.label,
          order: checkpoint.order ?? (await nextOrder(ctx, "checkpoints")),
        });
        checkpointsCreated++;
      }
    }

    // Resolve the axes once; a board has few epics and few checkpoints.
    const epicIdByCode = new Map<string, Id<"epics">>();
    for (const epic of await ctx.db.query("epics").withIndex("by_order").take(200)) {
      epicIdByCode.set(epic.code, epic._id);
    }

    const checkpointIdByRef = new Map<number | "backlog", Id<"checkpoints">>();
    for (const checkpoint of await ctx.db
      .query("checkpoints")
      .withIndex("by_order")
      .take(500)) {
      checkpointIdByRef.set(
        checkpoint.kind === "backlog" ? "backlog" : (checkpoint.weekNumber ?? -1),
        checkpoint._id,
      );
    }

    const seenKeys = new Set<string>();
    const touchedEpicIds = new Set<string>();

    for (const ticket of args.tickets ?? []) {
      assertIsoDate(ticket.dueDate, `ticket ${ticket.key} dueDate`);

      const epicId = epicIdByCode.get(ticket.epicCode);
      if (!epicId) {
        throw new Error(
          `Ticket ${ticket.key} references unknown epic "${ticket.epicCode}". ` +
            `Include it in the payload's epics array.`,
        );
      }
      const checkpointId = checkpointIdByRef.get(ticket.checkpoint);
      if (!checkpointId) {
        throw new Error(
          `Ticket ${ticket.key} references unknown checkpoint ` +
            `"${String(ticket.checkpoint)}". Include it in the payload's ` +
            `checkpoints array.`,
        );
      }

      seenKeys.add(ticket.key);
      touchedEpicIds.add(epicId);

      // Every optional field is written even when absent, so a value removed
      // upstream is cleared here rather than lingering from an earlier import.
      const fields = {
        title: ticket.title,
        epicId,
        checkpointId,
        status: ticket.status,
        dueDate: ticket.dueDate,
        githubPrs: ticket.githubPrs,
        tag: ticket.tag,
        assignee: ticket.assignee,
      };

      const existing = await ctx.db
        .query("tickets")
        .withIndex("by_key", (q) => q.eq("key", ticket.key))
        .unique();

      if (existing) {
        await ctx.db.patch(existing._id, fields);
        ticketsUpdated++;
      } else {
        await ctx.db.insert("tickets", { key: ticket.key, ...fields });
        ticketsCreated++;
      }
    }

    for (const code of args.pruneEpics ?? []) {
      const epicId = epicIdByCode.get(code);
      if (!epicId) throw new Error(`Cannot prune unknown epic "${code}"`);

      for (const ticket of await ctx.db.query("tickets").take(5000)) {
        if (ticket.epicId !== epicId) continue;
        if (seenKeys.has(ticket.key)) continue;
        await ctx.db.delete(ticket._id);
        ticketsDeleted++;
      }
    }

    return {
      epicsCreated,
      epicsUpdated,
      checkpointsCreated,
      checkpointsUpdated,
      ticketsCreated,
      ticketsUpdated,
      ticketsDeleted,
    };
  },
});

/**
 * Delete whole epics along with every ticket in them.
 *
 * This is the "take this column off the board" operation. Checkpoint rows are
 * left alone, since they are shared by every epic.
 */
export const removeEpics = internalMutation({
  args: { codes: v.array(v.string()) },
  returns: v.object({
    epicsDeleted: v.number(),
    ticketsDeleted: v.number(),
    missing: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    let epicsDeleted = 0;
    let ticketsDeleted = 0;
    const missing: string[] = [];

    const doomed = new Set<Id<"epics">>();
    for (const code of args.codes) {
      const epic = await ctx.db
        .query("epics")
        .withIndex("by_code", (q) => q.eq("code", code))
        .unique();
      if (epic) doomed.add(epic._id);
      else missing.push(code);
    }

    if (doomed.size > 0) {
      for (const ticket of await ctx.db.query("tickets").take(5000)) {
        if (!doomed.has(ticket.epicId)) continue;
        await ctx.db.delete(ticket._id);
        ticketsDeleted++;
      }
      for (const epicId of doomed) {
        await ctx.db.delete(epicId);
        epicsDeleted++;
      }
    }

    return { epicsDeleted, ticketsDeleted, missing };
  },
});

/** Delete specific tickets by their key. Missing keys are reported, not fatal. */
export const removeTickets = internalMutation({
  args: { keys: v.array(v.string()) },
  returns: v.object({ deleted: v.number(), missing: v.array(v.string()) }),
  handler: async (ctx, args) => {
    let deleted = 0;
    const missing: string[] = [];

    for (const key of args.keys) {
      const ticket = await ctx.db
        .query("tickets")
        .withIndex("by_key", (q) => q.eq("key", key))
        .unique();
      if (ticket) {
        await ctx.db.delete(ticket._id);
        deleted++;
      } else {
        missing.push(key);
      }
    }

    return { deleted, missing };
  },
});

/** What is on the board right now, small enough to read in a terminal. */
export const summary = internalQuery({
  args: {},
  returns: v.object({
    epics: v.array(
      v.object({ code: v.string(), name: v.string(), tickets: v.number() }),
    ),
    checkpoints: v.array(
      v.object({ ref: v.string(), range: v.optional(v.string()), tickets: v.number() }),
    ),
    totalTickets: v.number(),
  }),
  handler: async (ctx) => {
    const [epics, checkpoints, tickets] = await Promise.all([
      ctx.db.query("epics").withIndex("by_order").take(200),
      ctx.db.query("checkpoints").withIndex("by_order").take(500),
      ctx.db.query("tickets").take(5000),
    ]);

    const byEpic = new Map<string, number>();
    const byCheckpoint = new Map<string, number>();
    for (const ticket of tickets) {
      byEpic.set(ticket.epicId, (byEpic.get(ticket.epicId) ?? 0) + 1);
      byCheckpoint.set(
        ticket.checkpointId,
        (byCheckpoint.get(ticket.checkpointId) ?? 0) + 1,
      );
    }

    return {
      epics: epics.map((epic) => ({
        code: epic.code,
        name: epic.name,
        tickets: byEpic.get(epic._id) ?? 0,
      })),
      checkpoints: checkpoints.map((checkpoint) => ({
        ref: checkpoint.kind === "backlog" ? "backlog" : `W${checkpoint.weekNumber}`,
        range:
          checkpoint.startDate && checkpoint.endDate
            ? `${checkpoint.startDate} → ${checkpoint.endDate}`
            : undefined,
        tickets: byCheckpoint.get(checkpoint._id) ?? 0,
      })),
      totalTickets: tickets.length,
    };
  },
});
