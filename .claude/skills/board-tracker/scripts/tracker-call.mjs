#!/usr/bin/env node
// One Convex call as the board tracker, over plain HTTP.
//
//   node tracker-call.mjs query    auth:login
//   node tracker-call.mjs query    board:get
//   node tracker-call.mjs mutation notifications:trackerSend \
//     '{"account":"someone","kind":"progress","text":"…","keys":["ABC-12"]}'
//
// Reads KANBAN_URL, KANBAN_TRACKER_ACCOUNT and KANBAN_TRACKER_TOKEN_HASH from the
// environment and injects them as the `auth` argument every public function wants
// — the tracker has no Convex credentials and needs none. A patrol has nothing to
// wait for, so there is no listener alongside this: one-shot calls only.
//
// Prints the `value` of a successful answer and exits 0; prints the error and
// exits 1 otherwise, because Convex answers a rejected call with HTTP 200 and a
// silent `{"status":"error"}` would otherwise read like an empty result.

const [kind, path, rawArgs = "{}"] = process.argv.slice(2);

const url = process.env.KANBAN_URL;
const account = process.env.KANBAN_TRACKER_ACCOUNT;
const tokenHash = process.env.KANBAN_TRACKER_TOKEN_HASH;

function die(message) {
  console.error(message);
  process.exit(1);
}

if ((kind !== "query" && kind !== "mutation") || !path) {
  die("usage: tracker-call.mjs <query|mutation> <module:function> [jsonArgs]");
}
if (!url) die("KANBAN_URL is unset (e.g. https://laudable-buffalo-595.convex.cloud).");
if (!account || !tokenHash) {
  die("KANBAN_TRACKER_ACCOUNT / KANBAN_TRACKER_TOKEN_HASH are unset — ask the user for the tracker credential.");
}

let args;
try {
  args = JSON.parse(rawArgs);
} catch (error) {
  die(`arguments are not JSON: ${error.message}`);
}

const response = await fetch(`${url.replace(/\/$/, "")}/api/${kind}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    path,
    args: { auth: { account, tokenHash }, ...args },
    format: "json",
  }),
});

const answer = await response.json().catch(() => null);
if (!answer) die(`${path}: unreadable answer (HTTP ${response.status})`);
if (answer.status !== "success") {
  die(`${path}: ${answer.errorMessage ?? JSON.stringify(answer.errorData ?? answer)}`);
}

console.log(JSON.stringify(answer.value, null, 2));
