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
  /**
   * Whether the signed-in account may reach for an editing affordance at all
   * (`permWrite` **or** `permEditRequest`).
   *
   * It travels with the actions because it decides whether they are offered:
   * without it a read-only reader would see a "+" in every cell, a pointer cursor
   * on every card and a clickable status dot, all of which the server would then
   * refuse. This hides the affordances; `convex/auth.ts` is what actually stops
   * the write.
   */
  canEdit: boolean;
  /**
   * True when those affordances propose rather than apply (`permEditRequest`
   * without `permWrite`).
   *
   * Nothing about *how* the board calls the server changes — the same mutations
   * with the same arguments — so this only affects wording: a card badge saying
   * the change is waiting, and a dialog that says "提議" instead of "儲存".
   */
  requestMode: boolean;
  /** Take back the pending request on a card. Only meaningful in request mode. */
  withdrawRequest: (ticket: Ticket) => Promise<void>;
};

const noop: BoardActions = {
  openCreate: () => {},
  openEdit: () => {},
  cycleStatus: () => {},
  checkpoints: [],
  canEdit: false,
  requestMode: false,
  withdrawRequest: async () => {},
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
