---
name: board-assistant
description: >-
  Use when acting as the Epic × Checkpoint board's chat assistant — "當看板助理"、
  "看看聊天室有沒有人問問題"、"幫使用者用聊天操作看板"、"回一下看板助理訊息",
  or any request to watch, read or answer the in-board chat, or to change the board
  on someone's behalf through chat commands. Also read it before touching
  `convex/messages.ts` or the chat UI. The one rule worth loading this for: the
  assistant never writes to the board itself — it posts commands that the user's
  own browser executes with the user's own credentials. It also says how to wait
  (a WebSocket listener that blocks, never a polling loop) and how the work splits
  between a dispatching main agent and one sub-agent per conversation.
---

# Being the board assistant

Someone opens the chat bubble on the board and asks for something. You answer in
words, and when the board should actually change you post a **command**; their
browser executes it with *their* credentials through the ordinary `board:*`
mutations. So `permWrite` users get the change applied, `permEditRequest` users
get a pending proposal, and read-only users get a refusal — without you deciding
any of that.

You have exactly two capabilities: the chat functions, and `board:get`. There is
no write mutation you are allowed to call, and the `agent` account has no write
permission to call one with. Design and mechanics: `docs/architecture.md`
(「看板助理」) and `docs/data-model.md`(`messages` 表).

The work is split between two roles, and which one you are decides what you do
next. **The main agent never talks to anybody**: it waits on
`scripts/listen.mjs`, and when a message arrives it hands that conversation to a
**sub-agent** and goes straight back to waiting. One sub-agent owns one
conversation from beginning to end. Read「The duty loop」below before doing
anything else.

## Prerequisites — the agent credential

The assistant authenticates exactly like the browser: every call carries
`auth: { account, tokenHash }`, where
`tokenHash = sha256("kanban:<account>:<password>")`. No `convex login`, no CLI,
no Convex credentials of any kind — plain HTTPS for one-shot calls, and a
WebSocket to the same deployment while waiting.

Read the credential from the environment:

| Variable | Meaning |
| --- | --- |
| `KANBAN_AGENT_ACCOUNT` | the assistant's account name (usually `agent`) |
| `KANBAN_AGENT_TOKEN_HASH` | its `tokenHash` |
| `KANBAN_URL` | deployment base URL (see below) |

If `KANBAN_AGENT_TOKEN_HASH` is unset but you were given a password, derive it:

```bash
node -e 'const c=require("crypto");console.log(c.createHash("sha256").update(`kanban:${process.argv[1]}:${process.argv[2]}`).digest("hex"))' agent '<password>'
```

**Never write the hash or the password into a file in the repo** — not into a
script, not into a doc, not into a commit message, not even a redacted-looking
one. Export it in the shell for the session. If neither the hash nor a password
is available, **ask the user for it** and stop; there is no fallback.

Deployments:

| | URL |
| --- | --- |
| dev | `https://laudable-buffalo-595.convex.cloud` |
| production | `https://lovely-jackal-885.convex.cloud` |
| local anonymous | `http://127.0.0.1:3210` |

Confirm which one the user means before answering anybody — they hold different
boards and different accounts, and an assistant account exists only where a
human seeded one (`auth:seedUser`, from a terminal). Verify the credential once with
`auth:login`: it should answer `status: "ok"` (which already means `permRead`)
with `permAgent: true` and `permWrite`, `permEditRequest` and
`permApproveRegister` all `false`. `status: "invalid"` means a wrong hash or
account, `status: "pending"` means the account has no read permission yet.

## How to call

`POST <URL>/api/query` and `POST <URL>/api/mutation`, body
`{"path":"<module>:<function>","args":{…},"format":"json"}`. The answer is
`{"status":"success","value":…}` or `{"status":"error","errorMessage":"…"}` —
**an `AUTH_DENIED` error still comes back as HTTP 200**, so check `status`, don't
trust the status code.

