import { useQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

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
import { todayIso, weeksBefore } from "@/lib/dates";
import { api } from "../convex/_generated/api";

const NO_STATUS_FILTER: ReadonlySet<TicketStatus> = new Set();
const NO_ASSIGNEE_FILTER: ReadonlySet<string | null> = new Set();

/** Weeks shown on first paint, and how many more each scroll-up adds. */
const INITIAL_WEEKS = 8;
const LOAD_STEP_WEEKS = 8;

/** How close to the top counts as "asking for older weeks", in pixels. */
const LOAD_TRIGGER_PX = 240;

export default function App() {
  const today = useMemo(() => todayIso(), []);
  const [fromDate, setFromDate] = useState(() =>
    weeksBefore(todayIso(), INITIAL_WEEKS),
  );

  const live = useQuery(api.board.get, { fromDate });

  // Convex returns undefined while a new window loads. Keep painting the last
  // board so scrolling up widens the range instead of blanking the matrix.
  const lastBoard = useRef<typeof live>(undefined);
  if (live !== undefined) lastBoard.current = live;
  const board = live ?? lastBoard.current;
  const loadingOlder = live === undefined && lastBoard.current !== undefined;

  const scrollerRef = useRef<HTMLDivElement>(null);
  // Distance from the bottom, captured before older rows are prepended.
  const anchorFromBottom = useRef<number | null>(null);

  const loadOlder = useCallback(() => {
    const el = scrollerRef.current;
    if (el) anchorFromBottom.current = el.scrollHeight - el.scrollTop;
    setFromDate((current) => weeksBefore(current, LOAD_STEP_WEEKS));
  }, []);

  // Prepending rows grows the scroll height above the viewport, which would
  // otherwise throw the reader back down the page. Restore the same distance
  // from the bottom so the rows they were reading stay put.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || anchorFromBottom.current === null || live === undefined) return;
    el.scrollTop = el.scrollHeight - anchorFromBottom.current;
    anchorFromBottom.current = null;
  }, [live]);

  const handleScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el || !board?.hasOlder) return;
    if (anchorFromBottom.current !== null) return; // a widen is already in flight
    if (el.scrollTop < LOAD_TRIGGER_PX) loadOlder();
  }, [board?.hasOlder, loadOlder]);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] =
    useState<StatusFilter>(NO_STATUS_FILTER);
  const [assigneeFilter, setAssigneeFilter] =
    useState<AssigneeFilter>(NO_ASSIGNEE_FILTER);

  // Offer exactly the assignees present in the loaded window, so the menu can
  // never list someone with nothing to show. `null` covers unassigned tickets.
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
          <div
            ref={scrollerRef}
            onScroll={handleScroll}
            className="h-full overflow-auto rounded-2xl border border-slate-200 bg-white shadow-sm"
          >
            {board === undefined ? (
              <BoardStatus>載入中...</BoardStatus>
            ) : board.epics.length === 0 ? (
              <BoardStatus>
                尚無資料。執行{" "}
                <code className="font-mono">npm run import -- data/&lt;檔名&gt;.json</code>{" "}
                匯入看板內容。
              </BoardStatus>
            ) : (
              <>
                {board.hasOlder &&
                  (loadingOlder ? (
                    <div className="flex items-center justify-center gap-2 border-b border-slate-100 py-2 text-xs text-slate-400">
                      <Loader2 className="size-3 animate-spin" aria-hidden />
                      載入更早的週次...
                    </div>
                  ) : (
                    // A button, not just a hint: the board opens at scrollTop 0,
                    // where scrolling up fires no event, so the gesture alone
                    // would leave the reader unable to reach older weeks at all.
                    <button
                      type="button"
                      onClick={loadOlder}
                      className="w-full border-b border-slate-100 py-2 text-xs text-slate-400 hover:bg-slate-50 hover:text-slate-600"
                    >
                      載入更早的週次
                    </button>
                  ))}
                <BoardMatrix
                  epics={board.epics}
                  checkpoints={board.checkpoints}
                  tickets={visibleTickets}
                  today={today}
                />
              </>
            )}
          </div>
        </main>

        {board?.truncated && (
          <p className="border-t border-amber-200 bg-amber-50 px-6 py-2 text-xs text-amber-700">
            工單數量超過單次查詢上限,部分卡片未顯示。縮小時間範圍可以看到完整內容。
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
