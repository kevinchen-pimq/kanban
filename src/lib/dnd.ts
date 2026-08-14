import {
  closestCenter,
  pointerWithin,
  type Active,
  type CollisionDetection,
  type DroppableContainer,
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
 * Where a drop would land, resolved once.
 *
 * A card can be let go over a cell or over another card, and both answers name
 * the same cell — cards carry their own `checkpointId`, so the two data shapes
 * read the same way. What differs is the *kind* of feedback that belongs to each:
 * `onCard` is true when the pointer resolved to a card, which only happens inside
 * the cell the drag started in, and which means the sort preview is doing the
 * talking and the cell must stay quiet.
 *
 * Every indicator on the board comes from this one value. When two components
 * each read `over` their own way, they disagree, and the reader sees them argue.
 */
export type DropTarget =
  | { kind: "tray" }
  | {
      kind: "cell";
      epicId: Id<"epics">;
      checkpointId: Id<"checkpoints">;
      /** Resolved via a card in the cell, i.e. this is a reorder in progress. */
      onCard: boolean;
    }
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
    onCard: data.ticketId !== undefined,
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

/** Cards register as droppables too; only they carry a `ticketId`. */
function isCard(container: DroppableContainer): boolean {
  return (container.data.current as TicketDragData | undefined)?.ticketId !== undefined;
}

function inCell(
  container: DroppableContainer,
  epicId: Id<"epics">,
  checkpointId: Id<"checkpoints">,
): boolean {
  const data = container.data.current as Partial<CellDropData> | undefined;
  return data?.epicId === epicId && data?.checkpointId === checkpointId;
}

/**
 * Hit testing for the board: one target per pointer position, decided in a fixed
 * order rather than by whichever droppable happens to rank first.
 *
 * Cards and cells overlap — a card sits inside the cell that also accepts drops —
 * so plain `pointerWithin` returned both and dnd-kit took whichever came first in
 * its distance-to-centre ranking. That ranking flips on a pixel of pointer
 * movement, and it flips again when the sort preview slides the cards under the
 * pointer, so `over` alternated between a card and the cell. The sort preview
 * follows a card target and the cell highlight follows a cell target, which is
 * how the two ended up blinking at each other. Two other symptoms came from the
 * same root: in the gap *between* two cards no card matched at all, and over
 * another epic's cell a card in that cell often won, so the red refusal never
 * appeared.
 *
 * The order is:
 *
 *  1. **The tray**, whenever the pointer is inside it. It floats over the matrix,
 *     so it would otherwise compete with the cell underneath.
 *  2. **A card of the source cell**, whenever the pointer is anywhere in that
 *     cell — chosen by `closestCenter` over that cell's cards, so a pointer in
 *     the gap between two cards still resolves to a card and the preview holds.
 *     dnd-kit measures droppable rects at drag start, so this ranking does not
 *     move as the preview shifts cards: same position, same answer.
 *  3. **A cell**, everywhere else. Cards outside the source cell are excluded
 *     from the running entirely: dnd-kit can only preview a shuffle inside the
 *     list being dragged in, so a card target there would promise a reorder the
 *     drop cannot honour.
 */
export const boardCollision: CollisionDetection = (args) => {
  const { active, droppableContainers } = args;

  const tray = droppableContainers.filter((c) => c.id === TRAY_DROP_ID);
  if (tray.length > 0) {
    const overTray = pointerWithin({ ...args, droppableContainers: tray });
    if (overTray.length > 0) return overTray;
  }

  const drag = ticketDragData(active);
  if (drag?.checkpointId) {
    const { epicId, checkpointId } = drag;
    const sourceCell = droppableContainers.filter(
      (c) => !isCard(c) && inCell(c, epicId, checkpointId),
    );
    const insideSourceCell = pointerWithin({
      ...args,
      droppableContainers: sourceCell,
    });
    if (insideSourceCell.length > 0) {
      const cards = droppableContainers.filter(
        (c) => isCard(c) && inCell(c, epicId, checkpointId),
      );
      return cards.length > 0
        ? closestCenter({ ...args, droppableContainers: cards })
        : insideSourceCell;
    }
  }

  const cells = droppableContainers.filter(
    (c) => !isCard(c) && c.id !== TRAY_DROP_ID,
  );
  return pointerWithin({ ...args, droppableContainers: cells });
};
