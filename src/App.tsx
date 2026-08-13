import { useQuery } from "convex/react";
import { useMemo, useState } from "react";

import {
  BoardHeader,
  type AssigneeFilter,
  type StatusFilter,
} from "@/components/BoardHeader";
import { BoardMatrix } from "@/components/BoardMatrix";
import type { FilterOption } from "@/components/MultiSelectFilter";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { initials, matchesSearch, type TicketStatus } from "@/lib/board";
import { todayIso } from "@/lib/dates";
import { api } from "../convex/_generated/api";

const NO_STATUS_FILTER: ReadonlySet<TicketStatus> = new Set();
const NO_ASSIGNEE_FILTER: ReadonlySet<string | null> = new Set();

export default function App() {
  const board = useQuery(api.board.get);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] =
    useState<StatusFilter>(NO_STATUS_FILTER);
  const [assigneeFilter, setAssigneeFilter] =
    useState<AssigneeFilter>(NO_ASSIGNEE_FILTER);

  // Recomputed only when the data or the filters change, not on every render.
  const today = useMemo(() => todayIso(), []);

  // Offer exactly the assignees present on the board, so the menu can never
  // list someone with nothing to show. `null` covers unassigned tickets.
  const assigneeOptions = useMemo<FilterOption<string | null>[]>(() => {
    if (!board) return [];
    const names = new Set<string>();
    let hasUnassigned = false;
    for (const ticket of board.tickets) {
      if (ticket.assignee) names.add(ticket.assignee);
      else hasUnassigned = true;
    }

    const options: FilterOption<string | null>[] = [...names]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({
        value: name,
        label: name,
        icon: (
          <Avatar className="size-4">
            <AvatarFallback className="bg-[#7c2d12] text-[8px] font-semibold text-white">
              {initials(name)}
            </AvatarFallback>
          </Avatar>
        ),
      }));

    if (hasUnassigned) options.push({ value: null, label: "未指派" });
    return options;
  }, [board]);

  const visibleTickets = useMemo(() => {
    if (!board) return [];
    return board.tickets.filter(
      (ticket) =>
        matchesSearch(ticket, search) &&
        (statusFilter.size === 0 || statusFilter.has(ticket.status)) &&
        (assigneeFilter.size === 0 ||
          assigneeFilter.has(ticket.assignee ?? null)),
    );
  }, [board, search, statusFilter, assigneeFilter]);

  return (
    <TooltipProvider>
      <div className="flex h-dvh flex-col">
        <BoardHeader
          search={search}
          onSearchChange={setSearch}
          statusFilter={statusFilter}
          onStatusFilterChange={setStatusFilter}
          assigneeFilter={assigneeFilter}
          onAssigneeFilterChange={setAssigneeFilter}
          assigneeOptions={assigneeOptions}
          onReset={() => {
            setSearch("");
            setStatusFilter(NO_STATUS_FILTER);
            setAssigneeFilter(NO_ASSIGNEE_FILTER);
          }}
          visibleCount={visibleTickets.length}
          totalCount={board?.tickets.length ?? 0}
        />

        <main className="min-h-0 flex-1 p-4 md:p-6">
          <div className="h-full overflow-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
            {board === undefined ? (
              <BoardStatus>載入中...</BoardStatus>
            ) : board.epics.length === 0 ? (
              <BoardStatus>
                尚無資料。執行{" "}
                <code className="font-mono">npm run import -- data/&lt;檔名&gt;.json</code>{" "}
                匯入看板內容。
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
