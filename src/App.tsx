import { useQuery } from "convex/react";
import { useMemo, useState } from "react";

import { BoardHeader, type StatusFilter } from "@/components/BoardHeader";
import { BoardMatrix } from "@/components/BoardMatrix";
import { TooltipProvider } from "@/components/ui/tooltip";
import { matchesSearch, type TicketStatus } from "@/lib/board";
import { todayIso } from "@/lib/dates";
import { api } from "../convex/_generated/api";

/** Phase 1 shows a single owner's board; the filter chip is informational. */
const BOARD_OWNER = "frank";

const NO_STATUS_FILTER: ReadonlySet<TicketStatus> = new Set();

export default function App() {
  const board = useQuery(api.board.get);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] =
    useState<StatusFilter>(NO_STATUS_FILTER);

  // Recomputed only when the data or the filters change, not on every render.
  const today = useMemo(() => todayIso(), []);

  const visibleTickets = useMemo(() => {
    if (!board) return [];
    return board.tickets.filter(
      (ticket) =>
        matchesSearch(ticket, search) &&
        (statusFilter.size === 0 || statusFilter.has(ticket.status)),
    );
  }, [board, search, statusFilter]);

  return (
    <TooltipProvider>
      <div className="flex h-dvh flex-col">
        <BoardHeader
          search={search}
          onSearchChange={setSearch}
          statusFilter={statusFilter}
          onStatusFilterChange={setStatusFilter}
          onReset={() => {
            setSearch("");
            setStatusFilter(NO_STATUS_FILTER);
          }}
          visibleCount={visibleTickets.length}
          assignee={BOARD_OWNER}
        />

        <main className="min-h-0 flex-1 p-4 md:p-6">
          <div className="h-full overflow-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
            {board === undefined ? (
              <BoardStatus>載入中...</BoardStatus>
            ) : board.epics.length === 0 ? (
              <BoardStatus>
                尚無資料。執行 <code className="font-mono">npx convex run seed:run</code>{" "}
                建立看板內容。
              </BoardStatus>
            ) : (
              <BoardMatrix
                epics={board.epics}
                checkpoints={board.checkpoints}
                tickets={visibleTickets}
                today={today}
              />
            )}
          </div>
        </main>

        {board?.truncated && (
          <p className="border-t border-amber-200 bg-amber-50 px-6 py-2 text-xs text-amber-700">
            工單數量超過單次查詢上限,部分卡片未顯示。
          </p>
        )}
      </div>
    </TooltipProvider>
  );
}

function BoardStatus({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-10 text-sm text-slate-400">
      {children}
    </div>
  );
}
