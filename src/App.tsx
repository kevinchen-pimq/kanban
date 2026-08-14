import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useMutation, useQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import { AssigneeAvatar } from "@/components/AssigneeAvatar";
import { BoardConfigProvider } from "@/components/BoardConfigProvider";
import {
  BoardHeader,
  type AssigneeFilter,
  type StatusFilter,
} from "@/components/BoardHeader";
import { BoardMatrix } from "@/components/BoardMatrix";
import type { FilterOption } from "@/components/MultiSelectFilter";
import { StagingTray } from "@/components/StagingTray";
import { TicketCard } from "@/components/TicketCard";
import { UpdateNotice } from "@/components/UpdateNotice";
import { TooltipProvider } from "@/components/ui/tooltip";
import { matchesSearch, type Ticket, type TicketStatus } from "@/lib/board";
import { todayIso, weeksBefore } from "@/lib/dates";
import {
  cellDropData,
  ticketDragData,
  trayFirstCollision,
  TRAY_DROP_ID,
} from "@/lib/dnd";
import { scrollToCurrentWeek } from "@/lib/scroll";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const NO_STATUS_FILTER: ReadonlySet<TicketStatus> = new Set();
const NO_ASSIGNEE_FILTER: ReadonlySet<string | null> = new Set();

/** Weeks shown on first paint, and how many more each scroll-up adds. */
const INITIAL_WEEKS = 8;
const LOAD_STEP_WEEKS = 8;

/** How close to the top counts as "asking for older weeks", in pixels. */
const LOAD_TRIGGER_PX = 240;

