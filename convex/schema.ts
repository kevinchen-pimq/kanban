import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import { checkpointRefValidator } from "./validation";

/**
 * The four status lights the board renders:
 *   todo    — 灰色: to do / backlog
 *   doing   — 藍色: doing
 *   testing — 黃色: test and review / dev done
 *   done    — 綠色: dev test done / done
 */
export const statusValidator = v.union(
  v.literal("todo"),
  v.literal("doing"),
  v.literal("testing"),
  v.literal("done"),
);

/** Colour key for an epic's badge. Resolved to concrete classes in the UI. */
export const accentValidator = v.union(
  v.literal("indigo"),
  v.literal("purple"),
  v.literal("cyan"),
  v.literal("emerald"),
);

/**
 * A row is either a dated week or the undated backlog pool. Weeks carry their
 * own start/end date so "本週" is derived from today rather than stored, and
 * the board never needs a weekly data edit.
 */
export const checkpointKindValidator = v.union(
  v.literal("week"),
  v.literal("backlog"),
);

/** What one pending edit request asks for. See `convex/editRequests.ts`. */
export const editRequestKindValidator = v.union(
  v.literal("create"),
  v.literal("update"),
  v.literal("delete"),
  v.literal("reorder"),
);

/**
 * A card the board's writes can name: a real ticket, or — for the account that
 * proposed it — one of its own pending `create` requests.
 *
 * A proposed card has no row in `tickets` yet, but it is on screen for the
 * requester and has to be editable, draggable and deletable like any other card
 * (that is what makes "create then update" merge into one request). Accepting the
 * request's own id here is what keeps the client's call surface single: it always
 * sends `ticket._id`, whatever the card is.
 */
export const ticketRefValidator = v.union(
  v.id("tickets"),
  v.id("editRequests"),
);

/**
 * The editable half of a card, as an edit request stores it.
 *
 * Absent means "not part of this request"; `null` means "clear this field". Both
 * halves of a request use this shape — `fields` is what is being asked for and
 * `before` is what the card said when the request was first made, which is what
 * lets the review UI show `標題: A → B` without reading history.
 */
export const editFieldsValidator = v.object({
  title: v.optional(v.string()),
  key: v.optional(v.string()),
  checkpointId: v.optional(v.id("checkpoints")),
  status: v.optional(statusValidator),
  assignee: v.optional(v.union(v.string(), v.null())),
  dueDate: v.optional(v.union(v.string(), v.null())),
  tag: v.optional(v.union(v.string(), v.null())),
  githubPrs: v.optional(v.union(v.array(v.string()), v.null())),
});

/** Who wrote a chat message: the person, or the board assistant agent. */
export const messageRoleValidator = v.union(
  v.literal("user"),
  v.literal("agent"),
);

/**
 * One board operation the assistant asks the user's browser to perform.
 *
 * The five shapes map one-to-one onto the five `board:*` mutations, and that is
 * the whole surface — an agent cannot ask for anything the board itself cannot
 * do. Cards are named by **key** and cells by epic `code` + week number, never by
 * Convex id: the agent talks to a terminal and reads keys off the board or out of
 * Jira, while ids are per-deployment and meaningless to it. The browser resolves
 * those names against the board it can see (`src/lib/assistant.ts`), so a name
 * that matches nothing fails the command instead of guessing.
 *
 * `createTicket` may leave `checkpoint` out, which lands the card in the backlog
 * pool — the honest row for work with no week yet.
 */
export const commandValidator = v.union(
  v.object({
    kind: v.literal("moveTicket"),
    key: v.string(),
    checkpoint: checkpointRefValidator,
  }),
  v.object({
    kind: v.literal("reorderCell"),
    epicCode: v.string(),
    checkpoint: checkpointRefValidator,
    /** Every card in the cell, in the order it should be shown. */
    keys: v.array(v.string()),
  }),
  v.object({
    kind: v.literal("createTicket"),
    epicCode: v.string(),
    title: v.string(),
    checkpoint: v.optional(checkpointRefValidator),
    key: v.optional(v.string()),
    status: v.optional(statusValidator),
    assignee: v.optional(v.string()),
    dueDate: v.optional(v.string()),
    tag: v.optional(v.string()),
    githubPrs: v.optional(v.array(v.string())),
  }),
  v.object({
    kind: v.literal("updateTicket"),
    key: v.string(),
    title: v.optional(v.string()),
    checkpoint: v.optional(checkpointRefValidator),
    status: v.optional(statusValidator),
    // `null` clears the field, exactly as in `board:updateTicket`.
    assignee: v.optional(v.union(v.string(), v.null())),
    dueDate: v.optional(v.union(v.string(), v.null())),
    tag: v.optional(v.union(v.string(), v.null())),
    githubPrs: v.optional(v.union(v.array(v.string()), v.null())),
  }),
  v.object({ kind: v.literal("deleteTicket"), key: v.string() }),
);

