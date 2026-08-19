import { Clock, GitPullRequest, SquareCheckBig } from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";

import { AssigneeAvatar } from "@/components/AssigneeAvatar";
import { useBoardActions } from "@/components/BoardActionsProvider";
import { useBoardConfig } from "@/components/BoardConfigProvider";
import { StatusDot } from "@/components/StatusDot";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { isOverdue, STATUS_STYLES, type Ticket } from "@/lib/board";
import { formatDueDate } from "@/lib/dates";
import { prLabel } from "@/lib/github";
import { jiraIssueUrl } from "@/lib/jira";
import { cn } from "@/lib/utils";

/**
 * Cards are draggable, and the drag sensor listens on pointerdown of the whole
 * card. Links inside it stop that event so following a link never doubles as
 * the start of a drag.
 */
function keepPointerFromDrag(event: ReactPointerEvent) {
  event.stopPropagation();
}

/** What the badge on a card with a pending edit request says. */
const PENDING_LABEL: Record<NonNullable<Ticket["pendingEdit"]>["kind"], string> = {
  create: "待審新增",
  update: "待審修改",
  delete: "待審刪除",
  reorder: "待審排序",
};

export function TicketCard({ ticket, today }: { ticket: Ticket; today: string }) {
  const status = STATUS_STYLES[ticket.status];
  const overdue = isOverdue(ticket, today);
  const prs = ticket.githubPrs ?? [];
  const pending = ticket.pendingEdit;
  const hasMeta = Boolean(ticket.tag || ticket.dueDate || prs.length > 0 || pending);
  const jiraUrl = jiraIssueUrl(useBoardConfig()?.jiraBaseUrl, ticket.key);
  const { openEdit, cycleStatus, canEdit } = useBoardActions();

  return (
    // Clicking anywhere that is not a control opens the card for editing. The
    // drag sensor needs 6px of travel before it takes over, so a click stays a
    // click; `openEdit` also ignores the click that ends a drag. A read-only
    // account gets neither the handler nor the pointer cursor — the card is
    // something to read, and the links on it still work.
    <article
      onClick={canEdit ? () => openEdit(ticket) : undefined}
      className={cn(
        "flex flex-col justify-between gap-2 rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition hover:shadow-md",
        canEdit && "cursor-pointer",
        status.cardHover,
        // A card the reader has a pending request for is theirs alone to see this
        // way, so it is marked as a whole rather than only in its meta row.
        pending && "border-dashed border-amber-300 bg-amber-50/40",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="line-clamp-2 flex-1 text-xs leading-snug font-semibold text-slate-800">
          {ticket.title}
        </h4>
        <Tooltip>
          <TooltipTrigger asChild>
            {/* The dot is the fastest way to move a card along, so it is a
                button: each click advances one status. The write is debounced
                in `BoardApp`, so several clicks in a row cost one write. Without
                write access it is just the dot, and says so. */}
            {canEdit ? (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation(); // not a request to open the card
                  cycleStatus(ticket);
                }}
                onPointerDown={keepPointerFromDrag}
                aria-label={`狀態: ${status.label}，點一下切換到下一個狀態`}
                className="shrink-0 rounded-full pt-0.5 transition hover:scale-125"
              >
                <StatusDot status={ticket.status} className="block" />
              </button>
            ) : (
              <span
                aria-label={`狀態: ${status.label}`}
                className="shrink-0 rounded-full pt-0.5"
              >
                <StatusDot status={ticket.status} className="block" />
              </span>
            )}
          </TooltipTrigger>
          <TooltipContent>
            狀態: {status.label}
            {canEdit && "（點一下切換）"}
          </TooltipContent>
        </Tooltip>
      </div>

      {hasMeta && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          {/* Only the requester ever sees this: the card is showing their own
              proposal, and the change is not on anybody else's board yet. */}
          {pending && (
            <span
              title="這張卡片上有你提出、還在等待審核的修改；審核者按「核准」之後才會套用到看板上。"
              className="rounded border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800"
            >
              {PENDING_LABEL[pending.kind]}
            </span>
          )}
          {ticket.tag && (
            <span className="rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
              {ticket.tag}
            </span>
          )}
          {ticket.dueDate && (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold",
                overdue
                  ? "border border-rose-200 bg-rose-50 text-rose-600"
                  : "bg-slate-100 text-slate-500",
              )}
            >
              <Clock className="size-2.5" aria-hidden />
              <span>{formatDueDate(ticket.dueDate)}</span>
            </span>
          )}
          {prs.map((pr) => (
            <a
              key={pr}
              href={pr}
              target="_blank"
              rel="noreferrer"
              onPointerDown={keepPointerFromDrag}
              onClick={(event) => event.stopPropagation()}
              className="inline-flex items-center gap-1 rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700 transition hover:bg-indigo-100"
            >
              <GitPullRequest className="size-2.5" aria-hidden />
              <span>{prLabel(pr)}</span>
            </a>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-slate-100 pt-2 text-[11px]">
        {/* No Jira base URL configured: show the key, but not as a dead link. */}
        {jiraUrl === null ? (
          <span className="inline-flex items-center gap-1 font-mono font-medium text-slate-400">
            <SquareCheckBig className="size-2.5 text-indigo-500" aria-hidden />
            <span>{ticket.key}</span>
          </span>
        ) : (
          <a
            href={jiraUrl}
            target="_blank"
            rel="noreferrer"
            onPointerDown={keepPointerFromDrag}
            onClick={(event) => event.stopPropagation()}
            title={`在 Jira 開啟 ${ticket.key}`}
            className="inline-flex items-center gap-1 rounded font-mono font-medium text-slate-500 transition hover:text-indigo-700 hover:underline"
          >
            <SquareCheckBig className="size-2.5 text-indigo-500" aria-hidden />
            <span>{ticket.key}</span>
          </a>
        )}
        {ticket.assignee && (
          <div className="flex items-center gap-1">
            <AssigneeAvatar name={ticket.assignee} className="ring-1 ring-white" />
            <span className="text-[10px] font-bold text-slate-500">
              {ticket.assignee}
            </span>
          </div>
        )}
      </div>
    </article>
  );
}