/** Pointer travel before a press turns into a drag, so a click stays a click. */
const DRAG_START_PX = 6;

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

  // Patch the loaded windows the moment a card is dropped, so the card appears
  // in its new row on the same frame instead of after the server round trip.
  // Every window is patched (there is normally one) by reading the args back
  // out of the store, which also keeps the update correct after a widen.
  const moveTicket = useMutation(api.board.moveTicket).withOptimisticUpdate(
    (store, { ticketId, checkpointId }) => {
      for (const { args, value } of store.getAllQueries(api.board.get)) {
        if (!value) continue;
        store.setQuery(api.board.get, args, {
          ...value,
          tickets: value.tickets.map((ticket) =>
            ticket._id === ticketId ? { ...ticket, checkpointId } : ticket,
          ),
        });
      }
    },
  );

  const scrollerRef = useRef<HTMLDivElement>(null);
  // Distance from the bottom, captured before older rows are prepended.
  const anchorFromBottom = useRef<number | null>(null);

  const loadOlder = useCallback(() => {
    const el = scrollerRef.current;
    if (el) anchorFromBottom.current = el.scrollHeight - el.scrollTop;
    setFromDate((current) => weeksBefore(current, LOAD_STEP_WEEKS));
  }, []);

  // Open on the current week instead of the top of the window. The first eight
  // weeks loaded are mostly history, so landing at the top shows the oldest
  // rows first — the reader would have to scroll every time to reach the week
  // they actually came for. Runs once; afterwards the scroll position is theirs,
  // and the corner button is how they get back.
  const didInitialScroll = useRef(false);
  useLayoutEffect(() => {
    if (didInitialScroll.current || live === undefined) return;
    didInitialScroll.current = true;
    scrollToCurrentWeek(scrollerRef.current);
  }, [live]);

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
        icon: <AssigneeAvatar name={name} />,
      }));

    if (hasUnassigned) {
      options.push({
        value: null,
        label: "未指派",
        icon: <AssigneeAvatar name={null} />,
      });
    }
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

  // Cards lifted into the staging tray, oldest first. Client-side only: parking
  // a card writes nothing, it just takes the card out of the matrix until it is
  // dropped somewhere. Ids rather than documents, so the cards stay reactive.
  const [parkedIds, setParkedIds] = useState<readonly Id<"tickets">[]>([]);
  const [dragged, setDragged] = useState<Ticket | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);

  const ticketsById = useMemo(() => {
    const map = new Map<Id<"tickets">, Ticket>();
    for (const ticket of board?.tickets ?? []) map.set(ticket._id, ticket);
    return map;
  }, [board]);

  // Read from the whole window rather than the filtered set: a filter change
  // must not make a parked card vanish with no way to put it back.
  const parkedTickets = useMemo(
    () =>
      parkedIds
        .map((id) => ticketsById.get(id))
        .filter((ticket): ticket is Ticket => ticket !== undefined),
    [parkedIds, ticketsById],
  );

  const parked = useMemo(() => new Set(parkedIds), [parkedIds]);
  const gridTickets = useMemo(
    () => visibleTickets.filter((ticket) => !parked.has(ticket._id)),
    [visibleTickets, parked],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: DRAG_START_PX },
    }),
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      // A new attempt supersedes the last complaint, so it goes now rather than
      // hanging around under a board the reader has already moved on from.
      setMoveError(null);
      const drag = ticketDragData(event.active);
      setDragged(drag ? (ticketsById.get(drag.ticketId) ?? null) : null);
    },
    [ticketsById],
  );

  const handleDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      setDragged(null);
      const drag = ticketDragData(active);
      if (!drag || !over) return; // dropped on empty space: nothing changes

      if (over.id === TRAY_DROP_ID) {
        setParkedIds((current) =>
          current.includes(drag.ticketId) ? current : [...current, drag.ticketId],
        );
        return;
      }

      const cell = cellDropData(over);
      if (!cell) return;

      if (cell.epicId !== drag.epicId) {
        // Rejected, so a card dragged from the tray stays parked.
        setMoveError("只能在同一個 Epic 的欄位內移動卡片,卡片沒有被移動。");
        return;
      }

      setMoveError(null);
      setParkedIds((current) => current.filter((id) => id !== drag.ticketId));

      if (ticketsById.get(drag.ticketId)?.checkpointId === cell.checkpointId) {
        return; // dropped back where it came from
      }

      void moveTicket({
        ticketId: drag.ticketId,
        epicId: drag.epicId,
        checkpointId: cell.checkpointId,
      }).catch((error: unknown) => {
        setMoveError(
          `移動失敗:${error instanceof Error ? error.message : String(error)}`,
        );
      });
    },
    [moveTicket, ticketsById],
  );

  const unpark = useCallback((ticket: Ticket) => {
    setParkedIds((current) => current.filter((id) => id !== ticket._id));
  }, []);

  return (
    <TooltipProvider>
      {/* The config travels with the board query, so cards read it from context
          rather than through every component between here and the card. */}
      <BoardConfigProvider config={board?.config ?? null}>
        <DndContext
          sensors={sensors}
          collisionDetection={trayFirstCollision}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setDragged(null)}
        >
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

            {/* relative: the update notice floats against this box, which starts
              right below the header, so it needs no header-height constant. */}
          <main className="relative min-h-0 flex-1 p-4 md:p-6">
            <UpdateNotice />
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
                      tickets={gridTickets}
                      today={today}
                      onThisWeek={() =>
                        scrollToCurrentWeek(scrollerRef.current, "smooth")
                      }
                    />
                  </>
                )}
              </div>
            </main>

            {moveError && (
              <p className="border-t border-rose-200 bg-rose-50 px-6 py-2 text-xs text-rose-700">
                {moveError}
              </p>
            )}

            {board?.truncated && (
              <p className="border-t border-amber-200 bg-amber-50 px-6 py-2 text-xs text-amber-700">
                工單數量超過單次查詢上限,部分卡片未顯示。縮小時間範圍可以看到完整內容。
              </p>
            )}
          </div>

          {/* Mounted while a drag runs so it is there to catch the card, and for
              as long as it holds one. */}
          {(dragged !== null || parkedTickets.length > 0) && (
            <StagingTray parked={parkedTickets} onUnpark={unpark} />
          )}

          <DragOverlay dropAnimation={null}>
            {dragged && (
              <div className="w-[268px] rotate-1 cursor-grabbing opacity-95 shadow-lg">
                <TicketCard ticket={dragged} today={today} />
              </div>
            )}
          </DragOverlay>
        </DndContext>
      </BoardConfigProvider>
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
