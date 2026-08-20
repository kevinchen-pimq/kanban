import { useMutation, useQuery } from "convex/react";
import { Loader2, MessageCircle, Send, X } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { useSession } from "@/components/AuthProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCommandExecutor } from "@/hooks/useCommandExecutor";
import {
  commandSummary,
  loadSeenAt,
  saveSeenAt,
  type ChatMessage,
} from "@/lib/assistant";
import { readableError } from "@/lib/auth";
import { api } from "../../convex/_generated/api";

/**
 * The board assistant: a chat with an agent that can operate the board.
 *
 * Messages live in Convex (`convex/messages.ts`), the agent is a Claude Code
 * session in a terminal, and anything it wants changed arrives as a *command*
 * message that **this** component executes — with the signed-in account's own
 * credential, through the ordinary board mutations. So the assistant can never do
 * more than the person it is talking to: `permWrite` applies the change,
 * `permEditRequest` gets the usual pending proposal, read-only gets a refusal in
 * the transcript. See `useCommandExecutor`.
 *
 * The executor is mounted here rather than inside the window, so commands run for
 * as long as the board is open — closing the chat is not a way to leave one
 * half-done, and reopening it does not replay anything. What the window adds is
 * only the reading and the typing.
 */
export function BoardAssistant() {
  const { credentials: auth, account, canWrite, canRequest } = useSession();
  const [open, setOpen] = useState(false);

  const messages = useQuery(api.messages.thread, { auth });
  useCommandExecutor(messages, auth, canRequest && !canWrite);

  // "New" is measured against the last time this account had the window open, so
  // the dot survives a reload without re-announcing what was already read.
  const [seenAt, setSeenAt] = useState(() => loadSeenAt(account));
  const latestAgentAt = useMemo(
    () =>
      (messages ?? []).reduce(
        (latest, message) =>
          message.role === "agent"
            ? Math.max(latest, message._creationTime)
            : latest,
        0,
      ),
    [messages],
  );

  useEffect(() => {
    if (!open || latestAgentAt <= seenAt) return;
    setSeenAt(latestAgentAt);
    saveSeenAt(account, latestAgentAt);
  }, [account, latestAgentAt, open, seenAt]);

  const unread = !open && latestAgentAt > seenAt;

  return (
    <>
      {open && (
        <ChatWindow
          messages={messages}
          requestMode={canRequest && !canWrite}
          onClose={() => setOpen(false)}
        />
      )}

      {/* Below the staging tray and the dialogs (z-50) on purpose: while a card
          is being dragged, the tray is what needs to be reachable. */}
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-label={
          open ? "關閉看板助理" : unread ? "看板助理（有新訊息）" : "看板助理"
        }
        className="fixed right-6 bottom-6 z-40 flex size-12 items-center justify-center rounded-full bg-indigo-600 text-white shadow-lg transition hover:bg-indigo-700"
      >
        {open ? (
          <X className="size-5" aria-hidden />
        ) : (
          <MessageCircle className="size-5" aria-hidden />
        )}
        {unread && (
          <span
            className="absolute top-1 right-1 size-3 rounded-full bg-rose-500 ring-2 ring-white"
            aria-hidden
          />
        )}
      </button>
    </>
  );
}

