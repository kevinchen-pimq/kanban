import { createContext, useContext, type ReactNode } from "react";

import type { Checkpoint, Ticket } from "@/lib/board";
import type { Id } from "../../convex/_generated/dataModel";

/**
 * The board's editing actions, reachable from any card or cell.
 *
 * Same reason as `BoardConfigProvider`: cards sit four levels below `App` and are
 * rendered again in the tray and the drag overlay, so passing three callbacks
 * down by hand would put them on every component in between as pure transport.
 * `App` owns the dialog and the pending-status state; this only carries the
 * handles to it.
 */
export type BoardActions = {
  /** Open the create form for one cell, with epic and week filled in. */
  openCreate: (epicId: Id<"epics">, checkpointId: Id<"checkpoints">) => void;
  /** Open the edit form for a card. Ignored right after a drag. */
  openEdit: (ticket: Ticket) => void;
  /** Advance a card's status one step; the write is debounced. */
  cycleStatus: (ticket: Ticket) => void;
  /** Rows the edit form can move a card to. */
  checkpoints: readonly Checkpoint[];
};

const noop: BoardActions = {
  openCreate: () => {},
  openEdit: () => {},
  cycleStatus: () => {},
  checkpoints: [],
};

const BoardActionsContext = createContext<BoardActions>(noop);

export function BoardActionsProvider({
  actions,
  children,
}: {
  actions: BoardActions;
  children: ReactNode;
}) {
  return (
    <BoardActionsContext.Provider value={actions}>
      {children}
    </BoardActionsContext.Provider>
  );
}

export function useBoardActions(): BoardActions {
  return useContext(BoardActionsContext);
}
