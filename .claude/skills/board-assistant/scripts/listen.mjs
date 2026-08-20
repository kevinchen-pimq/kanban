#!/usr/bin/env node
// Block until the board assistant has something to do, then exit.
//
//   node listen.mjs                          # anything, from anybody
//   node listen.mjs --account kevinchen      # only that conversation
//   node listen.mjs --exclude kevinchen      # anything except that conversation
//   node listen.mjs --timeout 600            # give up after 10 minutes
//
// Subscribes to `messages:agentWatch` over a WebSocket — Convex pushes, nothing
// here polls — and on the first event it:
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
// Every event in that array is claimed, i.e. yours to answer. Exit codes:
// 0 = events, 3 = timed out (`{"events":[],"timedOut":true,…}`),
// 1 = misconfigured, unreachable or refused.
//
// Credentials come from KANBAN_URL, KANBAN_AGENT_ACCOUNT and
// KANBAN_AGENT_TOKEN_HASH, exactly like agent-call.mjs — never from a file.

import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

const WATCH = makeFunctionReference("messages:agentWatch");
const MARK_READ = makeFunctionReference("messages:agentMarkRead");

function die(message) {
  console.error(message);
  process.exit(1);
}

// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const usage =
  "usage: listen.mjs [--account <name>] [--exclude <name>]… [--timeout <seconds>]";
let account;
const excluded = new Set();
let timeoutSeconds = 0; // 0 = wait indefinitely

for (let i = 0; i < argv.length; i++) {
  const flag = argv[i];
  if (flag === "--account") {
    account = argv[++i];
    if (!account) die("--account needs an account name.");
  } else if (flag === "--exclude") {
    const name = argv[++i];
    if (!name) die("--exclude needs an account name.");
    excluded.add(name);
  } else if (flag === "--timeout") {
    timeoutSeconds = Number(argv[++i]);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
      die("--timeout needs a number of seconds.");
    }
  } else {
    die(`unknown argument: ${flag}\n${usage}`);
  }
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

client.onUpdate(
  WATCH,
  watchArgs,
  (rows) => {
    // The first answer is a snapshot, so a backlog that was already waiting wakes
    // us at once: what makes a row stop being an event is being read, not when it
    // arrived.
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
  (error) => {
    // A refused subscription (bad credential, missing `permAgent`) must not look
    // like a quiet night.
    if (settled) return;
    settled = true;
    console.error(
      `messages:agentWatch: ${error instanceof Error ? error.message : String(error)}`,
    );
    void client.close().finally(() => process.exit(1));
  },
);
