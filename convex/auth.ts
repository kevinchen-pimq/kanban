import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type QueryCtx,
} from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

/**
 * Account + password login, kept as small as it can be.
 *
 * There is no session and no token issuing. The browser computes
 * `sha256("kanban:<account>:<password>")` once (Web Crypto), keeps
 * `{ account, tokenHash }` in localStorage, and sends that pair as an argument
 * to every board query and mutation; each handler looks the account up here and
 * compares the hash. The password never leaves the browser, so it is neither
 * stored nor logged — but the hash is a fixed, non-expiring credential, which is
 * the deliberate trade for not building sessions, rotation or revocation. See
 * `docs/data-model.md`.
 *
 * Six independent permissions, all false on registration:
 *
 * - `permRead` — read the board. False means "registered, awaiting approval".
 * - `permWrite` — edit it (drag, create, update, delete, status).
 * - `permApproveRegister` — see and act on pending registrations.
 * - `permEditRequest` — use every editing affordance, but as a *proposal*: the
 *   write becomes an `editRequests` row for a `permWrite` account to approve.
 * - `permAgent` — be the board assistant: read every chat thread and post agent
 *   replies and commands (`convex/messages.ts`). Held together with `permRead`
 *   and nothing else, which is what keeps an agent unable to write to the board:
 *   its commands are executed by the browser of the person it is talking to.
 * - `permTracker` — be the board tracker: send notifications and publish the
 *   weekly report (`convex/notifications.ts`). Held together with `permRead` and
 *   `permEditRequest`, never `permWrite`, so every board change the tracker asks
 *   for arrives as a proposal for somebody to approve.
 *
 * `approve` only ever grants `permRead`; the other five are handed out from a
 * terminal through `seedUser`, so no browser call can widen its own powers.
 */

/** The credential pair every authenticated function takes. */
export const credentialsValidator = v.object({
  account: v.string(),
  tokenHash: v.string(),
});

export type Credentials = { account: string; tokenHash: string };

/**
 * Prefix on every denial, so the client can tell "your credentials are no
 * longer good" apart from a validation complaint and fall back to the login
 * screen instead of showing a red box over an empty board.
 */
export const AUTH_DENIED = "AUTH_DENIED";

/** Lowercase, no spaces: the account is part of the hashed token. */
const ACCOUNT_SHAPE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const TOKEN_HASH_SHAPE = /^[0-9a-f]{64}$/;

type Permission =
  | "permRead"
  | "permWrite"
  | "permApproveRegister"
  | "permEditRequest"
  | "permAgent"
  | "permTracker";

const PERMISSION_LABEL: Record<Permission, string> = {
  permRead: "讀取",
  permWrite: "編輯",
  permApproveRegister: "審核註冊",
  permEditRequest: "提議編輯",
  permAgent: "看板助理",
  permTracker: "進度追蹤",
};

/**
 * Normalise an account name the same way the client does before hashing, and
 * reject shapes that would make the credential ambiguous.
 */
export function cleanAccount(value: string): string {
  const account = value.trim().toLowerCase();
  if (!ACCOUNT_SHAPE.test(account)) {
    throw new Error(
      "帳號只能用英文字母、數字、點、減號與底線，長度 3–32 個字元。",
    );
  }
  return account;
}

function cleanTokenHash(value: string): string {
  const tokenHash = value.trim().toLowerCase();
  if (!TOKEN_HASH_SHAPE.test(tokenHash)) {
    throw new Error("tokenHash 必須是 64 個十六進位字元的 sha256 值。");
  }
  return tokenHash;
}

async function byAccount(ctx: QueryCtx, account: string) {
  return await ctx.db
    .query("users")
    .withIndex("by_account", (q) => q.eq("account", account))
    .unique();
}

/**
 * The user behind a credential pair, or null when either the account or the
 * hash does not match. Both misses return the same answer on purpose: the login
 * screen should not tell a stranger which accounts exist.
 */
