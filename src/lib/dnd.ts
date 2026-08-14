import {
  pointerWithin,
  type Active,
  type CollisionDetection,
  type Over,
} from "@dnd-kit/core";

import type { Id } from "../../convex/_generated/dataModel";

/**
 * Payloads attached to dnd-kit's draggables and droppables.
 *
 * dnd-kit types `data` as an opaque record, so the two readers below are the
 * single place the cast happens; everything else works with real types.
 */

/** Travels with a dragged card. `from` says where dropping it back is a no-op. */
export type TicketDragData = {
  ticketId: Id<"tickets">;
  /** The card's epic. A move may not change it, so drops elsewhere fail. */
  epicId: Id<"epics">;
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

/** Returns null for the tray, whose droppable carries no cell data. */
export function cellDropData(over: Over | null): CellDropData | null {
  return (over?.data.current as CellDropData | undefined) ?? null;
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
