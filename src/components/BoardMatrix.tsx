import { MoveRight } from "lucide-react";

import { TicketCard } from "@/components/TicketCard";
import {
  describeCheckpoints,
  EPIC_ACCENT_CLASSES,
  type Checkpoint,
  type Epic,
  type Ticket,
} from "@/lib/board";
import { cn } from "@/lib/utils";

export function BoardMatrix({
  epics,
  checkpoints,
  tickets,
  today,
}: {
  epics: readonly Epic[];
  checkpoints: readonly Checkpoint[];
  tickets: readonly Ticket[];
  today: string;
}) {
  const rows = describeCheckpoints(checkpoints, today);

  // Bucket once by cell instead of re-scanning the ticket list per cell.
  const byCell = new Map<string, Ticket[]>();
  const epicTotals = new Map<string, number>();
  for (const ticket of tickets) {
    const cellKey = `${ticket.checkpointId}:${ticket.epicId}`;
    const cell = byCell.get(cellKey);
    if (cell) cell.push(ticket);
    else byCell.set(cellKey, [ticket]);

    epicTotals.set(ticket.epicId, (epicTotals.get(ticket.epicId) ?? 0) + 1);
  }

  return (
    <table className="w-full min-w-[1000px] border-collapse text-left">
      <thead>
        <tr>
          <th className="sticky top-0 left-0 z-40 w-52 border-r border-b border-slate-200 bg-slate-100 p-4 text-xs font-semibold tracking-wider text-slate-600 uppercase">
            <div className="flex items-center justify-between gap-2">
              <span className="whitespace-nowrap">週 Checkpoint</span>
              <MoveRight className="size-4 shrink-0 text-slate-400" aria-hidden />
              <span className="whitespace-nowrap">Epic 專案</span>
            </div>
          </th>
          {epics.map((epic) => (
            <th
              key={epic._id}
              className="sticky top-0 z-30 min-w-[260px] border-r border-b border-slate-200 bg-slate-50 p-3.5"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn(
                      "shrink-0 rounded border px-2 py-0.5 font-mono text-xs font-bold whitespace-nowrap",
                      EPIC_ACCENT_CLASSES[epic.accent],
                    )}
                  >
                    {epic.code}
                  </span>
                  <span
                    className="truncate text-sm font-bold text-slate-800"
                    title={epic.name}
                  >
                    {epic.name}
                  </span>
                </div>
                <span className="shrink-0 rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                  {epicTotals.get(epic._id) ?? 0}
                </span>
              </div>
            </th>
          ))}
        </tr>
      </thead>

      <tbody>
        {rows.map((row) => {
          const isCurrent = row.phase === "current";
          return (
            <tr
              key={row.checkpoint._id}
              className={isCurrent ? "bg-indigo-50/20" : "hover:bg-slate-50/50"}
            >
              <th
                scope="row"
                className={cn(
                  "sticky left-0 z-20 border-r border-b border-slate-200 bg-white p-3.5 text-left align-top text-xs font-medium text-slate-700",
                  isCurrent && "border-l-4 border-l-indigo-600",
                )}
              >
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-slate-800">{row.title}</span>
                    <span
                      className={cn(
                        "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
                        isCurrent
                          ? "bg-indigo-600 text-white"
                          : "bg-slate-100 text-slate-600",
                      )}
                    >
                      {row.badge}
                    </span>
                  </div>
                  <p className="text-[11px] font-normal text-slate-400">
                    {row.subtitle}
                  </p>
                </div>
              </th>

              {epics.map((epic) => {
                const cellTickets =
                  byCell.get(`${row.checkpoint._id}:${epic._id}`) ?? [];
                return (
                  <td
                    key={epic._id}
                    className="border-r border-b border-slate-200 p-3 align-top"
                  >
                    <div className="min-h-20 space-y-2.5">
                      {cellTickets.length === 0 ? (
                        <div className="flex h-16 items-center justify-center rounded-xl border-2 border-dashed border-slate-100 text-xs text-slate-300 transition hover:border-slate-200">
                          無對應項目
                        </div>
                      ) : (
                        cellTickets.map((ticket) => (
                          <TicketCard
                            key={ticket._id}
                            ticket={ticket}
                            today={today}
                          />
                        ))
                      )}
                    </div>
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
