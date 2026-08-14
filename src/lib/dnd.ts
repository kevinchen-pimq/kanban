import {
  pointerWithin,
  type Active,
  type CollisionDetection,
  type Over,
} from "@dnd-kit/core";
import { arrayMove, hasSortableData } from "@dnd-kit/sortable";

import type { Id } from "../../convex/_generated/dataModel";

/**
 * Payloads attached to dnd-kit's draggables and droppables.
 *
 * dnd-kit types `data` as an opaque record, so the readers below are the single
 * place the cast happens; everything else works with real types.
 */

/** Travels with a dragged card. `from` says whether it started in the tray. */
export type TicketDragData = {
  ticketId: Id<"tickets">;
  /** The card's epic. A move may not change it, so drops elsewhere fail. */
  epicId: Id<"epics">;
  /** The cell the card is in; absent while it waits in the tray. */
  checkpointId?: Id<"checkpoints">;
  from: "cell" | "tray";
};

/** Attached to every (checkpoint, epic) cell of the matrix. */
export type CellDropData = {
  checkpointId: Id<"checkpoints">;
  epicId: Id<"epics">;
};

/** Droppable id of the staging tray. Cells use their own composite ids. */
export const TRAY_DROP_ID = "staging-tray";

export function ticketDragData(active: Active | null): TicketDragData | null {
  return (active?.data.current as TicketDragData | undefined) ?? null;
}

/**
 * Where a drop landed.
 *
 * A card can be let go over a cell or over another card, and both answers mean
 * "this cell": cards carry their own `checkpointId`, so the two data shapes read
 * the same way. Cards are the ones that matter for ordering — dropping on a card
 * is how a position within a cell gets chosen.
 */
export type DropTarget =
  | { kind: "tray" }
  | { kind: "cell"; epicId: Id<"epics">; checkpointId: Id<"checkpoints"> }
  | null;

export function resolveDropTarget(over: Over | null): DropTarget {
  if (!over) return null;
  if (over.id === TRAY_DROP_ID) return { kind: "tray" };

  const data = over.data.current as
    | Partial<CellDropData & TicketDragData>
    | undefined;
  if (!data?.epicId || !data.checkpointId) return null;
  return {
    kind: "cell",
    epicId: data.epicId,
    checkpointId: data.checkpointId,
  };
}

/**
 * The cell's ids after moving the dragged card to where it was dropped, or null
 * when this drop does not rearrange one list (a drop on a cell's empty space, or
 * one that crosses cells).
 *
 * The ids and both indices come from dnd-kit's own sortable bookkeeping, which is
 * the same source the on-screen shuffle is computed from — so what gets saved is
 * exactly what the reader saw.
 */
export function reorderedCell(
  active: Active,
  over: Over,
): Id<"tickets">[] | null {
  if (!hasSortableData(active) || !hasSortableData(over)) return null;

  const { items, index: from } = active.data.current.sortable;
  const { index: to } = over.data.current.sortable;
  if (from === -1 || to === -1) return null;
  if (active.data.current.sortable.containerId !== over.data.current.sortable.containerId) {
    return null; // a different cell's list: this is a move, not a reorder
  }

  return arrayMove(items, from, to) as Id<"tickets">[];
}

/**
 * Pointer-based hit testing, with the tray always winning.
 *
 * The tray floats over the matrix, so a pointer inside it is inside a cell too.
 * `pointerWithin` alone would then rank the two by distance to their centres and
 * could hand the drop to the cell hidden underneath.
 */
export const trayFirstCollision: CollisionDetection = (args) => {
  const collisions = pointerWithin(args);
  const tray = collisions.find((collision) => collision.id === TRAY_DROP_ID);
  return tray ? [tray] : collisions;
};
