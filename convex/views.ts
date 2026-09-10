import { v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { credentialsValidator, requireRead } from "./auth";
import { cleanViewName } from "./validation";

/**
 * 個人看板 (`views`): the left sidebar's saved epic selections.
 *
 * One row is "these columns are my board" — a name plus a set of epic `code`s.
 * Selecting it in the sidebar sets the board's epic filter to that set and
 * changes nothing else; the status/assignee filters and the search box stay the
 * toolbar's own tools.
 *
 * **Why `permRead` for the writes too, and no edit request.** A view is a
 * personal way of *looking* at the board, not board content: it stores no card
 * data, and nobody else's board changes when it is written. So the rule that
 * every `board:*` mutation forks on `permWrite` / `permEditRequest` (see
 * `convex/board.ts`) does not reach here — there is nothing for a reviewer to
 * approve, and making a read-only teammate ask permission to save their own
 * shortlist would be permission theatre. What *is* enforced is ownership:
 * everybody with `permRead` sees everybody's views (the sidebar doubles as "what
 * is everyone tracking"), and only the owner may update or delete their own.
 *
 * An ownership refusal is deliberately **not** an `AUTH_DENIED`: the credential
 * is perfectly good, so the client must show the message rather than throw the
 * session away and bounce to the login screen.
 */

/** Everybody's views in one read. A team's sidebar is nowhere near this long. */
const LIST_LIMIT = 500;

/** Epics on one view. Past this it is not a view of the board, it is the board. */
const MAX_EPICS = 50;

/** Epics on the whole board — a handful; one read answers every code. */
const EPIC_LIMIT = 200;

const viewValidator = v.object({
  _id: v.id("views"),
  owner: v.string(),
  name: v.string(),
  epicCodes: v.array(v.string()),
  /** True when the caller owns it, i.e. may press the pencil. */
  mine: v.boolean(),
});

/**
 * Validate the epic set: non-empty, no duplicates, capped, and every code
 * actually on the board.
 *
 * Checking existence at write time keeps a typo out of the table, and costs one
 * read of a table with a handful of rows. It is not a promise the codes stay
 * valid — an epic can be dropped by a later import, and the board simply stops
 * matching that code (`src/lib/filters.ts` makes the same trade).
 */
async function cleanEpicCodes(
  ctx: QueryCtx,
  codes: readonly string[],
): Promise<string[]> {
  const cleaned = codes.map((code) => code.trim());
  if (cleaned.length === 0) {
    throw new Error("一個看板至少要選一個 Epic。");
  }
  if (cleaned.length > MAX_EPICS) {
    throw new Error(`一個看板最多 ${MAX_EPICS} 個 Epic。`);
  }

  const seen = new Set<string>();
  for (const code of cleaned) {
    if (seen.has(code)) throw new Error(`Epic ${code} 重複了。`);
    seen.add(code);
  }

  const known = new Set(
    (await ctx.db.query("epics").take(EPIC_LIMIT)).map((epic) => epic.code),
  );
  for (const code of cleaned) {
    if (!known.has(code)) {
      throw new Error(`看板上沒有 Epic ${code}，重新整理之後再試一次。`);
    }
  }
  return cleaned;
}

/**
 * Refuse a name this owner already used, ignoring case and surrounding space.
 *
 * Two rows reading the same thing in the same group are unpickable, and the
 * sidebar has no other handle to tell them apart. `except` is the view being
 * renamed, which must not collide with itself.
 */
async function assertNameFree(
  ctx: QueryCtx,
  owner: string,
  name: string,
  except?: Id<"views">,
): Promise<void> {
  const owned = await ctx.db
    .query("views")
    .withIndex("by_owner", (q) => q.eq("owner", owner))
    .collect();

  const taken = owned.some(
    (view) =>
      view._id !== except &&
      view.name.toLowerCase() === name.toLowerCase(),
  );
  if (taken) throw new Error(`你已經有一個叫「${name}」的看板了。`);
}

/** The caller's own view, or a readable refusal — the gate on update/remove. */
async function requireOwn(
  ctx: QueryCtx,
  account: string,
  viewId: Id<"views">,
): Promise<Doc<"views">> {
  const view = await ctx.db.get(viewId);
  if (!view) throw new Error("這個看板已經不存在了。");
  if (view.owner !== account) {
    throw new Error(`「${view.name}」是 ${view.owner} 的看板，只有他能修改。`);
  }
  return view;
}

/**
 * Every saved view, the caller's first.
 *
 * Sorted here rather than in the sidebar because the order *is* the answer:
 * 我的看板 at the top (that is what the reader came for), then one group per
 * other owner by account name, views by name inside each group. The client
 * groups by the `owner` field it gets back and needs no second sort.
 */
export const list = query({
  args: { auth: credentialsValidator },
  returns: v.array(viewValidator),
  handler: async (ctx, args) => {
    const user = await requireRead(ctx, args.auth);

    const views = await ctx.db.query("views").take(LIST_LIMIT);
    return views
      .map((view) => ({
        _id: view._id,
        owner: view.owner,
        name: view.name,
        epicCodes: view.epicCodes,
        mine: view.owner === user.account,
      }))
      .sort((a, b) => {
        if (a.mine !== b.mine) return a.mine ? -1 : 1;
        if (a.owner !== b.owner) return a.owner.localeCompare(b.owner);
        return a.name.localeCompare(b.name);
      });
  },
});

/** Save a new personal board. The owner is the caller; there is no other way. */
export const create = mutation({
  args: {
    auth: credentialsValidator,
    name: v.string(),
    epicCodes: v.array(v.string()),
  },
  returns: v.id("views"),
  handler: async (ctx, args) => {
    const user = await requireRead(ctx, args.auth);

    const name = cleanViewName(args.name);
    const epicCodes = await cleanEpicCodes(ctx, args.epicCodes);
    await assertNameFree(ctx, user.account, name);

    return await ctx.db.insert("views", {
      owner: user.account,
      name,
      epicCodes,
    });
  },
});

/**
 * Rename a view and/or replace its epics — both fields, always.
 *
 * The dialog edits them together and a view is only those two things, so a
 * partial update would only add a way for the two to disagree.
 */
export const update = mutation({
  args: {
    auth: credentialsValidator,
    viewId: v.id("views"),
    name: v.string(),
    epicCodes: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireRead(ctx, args.auth);
    const view = await requireOwn(ctx, user.account, args.viewId);

    const name = cleanViewName(args.name);
    const epicCodes = await cleanEpicCodes(ctx, args.epicCodes);
    await assertNameFree(ctx, user.account, name, view._id);

    await ctx.db.patch(view._id, { name, epicCodes });
    return null;
  },
});

/**
 * Delete one of the caller's own views.
 *
 * No confirmation lives here — the dialog asks twice. Nothing else points at a
 * view, so there is nothing to clean up; the sidebar just loses a row and
 * whoever was looking through it falls back to 全部 Epic.
 */
export const remove = mutation({
  args: { auth: credentialsValidator, viewId: v.id("views") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireRead(ctx, args.auth);
    const view = await requireOwn(ctx, user.account, args.viewId);

    await ctx.db.delete(view._id);
    return null;
  },
});
