import { useMutation, useQuery } from "convex/react";
import { BellRing, ExternalLink, X } from "lucide-react";
import { useState } from "react";

import { useSession } from "@/components/AuthProvider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { readableError } from "@/lib/auth";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

/**
 * What the board tracker has to say to the signed-in account.
 *
 * A second bell next to the inbox one (`AccountBar`), built the same way and
 * deliberately looking the same: same trigger, same red dot, same dropdown panel.
 * The difference is who fills it — the inbox is other people waiting for you, this
 * is the tracker telling you something — and that everyone with `permRead` has it,
 * so there is no permission-gated subscription here.
 *
 * `notifications:mine` is reactive, so a patrol that runs while the board is open
 * lights the dot without a reload. Dismissing a 進度 row is not just "hide it": it
 * tells the tracker "I've caught up", and the next recheck scan verifies that (see
 * `docs/data-model.md`, 「進度追蹤與通知」) — hence the hint on that button.
 */

const KIND_LABEL = {
  progress: "進度",
  report: "週報",
  info: "通知",
} as const;

/** Badge colours, in the palette the board already uses for its own badges. */
const KIND_STYLE = {
  progress: "bg-amber-100 text-amber-800",
  report: "bg-indigo-100 text-indigo-700",
  info: "bg-slate-200 text-slate-700",
} as const;

export function NotificationBell() {
  const session = useSession();
  const auth = session.credentials;

  const notifications = useQuery(api.notifications.mine, { auth });
  const dismiss = useMutation(api.notifications.dismiss);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const waiting = notifications?.length ?? 0;

  const act = async (notificationId: Id<"notifications">) => {
    setBusy(true);
    setError(null);
    try {
      await dismiss({ auth, notificationId });
    } catch (caught: unknown) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={waiting > 0 ? `通知 ${waiting} 則` : "通知（目前沒有）"}
          className="relative rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
        >
          <BellRing className="size-4" aria-hidden />
          {waiting > 0 && (
            // Same dot as the inbox bell: "there is something here", and the
            // panel behind it says what.
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
        <p className="px-1 pb-1.5 text-[11px] font-semibold text-slate-500">
          進度追蹤通知
        </p>

        {notifications === undefined ? (
          <p className="px-1 py-1.5 text-xs text-slate-400">載入中...</p>
        ) : notifications.length === 0 ? (
          <p className="px-1 py-1.5 text-xs text-slate-400">
            目前沒有通知。
          </p>
        ) : (
          <ul className="grid gap-1.5">
            {notifications.map((notification) => (
              <li
                key={notification._id}
                className="rounded-md border border-slate-200 p-2"
              >
                <div className="flex items-baseline gap-1.5">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                      KIND_STYLE[notification.kind]
                    }`}
                  >
                    {KIND_LABEL[notification.kind]}
                  </span>
                  <span className="min-w-0 flex-1 text-[10px] text-slate-400">
                    {new Date(notification._creationTime).toLocaleString("zh-TW", {
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void act(notification._id)}
                    title={
                      notification.kind === "progress"
                        ? "知道了，請 tracker 複查"
                        : "知道了"
                    }
                    aria-label={
                      notification.kind === "progress"
                        ? "知道了，請 tracker 複查"
                        : "關閉這則通知"
                    }
                    className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-50"
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </div>

                {/* Plain text, line breaks kept: the tracker writes short
                    paragraphs and lists of keys, not markup. */}
                <p className="mt-1 text-[11px] leading-relaxed whitespace-pre-wrap text-slate-700">
                  {notification.text}
                </p>

                {notification.keys && notification.keys.length > 0 && (
                  <p className="mt-1 flex flex-wrap gap-1">
                    {notification.keys.map((key) => (
                      <span
                        key={key}
                        className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[10px] text-slate-600"
                      >
                        {key}
                      </span>
                    ))}
                  </p>
                )}

                {notification.link && (
                  <a
                    href={notification.link}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-indigo-600 hover:text-indigo-700 hover:underline"
                  >
                    <ExternalLink className="size-3" aria-hidden />
                    開啟
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}

        <p className="px-1 pt-1.5 text-[10px] leading-relaxed text-slate-400">
          「進度」通知關掉等於告訴 tracker 你已經追上，它會再複查一次。
        </p>

        {error && (
          <p className="mt-1 rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] leading-relaxed text-rose-700">
            {error}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
