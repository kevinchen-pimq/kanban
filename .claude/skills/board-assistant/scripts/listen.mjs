#!/usr/bin/env node
// Block until the board assistant has something to do, then exit.
//
//   node listen.mjs                          # anything, from anybody
//   node listen.mjs --account kevinchen      # only that conversation
//   node listen.mjs --exclude kevinchen      # anything except that conversation
//   node listen.mjs --timeout 600            # give up after 10 minutes
//   node listen.mjs --escalate kevinchen,ana --grace 5   # watchdog, claims nothing
//
// Two modes, and the difference is whether this process *takes* the work.
//
// The default (claiming) mode subscribes to `messages:agentWatch` over a
// WebSocket — Convex pushes, nothing here polls — and on the first event it:
//   1. claims it with `messages:agentMarkRead`, which both stamps the 「已讀」 the
//      person sees in the chat window and hands this process ownership of the
//      event (a row can only be claimed once, so two listeners never answer the
//      same sentence);
//   2. prints one JSON object to stdout;
//   3. exits.
//
// "Exit on the first event" is the whole point: run it as a background task and
// the process ending *is* the notification. No sleep loop, no missed message.
//
//   { "events": [ { "type": "userMessage",   "account": "…", "messageId": "…",
//                   "at": 1771000000000, "text": "…" },
//                 { "type": "commandResult", "account": "…", "messageId": "…",
//                   "at": …, "text": "<the description>", "status": "failed",
//                   "result": "…", "command": { … } } ],
//     "waitedSeconds": 3.1 }
//
// Every event in that array is claimed, i.e. yours to answer.
//
// `--escalate` is the other mode: a watchdog over conversations that belong to
// *somebody else* (the sub-agents a main agent has handed them to, which are
// therefore in `--exclude` on the main listener). It marks nothing read and
// claims nothing — it only notices when nobody else does. A new `userMessage` in
// one of those threads starts a grace period (`--grace`, 5 seconds by default);
// when it expires the thread is re-read: a `readAt` means the sub-agent picked
// the message up and the wait continues, no `readAt` means nobody is listening,
// so it prints one event and exits:
//
//   { "events": [ { "type": "escalation", "account": "…", "messageId": "…",
//                   "at": 1771000000000, "text": "…",
//                   "graceSeconds": 5, "unreadSeconds": 5.2 } ],
//     "waitedSeconds": 71.4 }
//
// Exit codes, both modes: 0 = events, 3 = timed out
// (`{"events":[],"timedOut":true,…}`), 1 = misconfigured, unreachable or refused.
//
// Credentials come from KANBAN_URL, KANBAN_AGENT_ACCOUNT and
// KANBAN_AGENT_TOKEN_HASH, exactly like agent-call.mjs — never from a file.

import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

const WATCH = makeFunctionReference("messages:agentWatch");
const MARK_READ = makeFunctionReference("messages:agentMarkRead");
const READ = makeFunctionReference("messages:agentRead");

/** How long an escalated thread may keep a message unread, by default. */
const DEFAULT_GRACE_SECONDS = 5;

function die(message) {
  console.error(message);
  process.exit(1);
}

// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const usage =
  "usage: listen.mjs [--account <name>] [--exclude <name>]… [--timeout <seconds>]\n" +
  "       listen.mjs --escalate <name>[,<name>…] [--grace <seconds>] [--timeout <seconds>]";
let account;
const excluded = new Set();
const escalated = new Set();
let graceSeconds = DEFAULT_GRACE_SECONDS;
let timeoutSeconds = 0; // 0 = wait indefinitely

/** Accepts `a`, `a,b` and repeated flags alike — all three read naturally. */
function accountList(raw, flag) {
  const names = (raw ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) die(`${flag} needs at least one account name.`);
  return names;
}

for (let i = 0; i < argv.length; i++) {
  const flag = argv[i];
  if (flag === "--account") {
    account = argv[++i];
    if (!account) die("--account needs an account name.");
  } else if (flag === "--exclude") {
    for (const name of accountList(argv[++i], flag)) excluded.add(name);
  } else if (flag === "--escalate") {
    for (const name of accountList(argv[++i], flag)) escalated.add(name);
  } else if (flag === "--grace") {
    graceSeconds = Number(argv[++i]);
    if (!Number.isFinite(graceSeconds) || graceSeconds <= 0) {
      die("--grace needs a positive number of seconds.");
    }
  } else if (flag === "--timeout") {
    timeoutSeconds = Number(argv[++i]);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
      die("--timeout needs a number of seconds.");
    }
  } else {
    die(`unknown argument: ${flag}\n${usage}`);
  }
}

// One process, one job: a watchdog that also claimed events would be exactly the
// second listener the escalation design exists to avoid.
if (escalated.size > 0 && (account || excluded.size > 0)) {
  die(`--escalate cannot be combined with --account or --exclude.\n${usage}`);
}

const url = process.env.KANBAN_URL;
const agentAccount = process.env.KANBAN_AGENT_ACCOUNT;
const tokenHash = process.env.KANBAN_AGENT_TOKEN_HASH;

if (!url) die("KANBAN_URL is unset (e.g. https://laudable-buffalo-595.convex.cloud).");
if (!agentAccount || !tokenHash) {
  die("KANBAN_AGENT_ACCOUNT / KANBAN_AGENT_TOKEN_HASH are unset — ask the user for the assistant credential.");
}