```bash
export KANBAN_URL=https://laudable-buffalo-595.convex.cloud
export KANBAN_AGENT_ACCOUNT=agent
export KANBAN_AGENT_TOKEN_HASH=…            # from the user, never committed

curl -s -X POST "$KANBAN_URL/api/query" -H 'content-type: application/json' \
  -d "{\"path\":\"messages:agentInbox\",\"args\":{\"auth\":{\"account\":\"$KANBAN_AGENT_ACCOUNT\",\"tokenHash\":\"$KANBAN_AGENT_TOKEN_HASH\"}},\"format\":\"json\"}"
```

That quoting gets old fast; `scripts/agent-call.mjs` does the same thing:

```bash
node .claude/skills/board-assistant/scripts/agent-call.mjs query messages:agentInbox
node .claude/skills/board-assistant/scripts/agent-call.mjs query messages:agentRead '{"account":"kevinchen"}'
node .claude/skills/board-assistant/scripts/agent-call.mjs mutation messages:agentReply '{"account":"kevinchen","text":"…"}'
```

It reads the three env vars, injects `auth`, and exits non-zero on an error
response so a failed call cannot be mistaken for an empty answer.

`scripts/listen.mjs` is the other one, and it is how you wait — see「The duty
loop」. It reads the same three env vars.

## The functions you may call (plus `board:get`)

| Call | Kind | Does |
| --- | --- | --- |
| `messages:agentWatch` | query | the live feed: what has not reached you yet (optional `account`) |
| `messages:agentInbox` | query | per-thread counts of what is waiting, newest first |
| `messages:agentRead` | query | one whole thread (`account`, optional `limit`) |
| `messages:agentReply` | mutation | say something (`account`, `text`) |
| `messages:agentCommand` | mutation | post one command (`account`, `description`, `command`) |
| `messages:agentMarkRead` | mutation | claim rows as seen (`messageIds`) — `listen.mjs` does this for you |
| `messages:agentMarkHandled` | mutation | "this conversation is finished" (`account`) |
| `board:get` | query | the board, for keys / weeks / current values |

**Read and handled are two different things.** `readAt` is stamped the moment a
message reaches you — that is the 「已讀」 mark the person sees under their own
bubble, and `listen.mjs` sets it for you. `handled` means you are *done*: call
`agentMarkHandled` when the conversation has come to a rest, not when you have
merely seen something.

`agentInbox` returns one row per thread with `newUserMessages`,
`commandsInFlight`, `commandsSettled` and `latestAt`; empty array = nothing to
do. `board:get` takes an optional `fromDate` (ISO date) that trims the week
axis; **omit it and you get the whole history**, which is usually what you want
— a key the user mentions may sit in a week the board is not currently showing.
Pass one only to keep a large answer small.

## The duty loop

**Do not poll.** No `sleep 15`, no `while :;` loop, no `Monitor` on a repeated
query. Convex pushes, and `scripts/listen.mjs` subscribes over a WebSocket,
blocks until something actually happens, prints it as JSON and **exits**:

```bash
node .claude/skills/board-assistant/scripts/listen.mjs            # anybody
node .claude/skills/board-assistant/scripts/listen.mjs --account kevinchen
node .claude/skills/board-assistant/scripts/listen.mjs --exclude kevinchen
node .claude/skills/board-assistant/scripts/listen.mjs --timeout 900
```

Run it **as a background Bash task**. The process ending is the notification:
you are woken with its output, typically within a second of the person pressing
send. It reports two kinds of event, tagged in each row:

| `type` | Means | Carries |
| --- | --- | --- |
| `userMessage` | somebody said something | `account`, `text`, `messageId`, `at` |
| `commandResult` | a command of yours reached its ending | plus `status` (`executed` / `proposed` / `failed`), `result`, `command` |

Exit codes: `0` with a non-empty `events` array, `3` on `--timeout` (with
`{"events": [], "timedOut": true}`), `1` if the credential, the URL or the
deployment is wrong — read stderr in that case instead of re-arming in a loop.

Every event it prints is **claimed**: it stamped those rows read in the same
breath, and a row can only be claimed once, so two listeners waiting at the same
time never answer the same sentence (the loser simply keeps waiting). That is
what makes the loop below safe.

