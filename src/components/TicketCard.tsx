import { Clock, SquareCheckBig } from "lucide-react";

import { StatusDot } from "@/components/StatusDot";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { initials, isOverdue, STATUS_STYLES, type Ticket } from "@/lib/board";
import { formatDueDate } from "@/lib/dates";
import { cn } from "@/lib/utils";

export function TicketCard({ ticket, today }: { ticket: Ticket; today: string }) {
  const status = STATUS_STYLES[ticket.status];
  const overdue = isOverdue(ticket, today);

  return (
    <article
      className={cn(
        "flex flex-col justify-between gap-2 rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition hover:shadow-md",
        status.cardHover,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="line-clamp-2 flex-1 text-xs leading-snug font-semibold text-slate-800">
          {ticket.title}
        </h4>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="shrink-0 pt-0.5">
              <StatusDot status={ticket.status} className="block" />
            </span>
          </TooltipTrigger>
          <TooltipContent>狀態: {status.label}</TooltipContent>
        </Tooltip>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 pt-1">
        <span className="rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
          {ticket.tag}
        </span>
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
      </div>

      <div className="flex items-center justify-between border-t border-slate-100 pt-2 text-[11px]">
        <div className="flex items-center gap-1 font-mono font-medium text-slate-400">
          <SquareCheckBig className="size-2.5 text-indigo-500" aria-hidden />
          <span>{ticket.key}</span>
        </div>
        <div className="flex items-center gap-1">
          <Avatar className="size-4 ring-1 ring-white">
            <AvatarFallback className="bg-[#7c2d12] text-[8px] font-semibold text-white">
              {initials(ticket.assignee)}
            </AvatarFallback>
          </Avatar>
          <span className="text-[10px] font-bold text-slate-500">
            {ticket.assignee}
          </span>
        </div>
      </div>
    </article>
  );
}
