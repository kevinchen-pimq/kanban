import { useDraggable, useDroppable } from "@dnd-kit/core";
import { Inbox, Undo2 } from "lucide-react";

import { AssigneeAvatar } from "@/components/AssigneeAvatar";
import type { Ticket } from "@/lib/board";
import { TRAY_DROP_ID, type TicketDragData } from "@/lib/dnd";
import { cn } from "@/lib/utils";

/**
 * Holding area at the bottom of the viewport for cards in transit.
 *
 * Dragging a card across many weeks means dragging past the edge of the
 * viewport and waiting on auto-scroll. Parking it here instead frees both
 * hands: scroll to the target week at leisure, then drag the card out of the
 * tray into the cell.
 *
 * Parked cards have **not** moved. They leave the matrix visually, but the
 * write only happens when one is dropped into a cell, so closing the tab with
 * cards still parked changes nothing in the database.
 *
 * `App` mounts the tray while a drag is running or while it holds cards, which
 * is also what registers it as a drop target.
 */
export function StagingTray({
  parked,
  onUnpark,
}: {
  parked: readonly Ticket[];
  /** Put a card back on the board without moving it. */
  onUnpark: (ticket: Ticket) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: TRAY_DROP_ID });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "fixed bottom-5 left-1/2 z-50 flex max-w-[min(90vw,44rem)] -translate-x-1/2 flex-col gap-2 rounded-2xl border-2 bg-white/95 px-4 py-3 shadow-xl backdrop-blur transition",
        isOver
          ? "border-indigo-500 bg-indigo-50/95"
          : "border-dashed border-slate-300",
      )}
    >
      <div className="flex items-center gap-2 text-[11px] font-semibold text-slate-500">
        <Inbox className="size-3.5 text-indigo-500" aria-hidden />
        <span>暫存區</span>
        <span className="font-normal text-slate-400">
          {parked.length === 0
            ? "把卡片拖進來,捲到目標週次後再拖出去"
            : `${parked.length} 張待放置,拖到目標格子才會真正移動`}
        </span>
      </div>

      {parked.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {parked.map((ticket) => (
            <ParkedChip key={ticket._id} ticket={ticket} onUnpark={onUnpark} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One parked card, compact enough that a trayful still fits on screen. It stays
 * draggable, and carries its epic so the same-epic rule survives the detour.
 */
function ParkedChip({
  ticket,
  onUnpark,
}: {
  ticket: Ticket;
  onUnpark: (ticket: Ticket) => void;
}) {
  const data: TicketDragData = {
    ticketId: ticket._id,
    epicId: ticket.epicId,
    from: "tray",
  };
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: `tray:${ticket._id}`,
    data,
  });

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white py-1 pr-1 pl-2 shadow-sm",
        isDragging && "opacity-40",
      )}
    >
      <div
        ref={setNodeRef}
        {...listeners}
        {...attributes}
        className="flex touch-none cursor-grab items-center gap-1.5 active:cursor-grabbing"
        title={ticket.title}
      >
        <span className="font-mono text-[10px] font-semibold text-slate-500">
          {ticket.key}
        </span>
        <span className="max-w-40 truncate text-[11px] font-medium text-slate-700">
          {ticket.title}
        </span>
        {ticket.assignee && <AssigneeAvatar name={ticket.assignee} />}
      </div>
      <button
        type="button"
        onClick={() => onUnpark(ticket)}
        aria-label={`把 ${ticket.key} 放回原本的格子`}
        title="放回原本的格子"
        className="rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
      >
        <Undo2 className="size-3" aria-hidden />
      </button>
    </div>
  );
}
