import { useDraggable } from "@dnd-kit/core";

import { TicketCard } from "@/components/TicketCard";
import type { Ticket } from "@/lib/board";
import type { TicketDragData } from "@/lib/dnd";
import { cn } from "@/lib/utils";

/**
 * A card in the matrix that can be picked up and dropped on another checkpoint
 * row of the same epic, or parked in the staging tray.
 *
 * While the drag runs, the card stays in place as a dimmed ghost so the reader
 * keeps the row's context; the thing following the cursor is the `DragOverlay`
 * in `App`.
 */
export function DraggableTicket({
  ticket,
  today,
}: {
  ticket: Ticket;
  today: string;
}) {
  const data: TicketDragData = {
    ticketId: ticket._id,
    epicId: ticket.epicId,
    from: "cell",
  };
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: ticket._id,
    data,
  });

  return (
    // touch-none: without it a touch drag scrolls the board instead of moving
    // the card, because the browser claims the gesture first.
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={cn(
        "touch-none rounded-xl cursor-grab active:cursor-grabbing",
        isDragging && "opacity-40",
      )}
    >
      <TicketCard ticket={ticket} today={today} />
    </div>
  );
}
