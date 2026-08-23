import { useMutation, useQuery } from "convex/react";
import { Bell, Check, LogOut, Undo2, X } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useAuth, useSession } from "@/components/AuthProvider";
import { NotificationBell } from "@/components/NotificationBell";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { readableError } from "@/lib/auth";
import { api } from "../../convex/_generated/api";

/**
 * Who is signed in, the way out, and the inbox behind the bell.
 *
 * The bell holds up to three lists, one per permission, and each one is only
 * *subscribed* for an account that holds the matching permission — those queries
 * reject anybody else, and a rejected query would throw through the header:
 *
 * - `permApproveRegister` → registrations waiting for a decision
 * - `permWrite` → edit requests waiting to be approved
 * - `permEditRequest` → this account's own pending requests, to withdraw
 *
 * The permissions are independent, so an account may see any combination. The red
 * dot means "somebody is waiting for you": a pending registration or a pending
 * edit request. Own proposals do not raise it — nobody is waiting for the person
 * who made them.
 *
 * Next to it sits the tracker's bell (`NotificationBell`), built the same way but
 * shown to everybody: the inbox is other people waiting for you, notifications are
 * the tracker talking to you.
 */
export function AccountBar() {
  const session = useSession();
  const { signOut } = useAuth();
  const hasInbox = session.canApprove || session.canWrite || session.canRequest;

  return (
    <div className="flex items-center gap-2">
      <NotificationBell />
      {hasInbox && <InboxBell />}

      <span className="max-w-[160px] truncate font-mono text-xs text-slate-500">
        {session.account}
      </span>
      {/* What this account's edits do, said once: nothing for a direct writer,
          "proposals" for a requester, "read-only" for everyone else. */}
      {!session.canWrite &&
        (session.canRequest ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
            提議編輯
          </span>
        ) : (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
            唯讀
          </span>
        ))}

      <Button
        variant="ghost"
        size="sm"
        onClick={signOut}
        className="h-auto px-2 py-1 text-xs font-medium text-slate-500 hover:text-indigo-600"
      >
        <LogOut className="size-3" aria-hidden />
        登出
      </Button>
    </div>
  );
}