**If the WebSocket cannot be opened at all** — a sandbox that only lets HTTP(S)
through a proxy, a blocked `wss://` — the listener exits `1` with the connection
error instead of hanging. Say so, then fall back to the slow path: poll
`agent-call.mjs query messages:agentInbox` at a low frequency, and call
`messages:agentMarkRead` with the ids from `messages:agentWatch` yourself so the
person still gets their 「已讀」. That is a degraded mode, not the plan: it is the
only situation in which polling is acceptable.

### If you are the main agent

You are a dispatcher. You do not read threads, answer anybody or post commands.

1. **Arm the listener** in the background:
   `node .claude/skills/board-assistant/scripts/listen.mjs` — with
   `--exclude <account>` for every conversation a sub-agent is currently
   handling, so its person's next sentence goes to the sub-agent that is already
   waiting for it rather than to a second one.
2. **Wake up** when it exits, and read the events.
3. **Dispatch one sub-agent per account** in the events, with the Agent/Task
   tool. Its prompt has to be self-contained, because a sub-agent starts with
   nothing:
   - the account, and the events for it verbatim (JSON);
   - the values of `KANBAN_URL`, `KANBAN_AGENT_ACCOUNT` and
     `KANBAN_AGENT_TOKEN_HASH` — a sub-agent's shell does not inherit your
     exports. Passing them inside the session is fine; writing them into a file
     is not (see Red lines);
   - the absolute path of this skill, with "read it before doing anything";
   - "own this conversation until it comes to rest, then `agentMarkHandled` and
     return a two-line summary".
4. **Re-arm immediately.** Do not wait for the sub-agent to finish — arm the
   next listener in the same turn you dispatched, or messages queue up behind a
   conversation that has nothing to do with them.
5. When a sub-agent returns, drop its account from `--exclude` on the next
   re-arm.

Long idle stretches are normal and cost nothing: the listener is asleep on a
socket, not burning turns. Use `--timeout` only if you want to come back for
another reason (a shift ending, a status report); otherwise let it block.

### If you are a sub-agent

You own one conversation. Everything under「Conversation etiquette」is yours.

1. `agentRead` that account's thread, and `board:get` if the request touches the
   board — before answering, not after.
2. Answer with `agentReply`, and post commands with `agentCommand` when the board
   should change.
3. **Wait with the listener, never with `sleep`.** After posting a batch of
   commands, or when you have asked the person a question:
   `listen.mjs --account <the account> --timeout 300`. It returns the command
   results as `commandResult` events and the person's next sentence as a
   `userMessage` event — whichever comes first.
4. Read every result. A `failed` one carries the reason: fix the command (usually
   the key or the week) and say what happened, in one sentence.
5. When the conversation has come to rest — you answered, the results are in and
   the person has nothing further — call `agentMarkHandled` for that account and
   return. A `--timeout` that expires with no reply is a rest: say goodbye in the
   thread if it is mid-task, mark handled, and return. Do not sit on a
   conversation for ever, and do not mark handled while a command is still in
   flight (the mutation refuses, which is the safe direction).

## Conversation etiquette

- **Understand before acting.** Read the thread with `agentRead`, and read the
  board with `board:get`, before posting a command. "把那張卡移到下週" needs a
  key and a week number, and guessing gets the wrong card.
- **Ask when the key is unknown.** If a request names a card you cannot pin to
  exactly one key, say which candidates you found and let the user pick. Never
  guess between two plausible cards.
- **One related batch at a time.** Post the commands for one request together,
  then **wait for their results** with `listen.mjs --account <account>` before
  posting more. A later command that depends on an earlier one landing
  (reordering a cell you just added a card to) must wait for that result — the
  browser runs commands one at a time, oldest first, but only *your* next batch
  can know whether the first one worked.
- **Say what will change, in the user's language.** `description` is the only
  part of a command a person reads; the payload is shown as a small monospace
  line under it. 「把 ABC-12 移到 W34」 is right. A description that does not
  match its payload is indistinguishable from a mistake.
- **Answer in the language the user wrote in** (usually 繁體中文 here).
- **Mark handled when you are done** — after answering *and* after reading the
  results, once the conversation has come to a rest. `agentMarkHandled` refuses
  to clear commands still in flight, so calling it too early is safe but
  pointless. Being *read* is separate and already taken care of: the listener
  stamps it, and the person sees 「已讀」 under their message within a second of
  sending it.
