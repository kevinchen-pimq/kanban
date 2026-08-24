import { v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  cleanAccount,
  credentialsValidator,
  requirePermission,
  requireRead,
  type Credentials,
} from "./auth";
import { notificationKindValidator } from "./schema";
import { assertIsoDate, cleanHttpUrl, cleanKey } from "./validation";

/**
 * The board tracker's half of the app: notifications, and the weekly report.
 *
 * The tracker is a scheduled Claude Code session (`.claude/skills/board-tracker/`)
 * that patrols the board twice a day, publishes a report on Monday and rechecks
 * the people who said they had caught up. Its account holds
 * `permRead + permEditRequest + permTracker` and **never `permWrite`**, so the
 * ordinary `board:*` mutations turn every change it asks for into a pending edit
 * request that a human approves — exactly the same fork a person with only
 * `permEditRequest` goes through, with no tracker-specific code anywhere in
 * `convex/board.ts`. What lives *here* is only the half the board did not already
 * have: telling somebody something, and publishing a file.
 *
 * Two halves, split by the permission they ask for:
 *
 * - **The person's side** (`mine` / `dismiss`), behind `requireRead` and scoped to
 *   the caller's own rows. This is the bell in the header.
 * - **The tracker's side** (`trackerSend` / `trackerBroadcast` /
 *   `trackerPendingRechecks` / `trackerResolveRecheck` / `trackerReportUploadUrl`
 *   / `trackerPublishReport`), behind `permTracker`. They are public functions for
 *   the same reason the assistant's are: the tracker runs in a container with no
 *   Convex credentials and authenticates the way the browser does, by sending
 *   `{ account, tokenHash }` to `POST /api/query` and `/api/mutation`.
 *
 * Three things are worth knowing before changing anything here (the reasoning is
 * in `docs/data-model.md`, 「進度追蹤與通知」):
 *
 * 1. **`progress` merges, the other kinds insert.** One live progress
 *    notification per person, refreshed in place, because a patrol runs twice a
 *    day and "here is your current picture" must never stack.
 * 2. **Dismissing a `progress` row asks for a recheck**, so it is kept as the
 *    recheck ticket instead of being deleted; every other dismissal deletes the
 *    row. Notifications are live state, not history.
 * 3. **A report is published once per week number.** That number is the
 *    idempotency key, following `board:addNextWeek`: a Monday routine that fires
 *    twice must not broadcast the same report to everybody again.
 */

/** Rows returned for one person's bell. A longer list is nobody's inbox. */
const LIST_LIMIT = 50;

/** How many accounts a broadcast may reach — the whole team, with slack. */
const BROADCAST_LIMIT = 500;

/** Pending rechecks the tracker scans. A bigger queue means it is not running. */
const RECHECK_LIMIT = 200;

/** Long enough for a per-person picture, short enough to read in a panel. */
const MAX_TEXT = 4000;

/** Keys one notification may name. Past this it is a report, not a notification. */
const MAX_KEYS = 50;

/** Mirrors `messages.ts`'s check: a notification with no words says nothing. */
function cleanText(value: string, field = "通知內容"): string {
  const text = value.trim();
  if (!text) throw new Error(`${field}不能是空的。`);
  if (text.length > MAX_TEXT) {
    throw new Error(`${field}超過 ${MAX_TEXT} 個字元。`);
  }
  return text;
}

/** Ticket keys, validated the same way the board validates them. */
function cleanKeys(keys: readonly string[] | undefined): string[] | undefined {
  if (keys === undefined) return undefined;
  if (keys.length === 0) return undefined;
  if (keys.length > MAX_KEYS) {
    throw new Error(`一則通知最多帶 ${MAX_KEYS} 個 key。`);
  }
  return keys.map((key) => cleanKey(key));
}

/** The gate in front of everything the tracker calls. */
function requireTracker(ctx: QueryCtx, credentials: Credentials) {
  return requirePermission(ctx, credentials, "permTracker");
}

/**
 * The account a tracker call names, or a readable error.
 *
 * `permRead` is the bar for *receiving* a notification: an account that cannot
 * open the board has no bell to see it in, and a pending registration should not
 * be told about work. The tracker types these names out of
 * `config.assigneeAccounts`, so a stale mapping has to fail loudly rather than
 * pile up notifications nobody can read.
 */
async function requireRecipient(
  ctx: QueryCtx,
  value: string,
): Promise<Doc<"users">> {
  const account = cleanAccount(value);
  const user = await ctx.db
    .query("users")
    .withIndex("by_account", (q) => q.eq("account", account))
    .unique();
  if (!user) {
    throw new Error(
      `沒有帳號 ${account}。用 npx convex run auth:listUsers 看有哪些帳號。`,
    );
  }
  if (!user.permRead) {
    throw new Error(`帳號 ${account} 還沒有讀取權限，收不到通知。`);
  }
  return user;
}

