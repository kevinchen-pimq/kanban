import { v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import {
  cleanAccount,
  credentialsValidator,
  requirePermission,
  requireRead,
  type Credentials,
} from "./auth";
import {
  commandStatusValidator,
  commandValidator,
  messageRoleValidator,
} from "./schema";

/**
 * The board assistant's chat.
 *
 * A person talks to an agent (a Claude Code session in a terminal) about their
 * board; the agent answers, and when something should change it posts a
 * **command** — one of the five board operations, naming cards by key. The
 * *browser* then executes that command with the signed-in user's own credentials
 * through the ordinary `board:*` mutations.
 *
 * That last sentence is the whole design. The agent has no board access at all:
 * these functions are the only ones it can call, and none of them reads or writes
 * `tickets`. Everything that follows from a command therefore carries the user's
 * permissions rather than the agent's — `permWrite` applies it, `permEditRequest`
 * turns it into a pending edit request with no extra code, read-only refuses it —
 * and the board's validation, guards and edit-request merging are the same ones a
 * human click goes through.
 *
 * Two halves, split by which permission they ask for:
 *
 * - **The person's side** (`send` / `thread` / `claim` / `report`), all behind
 *   `requireRead` and all scoped to the caller's own thread. `claim` is the
 *   interesting one: it is a separate mutation purely so that marking a command
 *   as "mine to run" is one atomic step, which is what keeps two open tabs from
 *   executing it twice.
 * - **The agent's side** (`agentInbox` / `agentRead` / `agentReply` /
 *   `agentCommand` / `agentMarkHandled`), all behind `permAgent`. They are public
 *   functions because the agent runs in a container with no Convex credentials at
 *   all: it authenticates the same way the browser does, by sending
 *   `{ account, tokenHash }`, over plain HTTP against `/api/query` and
 *   `/api/mutation` (see `.claude/skills/board-assistant/SKILL.md`).
 *
 * `permAgent` is a narrow permission and is meant to stay narrow. An assistant
 * account holds it plus `permRead` — enough to read the board it is discussing and
 * to work the chat, and nothing more. It has no `permWrite` and no
 * `permEditRequest`, so the only way anything it says reaches the board is a
 * command a person's browser chooses to run.
 */

/** Messages returned for one thread. Long enough to hold a working session. */
const THREAD_LIMIT = 200;

/** Unhandled rows the agent's inbox scans. A larger backlog is a stuck agent. */
const INBOX_LIMIT = 500;

const MAX_TEXT = 4000;

/**
 * How long a claimed command may stay silent before another tab may take it.
 *
 * The claim exists to stop double execution, not to make a closed tab wedge the
 * conversation for ever: a browser that vanished between claiming and reporting
 * leaves a `running` row that nothing will ever settle. Comfortably longer than a
 * board mutation takes, short enough that a person notices no stall.
 */
const STALE_CLAIM_MS = 60_000;

function cleanText(value: string, field = "訊息"): string {
  const text = value.trim();
  if (!text) throw new Error(`${field}不能是空的。`);
  if (text.length > MAX_TEXT) {
    throw new Error(`${field}超過 ${MAX_TEXT} 個字元。`);
  }
  return text;
}

/** The gate in front of every function the assistant agent calls. */
function requireAgent(ctx: QueryCtx, credentials: Credentials) {
  return requirePermission(ctx, credentials, "permAgent");
}

/**
 * The account an agent call names, or a readable error.
 *
 * The agent types account names by hand, so a typo would otherwise open a thread
 * nobody can ever read — every reader is scoped to their own account.
 */
async function requireAccount(
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
  return user;
}

/** One thread, oldest first. */
async function threadFor(
  ctx: QueryCtx,
  account: string,
  limit: number,
): Promise<Doc<"messages">[]> {
  const newest = await ctx.db
    .query("messages")
    .withIndex("by_account", (q) => q.eq("account", account))
    .order("desc")
    .take(limit);
  return newest.reverse();
}

/** A command message that is still on its way to an ending. */
function inFlight(message: Doc<"messages">): boolean {
  return message.status === "pending" || message.status === "running";
}

// ---------------------------------------------------------------------------
// Public — the browser's half
// ---------------------------------------------------------------------------

const messageValidator = v.object({
  _id: v.id("messages"),
  _creationTime: v.number(),
  role: messageRoleValidator,
  text: v.string(),
  command: v.optional(commandValidator),
  status: v.optional(commandStatusValidator),
  result: v.optional(v.string()),
});

function toView(message: Doc<"messages">) {
  return {
    _id: message._id,
    _creationTime: message._creationTime,
    role: message.role,
    text: message.text,
    command: message.command,
    status: message.status,
    result: message.result,
  };
}

/**
 * Say something to the assistant.
 *
 * `permRead` is the bar, not `permWrite`: asking is not editing. What the agent
 * asks for in return is checked when the browser runs it, by the mutation that
 * does the work.
 */
export const send = mutation({
  args: { auth: credentialsValidator, text: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireRead(ctx, args.auth);
    await ctx.db.insert("messages", {
      account: user.account,
      role: "user",
      text: cleanText(args.text),
      handled: false,
    });
    return null;
  },
});

/**
 * The caller's own conversation, as a subscription.
 *
 * Scoped to their account with no way to ask for another one, so a thread is
 * private by construction rather than by a filter someone has to remember. It is
 * also what drives the executor: a command the agent posts arrives here, and the
 * browser acts on it.
 */
export const thread = query({
  args: { auth: credentialsValidator },
  returns: v.array(messageValidator),
  handler: async (ctx, args) => {
    const user = await requireRead(ctx, args.auth);
    const messages = await threadFor(ctx, user.account, THREAD_LIMIT);
    return messages.map(toView);
  },
});

/**
 * Take ownership of one pending command, atomically.
 *
 * This is why claiming is its own mutation. A Convex mutation is a serialisable
 * transaction, so of two tabs reading the same `pending` row exactly one comes
 * back with `claimed: true`; the other sees `running` and leaves it alone. Doing
 * this inside the executor's "read the thread, then run it" would leave a window
 * where both tabs believed the command was theirs, and the user would get the
 * card moved twice — or two edit requests to review.
 *
 * A claim older than `STALE_CLAIM_MS` may be taken over: that row belongs to a tab
 * that closed mid-flight, and nothing else will ever settle it.
 */
export const claim = mutation({
  args: { auth: credentialsValidator, messageId: v.id("messages") },
  returns: v.object({ claimed: v.boolean() }),
  handler: async (ctx, args) => {
    const user = await requireRead(ctx, args.auth);

    const message = await ctx.db.get(args.messageId);
    if (!message || message.account !== user.account) {
      throw new Error("這則訊息不在你的對話裡。");
    }
    if (!message.command) throw new Error("這則訊息不是一個指令。");

    const stale =
      message.status === "running" &&
      Date.now() - (message.claimedAt ?? 0) > STALE_CLAIM_MS;
    if (message.status !== "pending" && !stale) return { claimed: false };

    await ctx.db.patch(message._id, {
      status: "running",
      claimedAt: Date.now(),
    });
    return { claimed: true };
  },
});

/**
 * Say how a claimed command ended.
 *
 * Three endings, and the difference between the first two is the account's
 * permissions rather than anything about the command: `executed` means the board
 * changed, `proposed` means an edit request is now waiting for a reviewer, and
 * `failed` carries the reason — a key that matches no card, a week that is not on
 * the board, a validation complaint from the mutation itself. The agent reads
 * that reason and corrects, so it is copied through verbatim.
 *
 * Only the browser that holds the claim may report, and only once: a settled
 * command is never re-opened.
 */
export const report = mutation({
  args: {
    auth: credentialsValidator,
    messageId: v.id("messages"),
    outcome: v.union(
      v.literal("executed"),
      v.literal("proposed"),
      v.literal("failed"),
    ),
    detail: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const user = await requireRead(ctx, args.auth);

    const message = await ctx.db.get(args.messageId);
    if (!message || message.account !== user.account) {
      throw new Error("這則訊息不在你的對話裡。");
    }
    if (message.status !== "running") return null; // already settled

    await ctx.db.patch(message._id, {
      status: args.outcome,
      result: args.detail?.trim() || undefined,
      // Left unhandled on purpose: the result is the thing the agent came back
      // for, and `markHandled` refuses to clear it until it exists.
      handled: false,
    });
    return null;
  },
});

// ---------------------------------------------------------------------------
// The agent's half — public, but only for `permAgent`
// ---------------------------------------------------------------------------

/**
 * Every thread with something waiting for the agent, newest activity first.
 *
 * This is the poll target: one cheap query that answers "is there anything to do,
 * and where". Three counts, because they call for different things — a new
 * question needs an answer, a command in flight needs patience, and a settled
 * command needs its result read (especially a failed one).
 */
export const agentInbox = query({
  args: { auth: credentialsValidator },
  returns: v.array(
    v.object({
      account: v.string(),
      /** Questions the agent has not answered yet. */
      newUserMessages: v.number(),
      /** Commands a browser has not finished (pending or running). */
      commandsInFlight: v.number(),
      /** Commands that ended and whose result the agent has not read. */
      commandsSettled: v.number(),
      /** Creation time of the newest unhandled message in this thread. */
      latestAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAgent(ctx, args.auth);

    const waiting = await ctx.db
      .query("messages")
      .withIndex("by_handled", (q) => q.eq("handled", false))
      .take(INBOX_LIMIT);

    type Row = {
      account: string;
      newUserMessages: number;
      commandsInFlight: number;
      commandsSettled: number;
      latestAt: number;
    };
    const byAccount = new Map<string, Row>();

    for (const message of waiting) {
      const row = byAccount.get(message.account) ?? {
        account: message.account,
        newUserMessages: 0,
        commandsInFlight: 0,
        commandsSettled: 0,
        latestAt: 0,
      };
      if (message.role === "user") row.newUserMessages++;
      else if (message.command) {
        if (inFlight(message)) row.commandsInFlight++;
        else row.commandsSettled++;
      }
      row.latestAt = Math.max(row.latestAt, message._creationTime);
      byAccount.set(message.account, row);
    }

    return [...byAccount.values()].sort((a, b) => b.latestAt - a.latestAt);
  },
});

/**
 * One whole conversation, oldest first — including whether each row is still
 * waiting for the agent, so a poll can tell new from already-answered.
 */
export const agentRead = query({
  args: {
    auth: credentialsValidator,
    account: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      messageId: v.id("messages"),
      at: v.number(),
      role: messageRoleValidator,
      text: v.string(),
      command: v.optional(commandValidator),
      status: v.optional(commandStatusValidator),
      result: v.optional(v.string()),
      handled: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAgent(ctx, args.auth);

    const user = await requireAccount(ctx, args.account);
    const messages = await threadFor(
      ctx,
      user.account,
      Math.min(args.limit ?? THREAD_LIMIT, THREAD_LIMIT),
    );
    return messages.map((message) => ({
      messageId: message._id,
      at: message._creationTime,
      role: message.role,
      text: message.text,
      command: message.command,
      status: message.status,
      result: message.result,
      handled: message.handled,
    }));
  },
});

/** Answer in words. Nothing to come back for, so it is handled on arrival. */
export const agentReply = mutation({
  args: {
    auth: credentialsValidator,
    account: v.string(),
    text: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAgent(ctx, args.auth);

    const user = await requireAccount(ctx, args.account);
    await ctx.db.insert("messages", {
      account: user.account,
      role: "agent",
      text: cleanText(args.text, "回覆"),
      handled: true,
    });
    return null;
  },
});

/**
 * Ask the user's browser to do one thing to the board.
 *
 * `description` is not decoration: it is what the chat window shows, and the only
 * part of a command a person reads. Say what will change in one sentence, in
 * their language — "把 ABC-12 移到 W34" — because a command whose description does
 * not match its payload is indistinguishable from a mistake.
 *
 * Stays unhandled until the agent has read the result, so a failure cannot be
 * quietly forgotten.
 */
export const agentCommand = mutation({
  args: {
    auth: credentialsValidator,
    account: v.string(),
    description: v.string(),
    command: commandValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAgent(ctx, args.auth);

    const user = await requireAccount(ctx, args.account);
    await ctx.db.insert("messages", {
      account: user.account,
      role: "agent",
      text: cleanText(args.description, "指令說明"),
      command: args.command,
      status: "pending",
      handled: false,
    });
    return null;
  },
});

/**
 * Clear one thread's inbox: "I have read all of this".
 *
 * Commands still in flight are deliberately left behind — marking them handled
 * would drop the one thing the agent posted them for. Call it after answering and
 * after reading the results, and the inbox goes quiet until the person says
 * something else.
 */
export const agentMarkHandled = mutation({
  args: { auth: credentialsValidator, account: v.string() },
  returns: v.object({ marked: v.number(), stillInFlight: v.number() }),
  handler: async (ctx, args) => {
    await requireAgent(ctx, args.auth);

    const user = await requireAccount(ctx, args.account);
    const messages = await threadFor(ctx, user.account, THREAD_LIMIT);

    let marked = 0;
    let stillInFlight = 0;
    for (const message of messages) {
      if (message.handled) continue;
      if (message.command && inFlight(message)) {
        stillInFlight++;
        continue;
      }
      await ctx.db.patch(message._id, { handled: true });
      marked++;
    }
    return { marked, stillInFlight };
  },
});
