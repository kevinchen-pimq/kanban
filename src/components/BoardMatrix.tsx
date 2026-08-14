import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { LocateFixed, Plus } from "lucide-react";

import { useBoardActions } from "@/components/BoardActionsProvider";
import { DraggableTicket } from "@/components/DraggableTicket";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  describeCheckpoints,
  sortCellTickets,
  type Checkpoint,
  type Epic,
  type Ticket,
} from "@/lib/board";
import {
  resolveDropTarget,
  ticketDragData,
  type CellDropData,
} from "@/lib/dnd";
import { cn } from "@/lib/utils";
import type { Id } from "../../convex/_generated/dataModel";

/**
 * Width of the rotated checkpoint gutter. Narrow like a spreadsheet's row
 * header, since the label reads vertically and costs no horizontal room.
 */
const GUTTER_PX = 48;

/**
 * Every epic column is exactly this wide. The table is sized from the column
 * count rather than stretched to the container, so a board with one epic gets
 * the same readable card width as a board with six, and extra epics scroll
 * horizontally instead of squeezing.
 */
const COLUMN_PX = 300;

export function BoardMatrix({
  epics,
  checkpoints,
  tickets,
  today,
  onThisWeek,
}: {
  epics: readonly Epic[];
  checkpoints: readonly Checkpoint[];
  tickets: readonly Ticket[];
  today: string;
  /** Scrolls the current week's row into view; see `scrollToCurrentWeek`. */
  onThisWeek: () => void;
}) {
  const rows = describeCheckpoints(checkpoints, today);
  const hasCurrentWeek = rows.some((row) => row.phase === "current");

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
    // table-fixed plus an explicit width makes the column sizes exact rather
    // than a hint the browser may stretch when there is spare room.
    <table
      className="table-fixed border-collapse text-left"
      style={{ width: GUTTER_PX + epics.length * COLUMN_PX }}
    >
      <thead>
        <tr>
          <th
            style={{ width: GUTTER_PX }}
            className="sticky top-0 left-0 z-40 border-r border-b border-slate-200 bg-slate-100 p-0"
          >
            <span className="sr-only">週 Checkpoint</span>
            <div className="flex items-center justify-center">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onThisWeek}
                    disabled={!hasCurrentWeek}
                    aria-label="捲動到本週"
                    className="rounded-md p-1.5 text-slate-500 transition hover:bg-white hover:text-indigo-600 disabled:pointer-events-none disabled:opacity-30"
                  >
                    <LocateFixed className="size-4" aria-hidden />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {hasCurrentWeek ? "捲動到本週" : "目前的資料沒有包含本週"}
                </TooltipContent>
              </Tooltip>
            </div>
          </th>
          {epics.map((epic) => (
            <th
              key={epic._id}
              style={{ width: COLUMN_PX }}
              className="sticky top-0 z-30 border-r border-b border-slate-200 bg-slate-50 p-3.5"
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className="truncate text-sm font-bold text-slate-800"
                  title={epic.name}
                >
                  {epic.name}
                </span>
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
              // Marks the row for today so the board can open scrolled to it.
              data-current-week={isCurrent || undefined}
              className={isCurrent ? "bg-indigo-50/20" : "hover:bg-slate-50/50"}
            >
              <th
                scope="row"
                style={{ width: GUTTER_PX }}
                className={cn(
                  "sticky left-0 z-20 border-r border-b border-slate-200 bg-white p-0",
                  isCurrent && "border-l-4 border-l-indigo-600",
                )}
              >
                {/* Rotated so the row label costs vertical space, not width.
                    vertical-rl + rotate-180 reads bottom-to-top, which keeps
                    the week number at the top of the row. text-orientation
                    must be sideways: the default leaves CJK glyphs upright,
                    and rotate-180 would then render them upside down. */}
                <div className="flex h-full items-center justify-center py-3">
                  <div className="flex flex-row-reverse items-center gap-2 whitespace-nowrap [text-orientation:sideways] [writing-mode:vertical-rl] rotate-180">
                    <span className="text-xs font-bold text-slate-800">
                      {row.title}
                    </span>
                    <span className="text-[11px] font-normal text-slate-400">
                      {row.subtitle}
                    </span>
                  </div>
                </div>
              </th>

              {epics.map((epic) => (
                <DropCell
                  key={epic._id}
                  checkpointId={row.checkpoint._id}
                  epicId={epic._id}
                  tickets={sortCellTickets(
                    byCell.get(`${row.checkpoint._id}:${epic._id}`) ?? [],
                  )}
                  today={today}
                />
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * One (checkpoint, epic) cell: the drop target for a card moving between weeks,
 * the sortable list for arranging the cards already in it, and the place a new
 * card is created.
 *
 * A card may only change rows: a cell belonging to another epic lights up red
 * and rejects the drop, because a move is meant to re-date work, not reassign
 * it to a different project.
 */
function DropCell({
  checkpointId,
  epicId,
  tickets,
  today,
}: {
  checkpointId: Id<"checkpoints">;
  epicId: Id<"epics">;
  /** Already in display order; see `sortCellTickets`. */
  tickets: readonly Ticket[];
  today: string;
}) {
  const { openCreate } = useBoardActions();
  const data: CellDropData = { checkpointId, epicId };
  const cellId = `cell:${checkpointId}:${epicId}`;
  const { setNodeRef, over, active } = useDroppable({ id: cellId, data });

  // Both signals come from the one resolved target rather than from `isOver`:
  // while a card is being sorted inside its own cell the target is the card, and
  // this cell says nothing — the shuffling cards are already the feedback. Any
  // other cell under the pointer speaks instead, in one voice: indigo when the
  // card may land here, red when it belongs to another epic.
  const drag = ticketDragData(active);
  const target = resolveDropTarget(over);
  const targeted =
    target?.kind === "cell" &&
    !target.onCard &&
    target.checkpointId === checkpointId &&
    target.epicId === epicId;

  const rejecting = targeted && drag !== null && drag.epicId !== epicId;
  const accepting = targeted && !rejecting;

  return (
    <td
      ref={setNodeRef}
      title={rejecting ? "只能在同一個 Epic 的欄位內移動" : undefined}
      className={cn(
        "group relative border-r border-b border-slate-200 p-3 align-top transition-colors",
        accepting && "bg-indigo-50 ring-2 ring-indigo-400 ring-inset",
        rejecting && "cursor-not-allowed bg-rose-50 ring-2 ring-rose-400 ring-inset",
      )}
    >
      {/* Unobtrusive on purpose: one per cell, only on hover, so the board still
          reads as a board rather than a form. */}
      <button
        type="button"
        onClick={() => openCreate(epicId, checkpointId)}
        aria-label="在這一格新增卡片"
        title="在這一格新增卡片"
        className="absolute top-1 right-1 rounded-md p-1 text-slate-300 opacity-0 transition group-hover:opacity-100 hover:bg-white hover:text-indigo-600 focus-visible:opacity-100"
      >
        <Plus className="size-3.5" aria-hidden />
      </button>

      <div className="min-h-20 space-y-2.5">
        {tickets.length === 0 ? (
          <div
            className={cn(
              "flex h-16 items-center justify-center rounded-xl border-2 border-dashed border-slate-100 text-xs text-slate-300 transition hover:border-slate-200",
              accepting && "border-indigo-300 text-indigo-500",
              rejecting && "border-rose-300 text-rose-500",
            )}
          >
            {rejecting ? "不能跨 Epic" : accepting ? "放這裡" : "無對應項目"}
          </div>
        ) : (
          // One SortableContext per cell, identified by the cell id: that is what
          // tells dnd-kit which list a card is being sorted within, and what
          // makes a drag into a different cell read as a move rather than a
          // reorder.
          <SortableContext
            id={cellId}
            items={tickets.map((ticket) => ticket._id)}
            strategy={verticalListSortingStrategy}
          >
            {tickets.map((ticket) => (
              <DraggableTicket key={ticket._id} ticket={ticket} today={today} />
            ))}
          </SortableContext>
        )}
      </div>
    </td>
  );
}