type NotificationContent = {
  kind: Doc<"notifications">["kind"];
  text: string;
  link?: string;
  keys?: string[];
};

/** This account's live (undismissed) progress notification, if it has one. */
async function liveProgress(
  ctx: QueryCtx,
  account: string,
): Promise<Doc<"notifications"> | null> {
  const rows = await ctx.db
    .query("notifications")
    .withIndex("by_account", (q) => q.eq("account", account))
    .order("desc")
    .take(LIST_LIMIT);
  return (
    rows.find(
      (row) => row.kind === "progress" && row.dismissedAt === undefined,
    ) ?? null
  );
}

/**
 * Put one notification in front of one account.
 *
 * A `progress` notification *replaces* the live one if there is one — the patrol
 * re-sends the whole current picture every time it runs, and a person should
 * carry one of those, not a pile. Patching also clears a `link` or `keys` the
 * previous picture had and this one does not (`ctx.db.patch` with `undefined`
 * removes the field), so the row never mixes two pictures. The row keeps its
 * place in the list: it is the same notification refreshed, not news.
 */
async function deliver(
  ctx: MutationCtx,
  account: string,
  content: NotificationContent,
): Promise<{ id: Id<"notifications">; merged: boolean }> {
  if (content.kind === "progress") {
    const live = await liveProgress(ctx, account);
    if (live) {
      await ctx.db.patch(live._id, {
        text: content.text,
        link: content.link,
        keys: content.keys,
      });
      return { id: live._id, merged: true };
    }
  }
  const id = await ctx.db.insert("notifications", { account, ...content });
  return { id, merged: false };
}

/**
 * Deliver one notification to every account that can read the board, except the
 * tracker itself (it has no bell, and its own report is not news to it).
 *
 * Shared by `trackerBroadcast` and `trackerPublishReport` so that "everybody" is
 * one definition rather than two that can drift apart.
 */
async function broadcast(
  ctx: MutationCtx,
  sender: Doc<"users">,
  content: NotificationContent,
): Promise<string[]> {
  const users = await ctx.db.query("users").take(BROADCAST_LIMIT);
  const accounts = users
    .filter((user) => user.permRead && user.account !== sender.account)
    .map((user) => user.account)
    .sort((a, b) => a.localeCompare(b));

  for (const account of accounts) await deliver(ctx, account, content);
  return accounts;
}

/** Validate the content half of a send, wherever it came from. */
function cleanContent(input: {
  kind: Doc<"notifications">["kind"];
  text: string;
  link?: string;
  keys?: readonly string[];
}): NotificationContent {
  return {
    kind: input.kind,
    text: cleanText(input.text),
    link: input.link === undefined ? undefined : cleanHttpUrl(input.link, "連結"),
    keys: cleanKeys(input.keys),
  };
}

// ---------------------------------------------------------------------------
// Public — the person's half
// ---------------------------------------------------------------------------

const notificationValidator = v.object({
  _id: v.id("notifications"),
  _creationTime: v.number(),
  kind: notificationKindValidator,
  text: v.string(),
  link: v.optional(v.string()),
  keys: v.optional(v.array(v.string())),
});

/**
 * The caller's live notifications, newest first — what the bell subscribes to.
 *
 * Dismissed rows are gone from here, including a `progress` row that is waiting
 * for a recheck: pressing dismiss means "I've dealt with this", and the recheck
 * that follows is the tracker's business, not a line the person has to keep
 * looking at. If they have not in fact caught up, the next scan sends a fresh
 * one.
 */
export const mine = query({
  args: { auth: credentialsValidator },
  returns: v.array(notificationValidator),
  handler: async (ctx, args) => {
    const user = await requireRead(ctx, args.auth);

    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_account", (q) => q.eq("account", user.account))
      .order("desc")
      .take(LIST_LIMIT);

    return rows
      .filter((row) => row.dismissedAt === undefined)
      .map((row) => ({
        _id: row._id,
        _creationTime: row._creationTime,
        kind: row.kind,
        text: row.text,
        link: row.link,
        keys: row.keys,
      }));
  },
});

/**
 * Dismiss one of the caller's own notifications.
 *
 * On a `progress` row this is a claim: "I've caught up". So the row is kept —
 * stamped `dismissedAt` and `recheckPending` — and becomes the tracker's recheck
 * queue (`trackerPendingRechecks`), which either confirms it or comes back with
 * what is still open. On `report` and `info` there is nothing to check, so the
 * row is simply deleted; notifications are live state, not history.
 */