async function authenticate(
  ctx: QueryCtx,
  credentials: Credentials,
): Promise<Doc<"users"> | null> {
  const account = credentials.account.trim().toLowerCase();
  if (!ACCOUNT_SHAPE.test(account)) return null;
  const user = await byAccount(ctx, account);
  if (!user) return null;
  return user.tokenHash === credentials.tokenHash.trim().toLowerCase()
    ? user
    : null;
}

/**
 * Check a credential pair and one permission, or throw.
 *
 * This is the only gate in front of the board's data: `MutationCtx` is
 * structurally a `QueryCtx`, so reads and writes share it. Every public board
 * function calls it first, before touching or returning anything.
 */
export async function requirePermission(
  ctx: QueryCtx,
  credentials: Credentials,
  permission: Permission,
): Promise<Doc<"users">> {
  const user = await authenticate(ctx, credentials);
  if (!user) {
    throw new Error(`${AUTH_DENIED}: 帳號或密碼錯誤，請重新登入。`);
  }
  if (!user[permission]) {
    throw new Error(
      `${AUTH_DENIED}: 帳號 ${user.account} 沒有${PERMISSION_LABEL[permission]}權限。`,
    );
  }
  return user;
}

/** Reading the board. */
export function requireRead(ctx: QueryCtx, credentials: Credentials) {
  return requirePermission(ctx, credentials, "permRead");
}

/** Any edit to the board. */
export function requireWrite(ctx: QueryCtx, credentials: Credentials) {
  return requirePermission(ctx, credentials, "permWrite");
}

/**
 * Reaching for an editing affordance at all — the check in front of every
 * `board:*` mutation.
 *
 * It answers "may this account ask for this change", not "does the change apply
 * now": `permWrite` writes straight through, `permEditRequest` turns the same
 * call into a pending edit request. The caller decides which by looking at the
 * returned user, so the two paths cannot disagree about who is allowed in.
 */
export async function requireEdit(
  ctx: QueryCtx,
  credentials: Credentials,
): Promise<Doc<"users">> {
  const user = await authenticate(ctx, credentials);
  if (!user) {
    throw new Error(`${AUTH_DENIED}: 帳號或密碼錯誤，請重新登入。`);
  }
  if (!user.permWrite && !user.permEditRequest) {
    throw new Error(
      `${AUTH_DENIED}: 帳號 ${user.account} 沒有編輯權限，也不能提議編輯。`,
    );
  }
  return user;
}

/**
 * What a credential pair is currently worth.
 *
 * Deliberately does not throw: it is both the login form's answer and the live
 * subscription the board keeps open, so a credential that stops working has to
 * come back as a value the UI can render — the login screen again, not an
 * exception through the middle of the board.
 *
 * `pending` is the registered-but-unapproved case: the password is right, there
 * is simply nothing to see yet.
 */
