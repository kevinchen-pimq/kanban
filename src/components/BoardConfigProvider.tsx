import { createContext, useContext, type ReactNode } from "react";

import type { BoardConfig } from "@/lib/board";

/**
 * The board's Convex config, available to any card without threading it through
 * the matrix.
 *
 * Cards sit four levels below `App` (matrix → cell → draggable → card) and the
 * tray renders them again elsewhere, so passing the config down by hand would
 * mean the same prop on every component in between purely as transport. It
 * arrives with `board:get`, so there is no separate fetch behind this.
 *
 * `null` means this deployment has no config document yet: avatars fall back to
 * hashed colours and ticket keys render without a Jira link.
 */
const BoardConfigContext = createContext<BoardConfig | null>(null);

export function BoardConfigProvider({
  config,
  children,
}: {
  config: BoardConfig | null;
  children: ReactNode;
}) {
  return (
    <BoardConfigContext.Provider value={config}>
      {children}
    </BoardConfigContext.Provider>
  );
}

export function useBoardConfig(): BoardConfig | null {
  return useContext(BoardConfigContext);
}
