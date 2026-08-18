import { useMutation, useQuery } from "convex/react";
import { Bell, Check, LogOut, X } from "lucide-react";
import { useState } from "react";

import { useAuth, useSession } from "@/components/AuthProvider";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { readableError } from "@/lib/auth";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

/**
 * Who is signed in, the way out, and — for approvers — the registration inbox.
 *
 * The bell is only rendered for `permApproveRegister`, and its query is only
 * subscribed for them too: `auth:pendingUsers` rejects anybody else, and a
 * rejected query would throw through the header. Because it *is* a subscription,
 * the red dot appears the moment somebody registers, with no reload and no
 * polling.
 */
export function AccountBar() {
  const session = useSession();
  const { signOut } = useAuth();

  return (
    <div className="flex items-center gap-2">
      {session.canApprove && <ApprovalBell />}

      <span className="max-w-[160px] truncate font-mono text-xs text-slate-500">
        {session.account}
      </span>
      {!session.canWrite && (
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
          唯讀
        </span>
      )}

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

function ApprovalBell() {
  const session = useSession();
  const pending = useQuery(api.auth.pendingUsers, { auth: session.credentials });
  const approve = useMutation(api.auth.approve);
  const dismiss = useMutation(api.auth.dismiss);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Id<"users"> | null>(null);

  const count = pending?.length ?? 0;

  const act = async (
    userId: Id<"users">,
    run: (args: {
      auth: typeof session.credentials;
      userId: Id<"users">;
    }) => Promise<null>,
  ) => {
    setBusy(userId);
    setError(null);
    try {
      await run({ auth: session.credentials, userId });
    } catch (caught: unknown) {
      setError(readableError(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={
            count > 0 ? `待審核註冊 ${count} 筆` : "待審核註冊（目前沒有）"
          }
          className="relative rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
        >
          <Bell className="size-4" aria-hidden />
          {count > 0 && (
            // The dot, not the number: the point is only "there is something
            // waiting", and the list right behind it says what.
            <span
              className="absolute top-1 right-1 size-2 rounded-full bg-rose-500 ring-2 ring-white"
              aria-hidden
            />
          )}
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        className="w-72 border-slate-200 bg-white p-2"
      >
        <p className="px-1 pb-1.5 text-[11px] font-semibold text-slate-500">
          待審核註冊
        </p>

        {pending === undefined ? (
          <p className="px-1 py-2 text-xs text-slate-400">載入中...</p>
        ) : pending.length === 0 ? (
          <p className="px-1 py-2 text-xs text-slate-400">目前沒有待審核帳號。</p>
        ) : (
          <ul className="grid gap-1">
            {pending.map((user) => (
              <li
                key={user.userId}
                className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-slate-50"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-700">
                  {user.account}
                </span>
                <Button
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void act(user.userId, approve)}
                  className="h-6 gap-1 bg-emerald-600 px-2 text-[11px] hover:bg-emerald-700"
                >
                  <Check className="size-3" aria-hidden />
                  通過
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => void act(user.userId, dismiss)}
                  className="h-6 gap-1 border-slate-300 px-2 text-[11px] text-slate-600"
                >
                  <X className="size-3" aria-hidden />
                  拒絕
                </Button>
              </li>
            ))}
          </ul>
        )}

        <p className="px-1 pt-1.5 text-[10px] leading-relaxed text-slate-400">
          通過只會給讀取權限；編輯權限要由管理者另外設定。
        </p>

        {error && (
          <p className="mt-1 rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] text-rose-700">
            {error}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