export const login = query({
  args: { auth: credentialsValidator },
  returns: v.union(
    v.object({ status: v.literal("invalid") }),
    v.object({ status: v.literal("pending"), account: v.string() }),
    v.object({
      status: v.literal("ok"),
      account: v.string(),
      permWrite: v.boolean(),
      permApproveRegister: v.boolean(),
      permEditRequest: v.boolean(),
      permAgent: v.boolean(),
      permTracker: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const user = await authenticate(ctx, args.auth);
    if (!user) return { status: "invalid" as const };
    if (!user.permRead) {
      return { status: "pending" as const, account: user.account };
    }
    return {
      status: "ok" as const,
      account: user.account,
      permWrite: user.permWrite,
      permApproveRegister: user.permApproveRegister,
      // Optional on the row (accounts predate them); absent is false.
      permEditRequest: user.permEditRequest ?? false,
      // Nothing in the UI reads this — an agent has no UI. It is here so the
      // assistant can check its own credential with one HTTP call.
      permAgent: user.permAgent ?? false,
      // Same idea for the tracker, which checks `permEditRequest: true` +
      // `permTracker: true` + `permWrite: false` before it patrols at all.
      permTracker: user.permTracker ?? false,
    };
  },
});

/**
 * Register an account, with every permission off.
 *
 * That is what makes it a request rather than an account: the credential works,
 * and until somebody with `permApproveRegister` approves it, logging in says
 * "waiting for approval" and shows nothing.
 */
export const register = mutation({
  args: { account: v.string(), tokenHash: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const account = cleanAccount(args.account);
    const tokenHash = cleanTokenHash(args.tokenHash);

    if (await byAccount(ctx, account)) {
      throw new Error(`帳號 ${account} 已經被註冊了，換一個名字或直接登入。`);
    }

    await ctx.db.insert("users", {
      account,
      tokenHash,
      permRead: false,
      permWrite: false,
      permApproveRegister: false,
      permEditRequest: false,
      permAgent: false,
      permTracker: false,
    });
    return null;
  },
});

/** Registrations waiting for a decision, oldest first. */
export const pendingUsers = query({
  args: { auth: credentialsValidator },
  returns: v.array(
    v.object({
      userId: v.id("users"),
      account: v.string(),
      requestedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.auth, "permApproveRegister");

    const users = await ctx.db.query("users").take(500);
    return users
      .filter((user) => !user.permRead)
      .sort((a, b) => a._creationTime - b._creationTime)
      .map((user) => ({
        userId: user._id,
        account: user.account,
        requestedAt: user._creationTime,
      }));
  },
});

/**
 * Let a pending registration in — read-only.
 *
 * Write, approve and propose rights are not grantable from the browser at all;
 * they are a `seedUser` call from a terminal. An approval is therefore never a
 * way to hand out more than the approver meant to.
 */
export const approve = mutation({
  args: { auth: credentialsValidator, userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.auth, "permApproveRegister");

    const user = await ctx.db.get(args.userId);
    if (!user) throw new Error("這筆註冊已經不存在了。");
    if (!user.permRead) await ctx.db.patch(user._id, { permRead: true });
    return null;
  },
});

/**
 * Turn a pending registration down, by deleting it — so the name is free again
 * and whoever asked can register properly.
 *
 * Refuses an account that already has read access: dismissing is for requests,
 * and deleting a working account is not something to do by mis-clicking a bell.
 */
export const dismiss = mutation({
  args: { auth: credentialsValidator, userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.auth, "permApproveRegister");

    const user = await ctx.db.get(args.userId);
    if (!user) return null; // already gone: the outcome asked for
    if (user.permRead) {
      throw new Error(
        `帳號 ${user.account} 已經通過審核了，不能用「拒絕」刪掉它。`,
      );
    }
    await ctx.db.delete(user._id);
    return null;
  },
});

/**
 * Create or overwrite an account, permissions included.
 *
 * Internal, so it runs from a terminal against a chosen deployment and never
 * from a browser. This is how the first administrator gets in, and the only way
 * `permWrite` / `permApproveRegister` / `permEditRequest` / `permAgent` /
 * `permTracker` are ever granted:
 *
 * ```bash
 * npx convex run auth:seedUser '{"account":"someone",
 *   "tokenHash":"<sha256 of kanban:someone:<password>>",
 *   "permRead":true,"permWrite":true,"permApproveRegister":true,
 *   "permEditRequest":false}'
 * # the board assistant's own account: read the board, work the chat, write nothing
 * npx convex run auth:seedUser '{"account":"agent","tokenHash":"<64 hex>",
 *   "permRead":true,"permWrite":false,"permApproveRegister":false,
 *   "permAgent":true}'
 * # the board tracker: proposes, notifies, never writes
 * npx convex run auth:seedUser '{"account":"tracker","tokenHash":"<64 hex>",
 *   "permRead":true,"permWrite":false,"permApproveRegister":false,
 *   "permEditRequest":true,"permTracker":true}'
 * ```
 *
 * `permEditRequest`, `permAgent` and `permTracker` may be left out, which reads
 * as false — so calls written before any of them existed still mean what they
 * meant.
 *
 * The hash has to be computed outside — the same
 * `sha256("kanban:<account>:<password>")` the browser uses — which keeps this
 * function free of any password handling too.
 */
export const seedUser = internalMutation({
  args: {
    account: v.string(),
    tokenHash: v.string(),
    permRead: v.boolean(),
    permWrite: v.boolean(),
    permApproveRegister: v.boolean(),
    permEditRequest: v.optional(v.boolean()),
    permAgent: v.optional(v.boolean()),
    permTracker: v.optional(v.boolean()),
  },
  returns: v.object({ created: v.boolean() }),
  handler: async (ctx, args) => {
    const account = cleanAccount(args.account);
    const fields = {
      tokenHash: cleanTokenHash(args.tokenHash),
      permRead: args.permRead,
      permWrite: args.permWrite,
      permApproveRegister: args.permApproveRegister,
      permEditRequest: args.permEditRequest ?? false,
      permAgent: args.permAgent ?? false,
      permTracker: args.permTracker ?? false,
    };

    const existing = await byAccount(ctx, account);
    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return { created: false };
    }
    await ctx.db.insert("users", { account, ...fields });
    return { created: true };
  },
});