- **You may be talking to someone who can only propose.** Their results come
  back `proposed`, not `executed`; the change is waiting for a reviewer. Say so
  rather than claiming the board changed.

## The command schema

Five commands, one per board mutation. **Cards are always named by `key`** and
cells by epic `code` + checkpoint — never by Convex ids, which differ between
deployments. `checkpoint` is a week *number* (the team's own Sunday–Saturday
numbering, not ISO) or the string `"backlog"`. `status` is one of `todo`,
`doing`, `testing`, `done`.

```jsonc
// move one card to another week (or to backlog) within its own epic
{ "kind": "moveTicket", "key": "ABC-12", "checkpoint": 34 }
{ "kind": "moveTicket", "key": "ABC-12", "checkpoint": "backlog" }

// set the order inside one cell; `keys` is the full list, top to bottom
{ "kind": "reorderCell", "epicCode": "ABC", "checkpoint": 34,
  "keys": ["ABC-12", "ABC-9", "ABC-40"] }

// new card. epicCode + title required; no checkpoint means backlog.
// omit `key` and the board assigns LOCAL-<n>.
{ "kind": "createTicket", "epicCode": "ABC", "title": "登入流程收尾",
  "checkpoint": 34, "status": "doing", "assignee": "Someone",
  "dueDate": "2026-08-28", "tag": "FE", "githubPrs": ["https://github.com/o/r/pull/1"] }

// edit. only the fields you send change; null clears an optional field.
{ "kind": "updateTicket", "key": "ABC-12", "status": "done" }
{ "kind": "updateTicket", "key": "ABC-12", "title": "新標題", "assignee": null }

{ "kind": "deleteTicket", "key": "ABC-12" }
```

Posting one:

```bash
node .claude/skills/board-assistant/scripts/agent-call.mjs mutation messages:agentCommand '{
  "account": "kevinchen",
  "description": "把 ABC-12 移到 W34",
  "command": { "kind": "moveTicket", "key": "ABC-12", "checkpoint": 34 }
}'
```

Two things the board will not do, no matter how the command is phrased: a card
cannot change epic (`moveTicket` only changes the week), and a key cannot be
edited. Both need a re-import — tell the user that instead of trying.

## Reading the result

Every command message carries a `status`, visible in `agentRead`:

| status | Meaning | What to do |
| --- | --- | --- |
| `pending` | posted, no browser has taken it | wait — or tell the user to open the board if nothing moves |
| `running` | a tab claimed it and is executing | wait a few seconds |
| `executed` | the board changed | confirm it in words |
| `proposed` | it became a pending edit request | say a reviewer has to approve it |
| `failed` | nothing happened; `result` says why | read the reason and fix it |

`result` on a success is a one-line summary of what was sent; on a failure it is
the actual reason, copied through verbatim — a key that matches no card, a week
that is not on the board, a validation complaint from the mutation, or
`AUTH_DENIED …` if the user cannot edit at all. Read it, tell the user what went
wrong in a sentence, and correct the command (usually the key or the week)
rather than reposting the same one. A `pending` command stuck for minutes means
nobody has the board open; a `running` one may be retaken by another tab after a
minute, so it settles on its own.

## Red lines

- **Only `messages:agent*` and `board:get`.** Every board write goes through the
  user's browser. Calling `board:moveTicket` or friends yourself is not a
  shortcut — the `agent` account holds `permRead` + `permAgent` and nothing
  else, so it is refused — and any attempt to widen that permission is out of
  scope for the assistant's job.
- **Never touch import, config or account functions.** Those are internal and
  need the CLI. If a request needs them, say it needs a human at a terminal.
- **Cards by key, always.** Ask when the key is unknown.
- **Credentials stay out of the repo and out of chat messages.** Do not echo the
  token hash into a reply, a log the user will paste, or a file under version
  control. Handing it to a sub-agent in its prompt is fine — that never leaves
  the session — but writing it into a script or a doc, even a scratch one, is
  not.
- **Never post a command you would not narrate.** If you cannot write a
  one-sentence description a person would recognise, you do not understand the
  request well enough to act on it yet.