function InboxBell() {
  const session = useSession();
  const auth = session.credentials;

  const registrations = useQuery(
    api.auth.pendingUsers,
    session.canApprove ? { auth } : "skip",
  );
  const toReview = useQuery(
    api.editRequests.list,
    session.canWrite ? { auth } : "skip",
  );
  const myRequests = useQuery(
    api.editRequests.mine,
    session.canRequest ? { auth } : "skip",
  );

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Run one decision, keeping its complaint where the buttons are. */
  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (caught: unknown) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  const approveUser = useMutation(api.auth.approve);
  const dismissUser = useMutation(api.auth.dismiss);
  const approveRequest = useMutation(api.editRequests.approve);
  const dismissRequest = useMutation(api.editRequests.dismiss);
  const withdrawRequest = useMutation(api.editRequests.withdraw);

  // Only things somebody else is waiting on. Own proposals are in the list below
  // but never light the dot.
  const waiting = (registrations?.length ?? 0) + (toReview?.length ?? 0);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={waiting > 0 ? `待處理 ${waiting} 筆` : "待處理（目前沒有）"}
          className="relative rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
        >
          <Bell className="size-4" aria-hidden />
          {waiting > 0 && (
            // The dot, not the number: the point is only "there is something
            // waiting", and the lists right behind it say what.
            <span
              className="absolute top-1 right-1 size-2 rounded-full bg-rose-500 ring-2 ring-white"
              aria-hidden
            />
          )}
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        className="max-h-[70vh] w-96 overflow-y-auto border-slate-200 bg-white p-2"
      >
        {session.canApprove && (
          <Section title="待審核註冊">
            {registrations === undefined ? (
              <Hint>載入中...</Hint>
            ) : registrations.length === 0 ? (
              <Hint>目前沒有待審核帳號。</Hint>
            ) : (
              <ul className="grid gap-1">
                {registrations.map((user) => (
                  <li
                    key={user.userId}
                    className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-slate-50"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-700">
                      {user.account}
                    </span>
                    <Decide
                      busy={busy}
                      onYes={() =>
                        void act(() => approveUser({ auth, userId: user.userId }))
                      }
                      onNo={() =>
                        void act(() => dismissUser({ auth, userId: user.userId }))
                      }
                      yes="通過"
                      no="拒絕"
                    />
                  </li>
                ))}
              </ul>
            )}
            <Note>通過只會給讀取權限；編輯權限要由管理者另外設定。</Note>
          </Section>
        )}

        {session.canWrite && (
          <Section title="待審核編輯">
            {toReview === undefined ? (
              <Hint>載入中...</Hint>
            ) : toReview.length === 0 ? (
              <Hint>目前沒有待審核的編輯提議。</Hint>
            ) : (
              <ul className="grid gap-1.5">
                {toReview.map((request) => (
                  <li
                    key={request.requestId}
                    className="rounded-md border border-slate-200 p-2"
                  >
                    <RequestSummary request={request} showAccount />
                    <div className="mt-1.5 flex justify-end">
                      <Decide
                        busy={busy}
                        onYes={() =>
                          void act(() =>
                            approveRequest({ auth, requestId: request.requestId }),
                          )
                        }
                        onNo={() =>
                          void act(() =>
                            dismissRequest({ auth, requestId: request.requestId }),
                          )
                        }
                        yes="核准"
                        no="忽略"
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <Note>核准會立刻套用到看板上,所有人都看得到。</Note>
          </Section>
        )}

        {session.canRequest && (
          <Section title="我的提議">
            {myRequests === undefined ? (
              <Hint>載入中...</Hint>
            ) : myRequests.length === 0 ? (
              <Hint>你目前沒有待審核的提議。</Hint>
            ) : (
              <ul className="grid gap-1.5">
                {myRequests.map((request) => (
                  <li
                    key={request.requestId}
                    className="rounded-md border border-amber-200 bg-amber-50/50 p-2"
                  >
                    <RequestSummary request={request} />
                    <div className="mt-1.5 flex justify-end">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void act(() =>
                            withdrawRequest({ auth, requestId: request.requestId }),
                          )
                        }
                        className="h-6 gap-1 border-slate-300 px-2 text-[11px] text-slate-600"
                      >
                        <Undo2 className="size-3" aria-hidden />
                        撤回
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <Note>撤回之後,你的看板會回到原本的內容。</Note>
          </Section>
        )}

        {error && (
          <p className="mt-1 rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] leading-relaxed text-rose-700">
            {error}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** What one request asks for: which card, and the fields it would change. */
type RequestView = {
  kind: "create" | "update" | "delete" | "reorder";
  account: string;
  key: string;
  title: string;
  changes: readonly { label: string; from: string | null; to: string | null }[];
  requestedAt: number;
  warning: string | null;
};

const KIND_LABEL: Record<RequestView["kind"], string> = {
  create: "新增",
  update: "修改",
  delete: "刪除",
  reorder: "排序",
};

function RequestSummary({
  request,
  showAccount = false,
}: {
  request: RequestView;
  showAccount?: boolean;
}) {
  return (
    <div className="grid gap-1">
      <div className="flex items-baseline gap-1.5">
        <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700">
          {KIND_LABEL[request.kind]}
        </span>
        <span className="font-mono text-[11px] font-medium text-slate-500">
          {request.key}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-slate-700">
          {request.title}
        </span>
      </div>

      {showAccount && (
        <p className="text-[10px] text-slate-400">
          <span className="font-mono">{request.account}</span> ·{" "}
          {new Date(request.requestedAt).toLocaleString("zh-TW", {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      )}

      {/* The whole point of the review list: what would actually change. */}
      <ul className="grid gap-0.5">
        {request.changes.map((change, index) => (
          <li key={index} className="text-[11px] leading-snug text-slate-600">
            <span className="text-slate-400">{change.label}: </span>
            <span className="text-slate-500 line-through decoration-slate-300">
              {change.from ?? "—"}
            </span>
            <span className="text-slate-400"> → </span>
            <span className="font-semibold text-slate-800">
              {change.to ?? "—"}
            </span>
          </li>
        ))}
      </ul>

      {request.warning && (
        <p className="text-[10px] leading-snug text-rose-600">{request.warning}</p>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-1.5 border-b border-slate-100 pb-1.5 last:mb-0 last:border-b-0">
      <p className="px-1 pb-1.5 text-[11px] font-semibold text-slate-500">
        {title}
      </p>
      {children}
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="px-1 py-1.5 text-xs text-slate-400">{children}</p>;
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="px-1 pt-1.5 text-[10px] leading-relaxed text-slate-400">
      {children}
    </p>
  );
}

/** The two buttons every row in this menu ends with. */
function Decide({
  busy,
  onYes,
  onNo,
  yes,
  no,
}: {
  busy: boolean;
  onYes: () => void;
  onNo: () => void;
  yes: string;
  no: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        disabled={busy}
        onClick={onYes}
        className="h-6 gap-1 bg-emerald-600 px-2 text-[11px] hover:bg-emerald-700"
      >
        <Check className="size-3" aria-hidden />
        {yes}
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={onNo}
        className="h-6 gap-1 border-slate-300 px-2 text-[11px] text-slate-600"
      >
        <X className="size-3" aria-hidden />
        {no}
      </Button>
    </div>
  );
}