/**
 * Delete an account. Internal: this is the revocation path.
 *
 * Their pending edit requests go too. A request is a live proposal, not a record
 * of what happened, so an account that no longer exists should not leave
 * something for a reviewer to approve in its name.
 *
 * So does their assistant conversation, and so do their notifications. Both are
 * addressed by account *name*, so leaving them behind would hand them to whoever
 * registers that name next.
 */
export const deleteUser = internalMutation({
  args: { account: v.string() },
  returns: v.object({
    deleted: v.boolean(),
    editRequestsDeleted: v.number(),
    messagesDeleted: v.number(),
    notificationsDeleted: v.number(),
  }),
  handler: async (ctx, args) => {
    const account = cleanAccount(args.account);
    const user = await byAccount(ctx, account);
    if (!user) {
      return {
        deleted: false,
        editRequestsDeleted: 0,
        messagesDeleted: 0,
        notificationsDeleted: 0,
      };
    }

    const requests = await ctx.db
      .query("editRequests")
      .withIndex("by_requester", (q) => q.eq("requestedBy", user._id))
      .collect();
    for (const request of requests) await ctx.db.delete(request._id);

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_account", (q) => q.eq("account", account))
      .collect();
    for (const message of messages) await ctx.db.delete(message._id);

    const notifications = await ctx.db
      .query("notifications")
      .withIndex("by_account", (q) => q.eq("account", account))
      .collect();
    for (const notification of notifications) await ctx.db.delete(notification._id);

    await ctx.db.delete(user._id);
    return {
      deleted: true,
      editRequestsDeleted: requests.length,
      messagesDeleted: messages.length,
      notificationsDeleted: notifications.length,
    };
  },
});

/** Who has access, for checking what a seed actually did. Hashes stay out. */
export const listUsers = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      account: v.string(),
      permRead: v.boolean(),
      permWrite: v.boolean(),
      permApproveRegister: v.boolean(),
      permEditRequest: v.boolean(),
      permAgent: v.boolean(),
      permTracker: v.boolean(),
    }),
  ),
  handler: async (ctx) => {
    const users = await ctx.db.query("users").take(500);
    return users
      .sort((a, b) => a.account.localeCompare(b.account))
      .map((user) => ({
        account: user.account,
        permRead: user.permRead,
        permWrite: user.permWrite,
        permApproveRegister: user.permApproveRegister,
        permEditRequest: user.permEditRequest ?? false,
        permAgent: user.permAgent ?? false,
        permTracker: user.permTracker ?? false,
      }));
  },
});