export const dismiss = mutation({
  args: {
    auth: credentialsValidator,
    notificationId: v.id("notifications"),
  },
  returns: v.object({ recheckPending: v.boolean() }),
  handler: async (ctx, args) => {
    const user = await requireRead(ctx, args.auth);

    const row = await ctx.db.get(args.notificationId);
    if (!row || row.account !== user.account) {
      throw new Error("這則通知不在你的通知清單裡。");
    }
    // Already dismissed: the outcome asked for, and pressing twice (two tabs,
    // a retry) must not turn a resolved row back into a recheck.
    if (row.dismissedAt !== undefined) {
      return { recheckPending: row.recheckPending === true };
    }

    if (row.kind === "progress") {
      await ctx.db.patch(row._id, {
        dismissedAt: Date.now(),
        recheckPending: true,
      });
      return { recheckPending: true };
    }

    await ctx.db.delete(row._id);
    return { recheckPending: false };
  },
});

// ---------------------------------------------------------------------------
// The tracker's half — public, but only for `permTracker`
// ---------------------------------------------------------------------------

/**
 * Send one person a notification, or refresh the one they already have.
 *
 * `progress` merges (see `deliver`), `report` and `info` always insert. The
 * recipient has to exist and to have `permRead`, so a stale
 * `config.assigneeAccounts` mapping fails in the tracker's output instead of
 * quietly filling a table nobody reads.
 */
