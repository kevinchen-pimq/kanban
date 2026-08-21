#!/usr/bin/env node
// One Convex call as the board assistant, over plain HTTP.
//
//   node agent-call.mjs query    messages:agentInbox
//   node agent-call.mjs query    messages:agentRead   '{"account":"someone"}'
//   node agent-call.mjs mutation messages:agentReply  '{"account":"someone","text":"…"}'
//
// Reads KANBAN_URL, KANBAN_AGENT_ACCOUNT and KANBAN_AGENT_TOKEN_HASH from the
// environment and injects them as the `auth` argument every public function
// wants — the assistant has no Convex credentials and needs none.
//
// Prints the `value` of a successful answer and exits 0; prints the error and
// exits 1 otherwise, because Convex answers a rejected call with HTTP 200 and a
// silent `{"status":"error"}` would otherwise read like an empty result.

const [kind, path, rawArgs = "{}"] = process.argv.slice(2);

const url = process.env.KANBAN_URL;
const account = process.env.KANBAN_AGENT_ACCOUNT;
const tokenHash = process.env.KANBAN_AGENT_TOKEN_HASH;

function die(message) {
  console.error(message);
  process.exit(1);
}

if (kind !== "query" && kind !== "mutation" || !path) {
  die("usage: agent-call.mjs <query|mutation> <module:function> [jsonArgs]");
}
if (!url) die("KANBAN_URL is unset (e.g. https://laudable-buffalo-595.convex.cloud).");
if (!account || !tokenHash) {
  die("KANBAN_AGENT_ACCOUNT / KANBAN_AGENT_TOKEN_HASH are unset — ask the user for the assistant credential.");
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