function ChatWindow({
  messages,
  requestMode,
  onClose,
}: {
  messages: readonly ChatMessage[] | undefined;
  requestMode: boolean;
  onClose: () => void;
}) {
  const { credentials: auth } = useSession();
  const send = useMutation(api.messages.send);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Follow the conversation: a reply arriving while the window is open should be
  // visible without scrolling for it.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;

    setSending(true);
    setError(null);
    try {
      await send({ auth, text });
      setDraft("");
    } catch (caught: unknown) {
      setError(readableError(caught));
    } finally {
      setSending(false);
    }
  };

  return (
    <section
      aria-label="看板助理"
      className="fixed right-6 bottom-22 z-40 flex max-h-[min(34rem,70vh)] w-[min(24rem,calc(100vw-3rem))] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl"
    >
      <header className="flex items-start gap-2 border-b border-slate-100 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-800">看板助理</p>
          <p className="text-[10px] leading-relaxed text-slate-400">
            {requestMode
              ? "助理的操作會用你的權限執行,所以每個編輯都會變成待審提議。"
              : "說你想做什麼,助理會用你的權限操作看板。"}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="關閉"
          className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        >
          <X className="size-4" aria-hidden />
        </button>
      </header>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-3">
        {messages === undefined ? (
          <Hint>載入中...</Hint>
        ) : messages.length === 0 ? (
          <Hint>
            還沒有對話。試著說「把 ABC-12 移到 W34」或「這一週有哪些卡片還沒完成」
            ——助理是終端機裡的 agent,回覆會慢一點。
          </Hint>
        ) : (
          <ul className="grid gap-2">
            {messages.map((message) => (
              <li key={message._id}>
                <Message message={message} />
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && (
        <p className="border-t border-rose-200 bg-rose-50 px-3 py-1.5 text-[11px] text-rose-700">
          {error}
        </p>
      )}

      <form
        onSubmit={(event) => void submit(event)}
        className="flex items-center gap-2 border-t border-slate-100 p-2"
      >
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="跟看板助理說..."
          maxLength={4000}
          className="h-8 border-slate-200 text-xs"
        />
        <Button
          type="submit"
          size="sm"
          disabled={sending || draft.trim() === ""}
          className="h-8 bg-indigo-600 px-2.5 hover:bg-indigo-700"
        >
          {sending ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <Send className="size-3.5" aria-hidden />
          )}
          <span className="sr-only">送出</span>
        </Button>
      </form>
    </section>
  );
}

/** How each command status reads, and how it looks. */
const STATUS_STYLE: Record<
  NonNullable<ChatMessage["status"]>,
  { label: string; className: string }
> = {
  pending: { label: "等待執行", className: "bg-slate-100 text-slate-500" },
  running: { label: "執行中", className: "bg-indigo-100 text-indigo-700" },
  executed: { label: "已執行", className: "bg-emerald-100 text-emerald-700" },
  proposed: { label: "已建立提議", className: "bg-amber-100 text-amber-800" },
  failed: { label: "失敗", className: "bg-rose-100 text-rose-700" },
};

function Message({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    // `readAt` is stamped by the assistant's listener the moment the message
    // reaches it, and `thread` is a subscription — so the mark appears on its own
    // a moment after sending, which is the only sign the agent is actually on
    // duty. Deliberately quiet: it is reassurance, not information.
    return (
      <div className="ml-8 grid justify-items-end gap-0.5">
        <p className="rounded-2xl rounded-br-sm bg-indigo-600 px-3 py-1.5 text-xs leading-relaxed break-words text-white">
          {message.text}
        </p>
        {message.readAt !== undefined && (
          <span className="pr-1 text-[10px] text-slate-400">已讀</span>
        )}
      </div>
    );
  }

  if (!message.command) {
    return (
      <p className="mr-8 rounded-2xl rounded-bl-sm bg-slate-100 px-3 py-1.5 text-xs leading-relaxed break-words text-slate-700">
        {message.text}
      </p>
    );
  }

  const status = STATUS_STYLE[message.status ?? "pending"];
  return (
    <div className="mr-4 grid gap-1 rounded-xl border border-slate-200 bg-white p-2">
      <div className="flex items-center gap-1.5">
        <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700">
          指令
        </span>
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${status.className}`}
        >
          {status.label}
        </span>
      </div>

      {/* The agent's own sentence: the part a person is expected to read. */}
      <p className="text-xs leading-relaxed break-words text-slate-700">
        {message.text}
      </p>

      {/* And the payload it actually sent, so the two can be compared. */}
      <p className="font-mono text-[10px] leading-snug break-all text-slate-400">
        {commandSummary(message.command)}
      </p>

      {message.status === "failed" && message.result && (
        <p className="rounded bg-rose-50 px-1.5 py-1 text-[10px] leading-relaxed text-rose-700">
          {message.result}
        </p>
      )}
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return (
    <p className="px-1 py-2 text-[11px] leading-relaxed text-slate-400">
      {children}
    </p>
  );
}