/**
 * Where a command message is in its life.
 *
 * `pending` → a browser claims it (`running`) → one of three endings. `proposed`
 * is not a separate kind of success: it is what "executed" means for an account
 * that may only propose, and saying so is the difference between "done" and
 * "waiting for a reviewer".
 */
export const commandStatusValidator = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("executed"),
  v.literal("proposed"),
  v.literal("failed"),
);

export default defineSchema({
  // X axis: one column per epic, left to right by `order`.
  epics: defineTable({
    code: v.string(),
    name: v.string(),
    accent: accentValidator,
    order: v.number(),
  })
    // `code` is the natural key imports match on.
    .index("by_code", ["code"])
    .index("by_order", ["order"]),

  // Y axis: one row per checkpoint, top to bottom by `order`.
  checkpoints: defineTable({
    kind: checkpointKindValidator,
    // Present when kind === "week". This is the team's own checkpoint number,
    // which is not the ISO week number, so it is stored rather than computed.
    weekNumber: v.optional(v.number()),
    // ISO calendar dates, "YYYY-MM-DD". Inclusive on both ends.
    startDate: v.optional(v.string()),
    endDate: v.optional(v.string()),
    // Present when kind === "backlog".
    label: v.optional(v.string()),
    order: v.number(),
  })
    // Weeks are matched on their number; the backlog row is matched on kind.
    .index("by_kind_and_week", ["kind", "weekNumber"])
    .index("by_order", ["order"]),

  // Cards, each sitting in exactly one (checkpoint, epic) cell.
  tickets: defineTable({
    key: v.string(),
    title: v.string(),
    epicId: v.id("epics"),
    checkpointId: v.id("checkpoints"),
    status: statusValidator,
    // ISO calendar date, "YYYY-MM-DD". Absent means no due date.
    dueDate: v.optional(v.string()),
    // Pull requests that reference this ticket's key, oldest first. A ticket
    // can span several, so this is a list rather than a single URL.
    githubPrs: v.optional(v.array(v.string())),
    // Both optional: the Jira import carries neither, and the card simply
    // omits whichever is missing.
    tag: v.optional(v.string()),
    assignee: v.optional(v.string()),
    // Position within its (epic, checkpoint) cell, ascending. Optional because
    // no import sets it: cards that have never been dragged into an order have
    // none, and the board falls back to creation order for them.
    order: v.optional(v.number()),
  })
    .index("by_key", ["key"])
    .index("by_checkpoint_and_epic", ["checkpointId", "epicId"]),

  // Accounts that may read or edit the board.
  //
  // `tokenHash` is sha256("kanban:<account>:<password>"), computed in the
  // browser: the password itself never reaches the server, is never stored and
  // never appears in a log. The hash is the whole credential — every query and
  // mutation carries { account, tokenHash } and is checked against this row, so
  // there is no session, no expiry and no revocation beyond deleting or
  // re-seeding the account. See `docs/data-model.md` for the trade-off.
  //
  // The five permissions are independent and default to false, which is what
  // makes a fresh registration a *pending* one: it can log in as far as being
  // told it is awaiting approval, and nothing else.
  users: defineTable({
    // Lowercased, trimmed. Also what the token hash is computed over, so it is
    // normalised on the client before hashing.
    account: v.string(),
    // Hex sha256 of "kanban:<account>:<password>", 64 lowercase hex chars.
    tokenHash: v.string(),
    // Read the board at all. `false` means "registered, awaiting approval".
    permRead: v.boolean(),
    // Edit the board: drag, create, update, delete, cycle status.
    permWrite: v.boolean(),
    // See pending registrations and approve or dismiss them.
    permApproveRegister: v.boolean(),
    // Propose edits instead of making them: the board offers every editing
    // affordance, and each one writes an `editRequests` row for somebody with
    // `permWrite` to approve. Optional because accounts created before edit
    // requests existed have no such field — absent reads as false everywhere,
    // which is the same answer a backfill would have given without the write.
    permEditRequest: v.optional(v.boolean()),
    // Act as the board assistant: read every chat thread and post agent replies
    // and commands (`convex/messages.ts`). An agent account holds this plus
    // `permRead` and *nothing else* — it can see the board well enough to talk
    // about it and it can ask, but every actual write goes through the browser of
    // the person it is talking to, with that person's permissions. Optional for
    // the same reason as `permEditRequest`: absent is false.
    permAgent: v.optional(v.boolean()),
  })
    // `account` is the natural key every credential check looks up.
    .index("by_account", ["account"]),

  // Edits proposed by an account that has `permEditRequest` but not `permWrite`.
  //
  // One row is one pending request, and there is at most one per (requester,
  // target): a second operation on the same card merges into the row that is
  // already there, so a card someone moved and then retitled is one request with
  // one diff rather than two things to approve. Requests are not history — an
  // approved or dismissed row is deleted.
  //
  // The requester sees their own pending rows overlaid on the board by
  // `board:get`, which is why they survive a reload: the "not yet real" version
  // of the board lives here, on the server, not in the tab.
  editRequests: defineTable({
    requestedBy: v.id("users"),
    // The requester's account name, copied so the review list can name them
    // without reading the `users` table row by row.
    account: v.string(),
    kind: editRequestKindValidator,
    // The card being changed, for `update` and `delete`.
    ticketId: v.optional(v.id("tickets")),
    // The cell, for `create` (where the card would land) and `reorder`.
    epicId: v.optional(v.id("epics")),
    checkpointId: v.optional(v.id("checkpoints")),
    // What is being asked for. A `create` carries the whole card here; an
    // `update` carries only the fields it changes.
    fields: v.optional(editFieldsValidator),
    // What the card said when this request was first made — the left-hand side
    // of the diff. Absent on `create` (there was nothing) and on `reorder`.
    before: v.optional(editFieldsValidator),
    // The cell's cards in the requested order, for `reorder`. May name one of
    // the requester's own pending `create` requests, which approval drops: a
    // card that does not exist yet cannot be given a position.
    ticketIds: v.optional(v.array(ticketRefValidator)),
  })
    // Everything is looked up per requester: the overlay reads their own rows,
    // and so does the merge that folds a second operation into the first.
    .index("by_requester", ["requestedBy"]),

  // The board assistant's chat: one thread per account.
  //
  // The agent behind it is a Claude Code session in a terminal, and this table is
  // the *whole* interface it has. It reads and writes messages through internal
  // functions; it never touches `tickets`. When it wants something changed it
  // posts a `command` message, and the user's own browser executes it with the
  // user's own credentials against the ordinary `board:*` mutations — so
  // permissions come out right for free: `permWrite` applies the change,
  // `permEditRequest` turns it into a pending proposal, and read-only fails.
  //
  // `account` is the conversation: everybody has exactly one thread and can only
  // read their own (`messages:thread` filters by the caller's account), which is
  // also why there is no participant list and no thread id.
  messages: defineTable({
    // The thread this belongs to — the account that is talking to the assistant.
    account: v.string(),
    role: messageRoleValidator,
    // What the chat window shows. For a command message this is the agent's own
    // one-line description of what it is about to do, in human language: the user
    // should be able to read the conversation without decoding a payload.
    text: v.string(),
    // Present exactly on an agent command message; absent makes this plain talk.
    command: v.optional(commandValidator),
    // Present exactly when `command` is, tracking that command's execution.
    status: v.optional(commandStatusValidator),
    // The outcome once settled: what was done, or why it could not be.
    result: v.optional(v.string()),
    // When a browser claimed this command. A claim that never reported back (the
    // tab was closed mid-flight) goes stale and may be taken over.
    claimedAt: v.optional(v.number()),
    // Whether the agent has taken this message into account. User messages
    // arrive `false` and are the agent's inbox; its own replies are `true` at
    // once; its commands stay `false` until it has read the result.
    handled: v.boolean(),
  })
    // The thread, for the browser and for the agent reading one conversation.
    .index("by_account", ["account"])
    // The agent's inbox: everything still waiting for it, across all threads.
    .index("by_handled", ["handled"]),

  // Board-wide settings, as a single document (the first row wins).
  //
  // These are deployment settings rather than board data: the Jira site the
  // keys link to, and the colour each teammate's avatar gets. Keeping them here
  // instead of in the bundle means changing either one is a `npx convex run
  // data:setConfig` away, with no rebuild and no deploy. Written only through
  // that internal mutation; the board reads it as part of `board:get`.
  config: defineTable({
    // Jira browse root, e.g. "https://example.atlassian.net/browse". Absent
    // means the cards show their key as plain text instead of a link.
    jiraBaseUrl: v.optional(v.string()),
    // Assignee name (exactly as it appears on the ticket) → hex colour, e.g.
    // { "Some Person": "#7c2d12" }. Names absent from the map fall back to a
    // colour derived from the name in the UI.
    assigneeColors: v.optional(v.record(v.string(), v.string())),
  }),
});
