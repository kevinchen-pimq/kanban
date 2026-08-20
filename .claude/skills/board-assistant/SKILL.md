---
name: board-assistant
description: >-
  Use when acting as the Epic × Checkpoint board's chat assistant — "當看板助理"、
  "看看聊天室有沒有人問問題"、"幫使用者用聊天操作看板"、"回一下看板助理訊息",
  or any request to poll, read or answer the in-board chat, or to change the board
  on someone's behalf through chat commands. Also read it before touching
  `convex/messages.ts` or the chat UI. The one rule worth loading this for: the
  assistant never writes to the board itself — it posts commands that the user's
  own browser executes with the user's own credentials.
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

## Prerequisites — the agent credential

The assistant authenticates exactly like the browser: every call carries
`auth: { account, tokenHash }`, where
`tokenHash = sha256("kanban:<account>:<password>")`. No `convex login`, no CLI,
no Convex credentials of any kind — plain HTTPS against the deployment.

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

## The five functions you may call (plus `board:get`)

| Call | Kind | Does |
| --- | --- | --- |
| `messages:agentInbox` | query | every thread with something waiting, newest first |
| `messages:agentRead` | query | one whole thread (`account`, optional `limit`) |
| `messages:agentReply` | mutation | say something (`account`, `text`) |
| `messages:agentCommand` | mutation | post one command (`account`, `description`, `command`) |
| `messages:agentMarkHandled` | mutation | "I have read all of this" (`account`) |
| `board:get` | query | the board, for keys / weeks / current values |

`agentInbox` returns one row per thread with `newUserMessages`,
`commandsInFlight`, `commandsSettled` and `latestAt`. Empty array = nothing to
do. `board:get` takes an optional `fromDate` (ISO date) that trims the week
axis; **omit it and you get the whole history**, which is usually what you want
— a key the user mentions may sit in a week the board is not currently showing.
Pass one only to keep a large answer small.

## Polling

Poll `agentInbox` every ~15 seconds while you are on duty. Nothing arrives by
itself — no webhook, no push — so either loop in the background and check the
log, or use `Monitor` to wait for a non-empty answer:

```bash
while :; do
  node .claude/skills/board-assistant/scripts/agent-call.mjs query messages:agentInbox
  sleep 15
done
```

Long idle stretches are normal. `Monitor` on that loop's output, waiting for a
line other than `[]`, costs nothing while nobody is talking.

## Conversation etiquette

- **Understand before acting.** Read the thread with `agentRead`, and read the
  board with `board:get`, before posting a command. "把那張卡移到下週" needs a
  key and a week number, and guessing gets the wrong card.
- **Ask when the key is unknown.** If a request names a card you cannot pin to
  exactly one key, say which candidates you found and let the user pick. Never
  guess between two plausible cards.
- **One related batch at a time.** Post the commands for one request together,
  then **wait for their results** before posting more. A later command that
  depends on an earlier one landing (reordering a cell you just added a card to)
  must wait for that result — the browser runs commands one at a time, oldest
  first, but only *your* next batch can know whether the first one worked.
- **Say what will change, in the user's language.** `description` is the only
  part of a command a person reads; the payload is shown as a small monospace
  line under it. 「把 ABC-12 移到 W34」 is right. A description that does not
  match its payload is indistinguishable from a mistake.
- **Answer in the language the user wrote in** (usually 繁體中文 here).
- **Mark handled when you are done** — after answering *and* after reading the
  results. `agentMarkHandled` refuses to clear commands still in flight, so
  calling it too early is safe but pointless.
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
  control.
- **Never post a command you would not narrate.** If you cannot write a
  one-sentence description a person would recognise, you do not understand the
  request well enough to act on it yet.