export const trackerSend = mutation({
  args: {
    auth: credentialsValidator,
    account: v.string(),
    kind: notificationKindValidator,
    text: v.string(),
    link: v.optional(v.string()),
    keys: v.optional(v.array(v.string())),
  },
  returns: v.object({
    notificationId: v.id("notifications"),
    /** True when it replaced the recipient's live progress notification. */
    merged: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireTracker(ctx, args.auth);

    const recipient = await requireRecipient(ctx, args.account);
    const { id, merged } = await deliver(
      ctx,
      recipient.account,
      cleanContent(args),
    );
    return { notificationId: id, merged };
  },
});

/**
 * Send the same notification to everybody who can read the board.
 *
 * Accounts without `permRead` are skipped (a pending registration has no board to
 * put it in context) and so is the tracker's own account — it has no bell, and a
 * report it published is not news to it. Everything else about delivery is
 * `trackerSend`'s, merge semantics included.
 */
export const trackerBroadcast = mutation({
  args: {
    auth: credentialsValidator,
    kind: notificationKindValidator,
    text: v.string(),
    link: v.optional(v.string()),
  },
  returns: v.object({
    sent: v.number(),
    accounts: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const sender = await requireTracker(ctx, args.auth);
    const accounts = await broadcast(ctx, sender, cleanContent(args));
    return { sent: accounts.length, accounts };
  },
});

/**
 * Progress notifications whose owner pressed dismiss and is waiting to be
 * checked — the hourly scan's whole input.
 *
 * Cheap when idle, which is the point: an empty answer ends that duty
 * immediately. The row carries what was said when it was dismissed, so the scan
 * knows what it is re-checking without reading anything else.
 */
export const trackerPendingRechecks = query({
  args: { auth: credentialsValidator },
  returns: v.array(
    v.object({
      _id: v.id("notifications"),
      account: v.string(),
      text: v.string(),
      keys: v.optional(v.array(v.string())),
      dismissedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    await requireTracker(ctx, args.auth);

    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_recheck", (q) => q.eq("recheckPending", true))
      .take(RECHECK_LIMIT);

    return rows
      .map((row) => ({
        _id: row._id,
        account: row.account,
        text: row.text,
        keys: row.keys,
        // Always set alongside `recheckPending`; the fallback only exists so the
        // shape is a number rather than an optional nobody has to think about.
        dismissedAt: row.dismissedAt ?? row._creationTime,
      }))
      .sort((a, b) => a.dismissedAt - b.dismissedAt);
  },
});

/**
 * Close one recheck, optionally saying what was found in the same breath.
 *
 * One mutation rather than two calls because the two halves belong together: the
 * scan's conclusion is either 「進度已追上」 (an `info` follow-up) or a fresh
 * `progress` notification listing what is still open, and a crash between
 * "cleared the recheck" and "said why" would leave the person with neither.
 * Clearing means deleting the row — the recheck was the row's last job.
 */
export const trackerResolveRecheck = mutation({
  args: {
    auth: credentialsValidator,
    notificationId: v.id("notifications"),
    followUp: v.optional(
      v.object({
        kind: notificationKindValidator,
        text: v.string(),
        link: v.optional(v.string()),
        keys: v.optional(v.array(v.string())),
      }),
    ),
  },
  returns: v.object({
    account: v.string(),
    followUpSent: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireTracker(ctx, args.auth);

    const row = await ctx.db.get(args.notificationId);
    if (!row || row.recheckPending !== true) {
      throw new Error("這筆通知不在待複查清單裡（可能已經複查過了）。");
    }

    const account = row.account;
    await ctx.db.delete(row._id);

    if (args.followUp) {
      await deliver(ctx, account, cleanContent(args.followUp));
    }
    return { account, followUpSent: args.followUp !== undefined };
  },
});

/**
 * A one-shot URL for uploading the weekly report's HTML to Convex storage.
 *
 * The file goes straight from the tracker's container to storage (POST the HTML
 * with `content-type: text/html`, keep the `storageId` from the answer), so no
 * report body ever travels through a mutation argument. See
 * `.claude/skills/board-tracker/scripts/upload-report.mjs`.
 */
export const trackerReportUploadUrl = mutation({
  args: { auth: credentialsValidator },
  returns: v.string(),
  handler: async (ctx, args) => {
    await requireTracker(ctx, args.auth);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Record an uploaded weekly report and broadcast it to everybody.
 *
 * The week number is the idempotency key, exactly as in `board:addNextWeek`:
 * publishing a week that already has a report is refused, so a Monday routine
 * that fires twice — or a retry that never saw its answer — cannot broadcast the
 * same report to the whole team again. The refusal names the week, which is also
 * the answer the tracker needs ("it is already out").
 *
 * The link stored on the notification is the file's storage URL, resolved here
 * rather than in `mine`: it is stable for the life of the file, so resolving it
 * per read would be one lookup per bell per render for the same string. That URL
 * is unauthenticated — anybody holding it can read the report — which is the same
 * trade the fixed `tokenHash` makes, and the reason the skill says a report must
 * not contain anything that is not already on the board.
 */
export const trackerPublishReport = mutation({
  args: {
    auth: credentialsValidator,
    storageId: v.id("_storage"),
    weekNumber: v.number(),
    startDate: v.string(),
    endDate: v.string(),
    /** What the broadcast calls it; defaults to "W<n> 週報". */
    title: v.optional(v.string()),
  },
  returns: v.object({
    reportId: v.id("reports"),
    url: v.string(),
    title: v.string(),
    sent: v.number(),
    accounts: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const sender = await requireTracker(ctx, args.auth);

    if (!Number.isInteger(args.weekNumber) || args.weekNumber <= 0) {
      throw new Error(`weekNumber 必須是正整數，收到 ${args.weekNumber}。`);
    }
    assertIsoDate(args.startDate, "startDate");
    assertIsoDate(args.endDate, "endDate");
    if (args.endDate < args.startDate) {
      throw new Error(
        `週報的區間反了：${args.startDate} ~ ${args.endDate}。用 npm run week 換算。`,
      );
    }

    const existing = await ctx.db
      .query("reports")
      .withIndex("by_week", (q) => q.eq("weekNumber", args.weekNumber))
      .first();
    if (existing) {
      throw new Error(
        `W${args.weekNumber} 的週報已經發布過了（${existing.startDate} ~ ` +
          `${existing.endDate}），不會再廣播一次。`,
      );
    }

    // A storageId with no file behind it would broadcast a dead link; the URL is
    // needed for the notification anyway, so this costs nothing extra.
    const url = await ctx.storage.getUrl(args.storageId);
    if (!url) {
      throw new Error("storageId 找不到對應的檔案，先重新上傳週報。");
    }

    const title = cleanText(args.title ?? `W${args.weekNumber} 週報`, "標題");
    const reportId = await ctx.db.insert("reports", {
      weekNumber: args.weekNumber,
      startDate: args.startDate,
      endDate: args.endDate,
      storageId: args.storageId,
      title,
    });

    const content = cleanContent({
      kind: "report",
      text: `${title}（${args.startDate} ~ ${args.endDate}）`,
      link: url,
    });

    const accounts = await broadcast(ctx, sender, content);
    return { reportId, url, title, sent: accounts.length, accounts };
  },
});

// ---------------------------------------------------------------------------
// Internal — terminal-only maintenance
// ---------------------------------------------------------------------------

/**
 * Wipe the tracker's working data — every notification and every report,
 * report files in storage included. Internal, like import and account
 * management: this is a terminal reset for a dev deployment between test runs
 * (a published week number blocks re-publishing that week), never something a
 * public caller can reach.
 *
 * ```bash
 * npx convex run notifications:clearTrackerData
 * ```
 */
export const clearTrackerData = internalMutation({
  args: {},
  returns: v.object({ notifications: v.number(), reports: v.number() }),
  handler: async (ctx) => {
    const notifications = await ctx.db.query("notifications").collect();
    for (const row of notifications) await ctx.db.delete(row._id);

    const reports = await ctx.db.query("reports").collect();
    for (const row of reports) {
      await ctx.storage.delete(row.storageId);
      await ctx.db.delete(row._id);
    }

    return { notifications: notifications.length, reports: reports.length };
  },
});