const auth = { account: agentAccount, tokenHash };
const watchArgs = { auth, ...(account ? { account } : {}) };

// ---------------------------------------------------------------------------

const startedAt = Date.now();
const client = new ConvexClient(url.replace(/\/$/, ""), {
  unsavedChangesWarning: false,
});

/** Print one JSON object, close the socket and stop. */
async function finish(payload, code) {
  const waitedSeconds = Math.round((Date.now() - startedAt) / 100) / 10;
  console.log(JSON.stringify({ ...payload, waitedSeconds }, null, 2));
  await client.close().catch(() => undefined);
  process.exit(code);
}

/** Nothing more will be printed once one of the endings has been chosen. */
let settled = false;
/** True while a claim is in flight, so one update is acted on at a time. */
let claiming = false;

if (timeoutSeconds > 0) {
  setTimeout(() => {
    if (settled) return;
    settled = true;
    void finish({ events: [], timedOut: true }, 3);
  }, timeoutSeconds * 1000).unref();
}

/** A refused subscription (bad credential, missing `permAgent`) must not look
 * like a quiet night. */
function watchFailed(error) {
  if (settled) return;
  settled = true;
  console.error(
    `messages:agentWatch: ${error instanceof Error ? error.message : String(error)}`,
  );
  void client.close().finally(() => process.exit(1));
}

// ---------------------------------------------------------------------------
// Escalation mode — watch, do not touch
// ---------------------------------------------------------------------------

/**
 * Keep an eye on conversations somebody else owns.
 *
 * Handing a conversation to a sub-agent means excluding it from the main
 * listener, and an exclusion with nothing behind it is how a dead sub-agent
 * becomes a person waiting for ever. So: notice every new `userMessage` in those
 * threads, give the sub-agent `graceSeconds` to stamp it read, then look again.
 * Read means somebody is on it. Still unread means nobody is, and the main agent
 * needs to know — that is the one event this mode prints.
 *
 * It deliberately neither claims nor marks anything: whatever it reported must
 * still be there, unread, for whoever takes over.
 */
function watchEscalation() {
  /** messageId → timer, one per message whose grace period is running. */
  const watching = new Map();

  /** The verdict, taken from the server rather than from the local snapshot. */
  async function verdict(row) {
    watching.delete(row.messageId);
    if (settled) return;

    let thread;
    try {
      thread = await client.query(READ, { auth, account: row.account });
    } catch (error) {
      if (settled) return;
      settled = true;
      console.error(
        `messages:agentRead: ${error instanceof Error ? error.message : String(error)}`,
      );
      await client.close().catch(() => undefined);
      process.exit(1);
    }

    const message = thread.find((row_) => row_.messageId === row.messageId);
    // Read (a sub-agent is alive), handled, or gone from the thread entirely —
    // all three mean this message is not orphaned. Keep waiting for the next one.
    if (!message || message.readAt !== undefined || message.handled) return;
    if (settled) return;

    settled = true;
    await finish(
      {
        events: [
          {
            type: "escalation",
            messageId: row.messageId,
            account: row.account,
            at: row.at,
            text: row.text,
            graceSeconds,
            unreadSeconds: Math.round((Date.now() - row.at) / 100) / 10,
          },
        ],
      },
      0,
    );
  }

  client.onUpdate(
    WATCH,
    { auth },
    (rows) => {
      if (settled || !rows) return;
      for (const row of rows) {
        if (row.type !== "userMessage") continue;
        if (!escalated.has(row.account)) continue;
        if (watching.has(row.messageId)) continue;
        // A message that has been sitting unread for longer than the grace period
        // already (a backlog at startup) still gets one grace window: the check is
        // "did anybody pick it up", not "how old is it".
        watching.set(
          row.messageId,
          setTimeout(() => void verdict(row), graceSeconds * 1000),
        );
      }
    },
    watchFailed,
  );
}

// ---------------------------------------------------------------------------
// Claiming mode — the ordinary listener
// ---------------------------------------------------------------------------

function watchAndClaim() {
  client.onUpdate(
    WATCH,
    watchArgs,
    (rows) => {
      // The first answer is a snapshot, so a backlog that was already waiting
      // wakes us at once: what makes a row stop being an event is being read, not
      // when it arrived.
      if (settled || claiming || !rows) return;
      const candidates = rows.filter((row) => !excluded.has(row.account));
      if (candidates.length === 0) return;

      claiming = true;
      void (async () => {
        let marked;
        try {
          ({ marked } = await client.mutation(MARK_READ, {
            auth,
            messageIds: candidates.map((row) => row.messageId),
          }));
        } catch (error) {
          // Could not claim, so cannot honestly report: say why and leave the rows
          // unread for the next listener.
          settled = true;
          console.error(
            `messages:agentMarkRead: ${error instanceof Error ? error.message : String(error)}`,
          );
          await client.close().catch(() => undefined);
          process.exit(1);
        }

        const claimed = new Set(marked);
        const events = candidates.filter((row) => claimed.has(row.messageId));
        if (events.length === 0) {
          // Another listener got there first. Keep waiting; the feed changed, so a
          // further update is on its way if anything is left.
          claiming = false;
          return;
        }
        settled = true;
        await finish({ events }, 0);
      })();
    },
    watchFailed,
  );
}

if (escalated.size > 0) watchEscalation();
else watchAndClaim();
