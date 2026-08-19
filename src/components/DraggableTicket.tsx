import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { useBoardActions } from "@/components/BoardActionsProvider";
import { TicketCard } from "@/components/TicketCard";
import type { Ticket } from "@/lib/board";
import type { TicketDragData } from "@/lib/dnd";
import { cn } from "@/lib/utils";

/**
 * A card in the matrix: draggable to another checkpoint row of the same epic, to
 * the staging tray, or up and down within its own cell.
 *
 * `useSortable` rather than plain `useDraggable` is what makes the cards in a
 * cell shuffle out of the way as one is dragged past them. The shuffle is a
 * transform applied by the sorting strategy, so nothing is written — and no state
 * changes — until the card is dropped.
 *
 * While the drag runs the card stays in place as a dimmed ghost so the reader
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
  const { canEdit } = useBoardActions();
  const data: TicketDragData = {
    ticketId: ticket._id,
    epicId: ticket.epicId,
    checkpointId: ticket.checkpointId,
    from: "cell",
  };
  // A read-only account keeps the sortable registration (so the cell still
  // measures the same) but not the drag: `disabled` drops the listeners, and the
  // grab cursor goes with them.
  const { setNodeRef, attributes, listeners, isDragging, transform, transition } =
    useSortable({ id: ticket._id, data, disabled: !canEdit });

  return (
    // touch-none: without it a touch drag scrolls the board instead of moving
    // the card, because the browser claims the gesture first.
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "touch-none rounded-xl",
        canEdit && "cursor-grab active:cursor-grabbing",
        isDragging && "opacity-40",
      )}
    >
      <TicketCard ticket={ticket} today={today} />
    </div>
  );
}
