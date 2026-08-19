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
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { AssigneeAvatar } from "@/components/AssigneeAvatar";
import { useSession } from "@/components/AuthProvider";
import {
  BoardActionsProvider,
  type BoardActions,
} from "@/components/BoardActionsProvider";
import { BoardConfigProvider } from "@/components/BoardConfigProvider";
import {
  BoardHeader,
  type AssigneeFilter,
  type EpicFilter,
  type StatusFilter,
} from "@/components/BoardHeader";
import { BoardMatrix } from "@/components/BoardMatrix";
import type { FilterOption } from "@/components/MultiSelectFilter";
import { StagingTray } from "@/components/StagingTray";
import { TicketCard } from "@/components/TicketCard";
import {
  TicketDialog,
  type TicketFormValues,
  type TicketTarget,
} from "@/components/TicketDialog";
import { UpdateNotice } from "@/components/UpdateNotice";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  matchesSearch,
  type Ticket,
  type TicketId,
  type TicketStatus,
} from "@/lib/board";
import { todayIso, weeksBefore } from "@/lib/dates";
import { loadFilters, saveFilters } from "@/lib/filters";
import {
  boardCollision,
  reorderedCell,
  resolveDropTarget,
  ticketDragData,
} from "@/lib/dnd";
import { scrollToCurrentWeek } from "@/lib/scroll";
import { useStatusCycle } from "@/hooks/useStatusCycle";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const NO_STATUS_FILTER: ReadonlySet<TicketStatus> = new Set();
const NO_ASSIGNEE_FILTER: ReadonlySet<string | null> = new Set();
const NO_EPIC_FILTER: ReadonlySet<string> = new Set();

/** Weeks shown on first paint, and how many more each scroll-up adds. */
const INITIAL_WEEKS = 8;
const LOAD_STEP_WEEKS = 8;

/** How close to the top counts as "asking for older weeks", in pixels. */
const LOAD_TRIGGER_PX = 240;

/** Pointer travel before a press turns into a drag, so a click stays a click. */
const DRAG_START_PX = 6;

/** A click this soon after a drop is the drop's own click, not a request. */
const CLICK_AFTER_DRAG_MS = 250;

/**
 * Auto-scroll while dragging, kept on a short leash.
 *
 * dnd-kit's defaults treat the outer 20% of the scroll container as "scroll me",
 * and the board's sticky header sits inside that band — so picking up a card
 * anywhere near the top made the matrix creep upwards under a still pointer,
 * sliding one cell after another beneath it. Measured: 474 → 352 of scrollTop
 * without the pointer moving, which is what made the drop indicators appear to
 * flicker between rows. A thin strip at the very edge still reaches an off-screen
 * week, and the staging tray covers the long journeys.
 *
 * Horizontal auto-scroll is off entirely: a card may only ever land in its own
 * epic column, so scrolling sideways during a drag can only take the reader away
 * from every legal target.
 */
const AUTO_SCROLL = {
  threshold: { x: 0, y: 0.08 },
  acceleration: 6,
} as const;

/**
 * The board itself, for a signed-in account.
 *
 * Mounted only from the `authenticated` branch of `App`, which is what lets every
 * call in here pass `auth` unconditionally and read the session without a null
 * check. It also means a credential that stops working unmounts this whole tree
 * rather than leaving `board:get` throwing inside it.
 */
export function BoardApp() {
  const { credentials: auth, canWrite, canRequest } = useSession();
  // Every affordance is offered to both, and every call is the same call; the
  // server turns it into a pending edit request when the account may only propose.
  const canEdit = canWrite || canRequest;
  const requestMode = canRequest && !canWrite;
  const today = useMemo(() => todayIso(), []);
  const [fromDate, setFromDate] = useState(() =>
    weeksBefore(todayIso(), INITIAL_WEEKS),
  );

  const live = useQuery(api.board.get, { auth, fromDate });

  // Convex returns undefined while a new window loads. Keep painting the last
  // board so scrolling up widens the range instead of blanking the matrix.
  const lastBoard = useRef<typeof live>(undefined);
  if (live !== undefined) lastBoard.current = live;
  const board = live ?? lastBoard.current;
  const loadingOlder = live === undefined && lastBoard.current !== undefined;

  // Both drop mutations patch the loaded windows before they are sent, so the
  // card is in its new place on the frame the pointer is released — dnd-kit drops
  // its transforms at that moment, and anything still holding the server's old
  // answer renders the card back where it started until the round trip lands.
  // Every window is patched (there is normally one) by reading the args back out
  // of the store, which also keeps the update correct after a widen.
  const moveTicket = useMutation(api.board.moveTicket).withOptimisticUpdate(
    (store, { ticketId, epicId, checkpointId }) => {
      for (const { args, value } of store.getAllQueries(api.board.get)) {
        if (!value) continue;

        // The card lands last in the target cell, which is what the server does
        // too. Without an order it would sort among the cards that have none and
        // appear mid-cell for a frame.
        const endOfCell = value.tickets.filter(
          (ticket) =>
            ticket.checkpointId === checkpointId &&
            ticket.epicId === epicId &&
            ticket._id !== ticketId,
        ).length;

        store.setQuery(api.board.get, args, {
          ...value,
          tickets: value.tickets.map((ticket) =>
            ticket._id === ticketId
              ? { ...ticket, checkpointId, order: endOfCell }
              : ticket,
          ),
        });
      }
    },
  );

  const reorderCell = useMutation(api.board.reorderCell).withOptimisticUpdate(
    (store, { ticketIds }) => {
      const orderById = new Map(ticketIds.map((id, index) => [id, index]));
      for (const { args, value } of store.getAllQueries(api.board.get)) {
        if (!value) continue;
        store.setQuery(api.board.get, args, {
          ...value,
          tickets: value.tickets.map((ticket) => {
            const order = orderById.get(ticket._id);
            return order === undefined ? ticket : { ...ticket, order };
          }),
        });
      }
    },
  );
  const createTicket = useMutation(api.board.createTicket);
  const updateTicket = useMutation(api.board.updateTicket);
  const deleteTicket = useMutation(api.board.deleteTicket);
  const withdrawRequest = useMutation(api.editRequests.withdraw);

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

  // The search box starts empty every time on purpose; the three filters below
  // are restored from the last visit. See `src/lib/filters.ts`.
  const [search, setSearch] = useState("");
  const stored = useRef(loadFilters()).current;
  const [epicFilter, setEpicFilter] = useState<EpicFilter>(
    () => new Set(stored.epics),
  );
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(
    () => new Set(stored.statuses),
  );
  const [assigneeFilter, setAssigneeFilter] = useState<AssigneeFilter>(
    () => new Set(stored.assignees),
  );

  useEffect(() => {
    saveFilters({
      epics: [...epicFilter],
      statuses: [...statusFilter],
      assignees: [...assigneeFilter],
    });
  }, [epicFilter, statusFilter, assigneeFilter]);

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

  // Epics are the columns, so this menu doubles as "which projects am I looking
  // at". Labelled with the code as well as the name, since the code is what the
  // payload and the Jira keys speak.
  const epicOptions = useMemo<FilterOption<string>[]>(
    () =>
      (board?.epics ?? []).map((epic) => ({
        value: epic.code,
        label: `${epic.code} · ${epic.name}`,
      })),
    [board],
  );

  // A remembered selection can name an epic or a person the board no longer has
  // — an epic removed from the board, someone who left. Those are dropped once
  // the board has actually loaded (never while it is still undefined, or the
  // restore would be undone before it took effect). Dropping them keeps the
  // stored value honest too: the next write no longer mentions them.
  useEffect(() => {
    if (!board) return;

    const codes = new Set(board.epics.map((epic) => epic.code));
    setEpicFilter((current) =>
      [...current].every((code) => codes.has(code))
        ? current
        : new Set([...current].filter((code) => codes.has(code))),
    );

    const names = new Set<string | null>(
      board.tickets.map((ticket) => ticket.assignee ?? null),
    );
    setAssigneeFilter((current) =>
      [...current].every((name) => names.has(name))
        ? current
        : new Set([...current].filter((name) => names.has(name))),
    );
  }, [board]);

  /** The columns to render: every epic, or just the ticked ones. */
  const visibleEpics = useMemo(
    () =>
      (board?.epics ?? []).filter(
        (epic) => epicFilter.size === 0 || epicFilter.has(epic.code),
      ),
    [board, epicFilter],
  );

  const visibleEpicIds = useMemo(
    () => new Set(visibleEpics.map((epic) => epic._id)),
    [visibleEpics],
  );

  const visibleTickets = useMemo(() => {
    if (!board) return [];
    return board.tickets.filter(
      (ticket) =>
        visibleEpicIds.has(ticket.epicId) &&
        matchesSearch(ticket, search) &&
        (statusFilter.size === 0 || statusFilter.has(ticket.status)) &&
        (assigneeFilter.size === 0 ||
          assigneeFilter.has(ticket.assignee ?? null)),
    );
  }, [board, visibleEpicIds, search, statusFilter, assigneeFilter]);

  // Clicking a status dot shows the new colour at once and writes once the
  // clicking stops; the override is applied here so the card, the tray chip and
  // the drag overlay all agree on what the dot says.
  const { cycleStatus, withPendingStatus } = useStatusCycle(
    useCallback(
      (ticketId, status) => updateTicket({ auth, ticketId, status }),
      [auth, updateTicket],
    ),
    auth,
  );

  // Cards lifted into the staging tray, oldest first. Client-side only: parking
  // a card writes nothing, it just takes the card out of the matrix until it is
  // dropped somewhere. Ids rather than documents, so the cards stay reactive.
  const [parkedIds, setParkedIds] = useState<readonly TicketId[]>([]);
  const [dragged, setDragged] = useState<Ticket | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [editing, setEditing] = useState<TicketTarget | null>(null);

  // A drag ends with a pointerup on the card, which the browser also reports as
  // a click. Without this the card would open its editor every time it is
  // dropped, so a click landing right after a drag is ignored.
  const lastDragEnd = useRef(0);

  const ticketsById = useMemo(() => {
    const map = new Map<TicketId, Ticket>();
    for (const ticket of withPendingStatus(board?.tickets ?? [])) {
      map.set(ticket._id, ticket);
    }
    return map;
  }, [board, withPendingStatus]);

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
    () =>
      withPendingStatus(visibleTickets).filter(
        (ticket) => !parked.has(ticket._id),
      ),
    [visibleTickets, parked, withPendingStatus],
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

  const failed = useCallback((what: string, error: unknown) => {
    setMoveError(
      `${what}:${error instanceof Error ? error.message : String(error)}`,
    );
  }, []);

  const handleDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      setDragged(null);
      lastDragEnd.current = Date.now();

      const drag = ticketDragData(active);
      if (!drag) return;

      const target = resolveDropTarget(over);
      if (!target) return; // dropped on empty space: nothing changes

      if (target.kind === "tray") {
        setParkedIds((current) =>
          current.includes(drag.ticketId) ? current : [...current, drag.ticketId],
        );
        return;
      }

      if (target.epicId !== drag.epicId) {
        // Rejected, so a card dragged from the tray stays parked.
        setMoveError("只能在同一個 Epic 的欄位內移動卡片,卡片沒有被移動。");
        return;
      }

      setMoveError(null);
      setParkedIds((current) => current.filter((id) => id !== drag.ticketId));

      const from = ticketsById.get(drag.ticketId)?.checkpointId;
      if (from === target.checkpointId) {
        // Same cell: this was a reorder. `over` is the card the pointer was on
        // when the drag ended, and dnd-kit's own indices say where that puts it.
        const ticketIds = over ? reorderedCell(active, over) : null;
        if (!ticketIds) return; // dropped on the cell itself, not on a card
        void reorderCell({
          auth,
          epicId: drag.epicId,
          checkpointId: target.checkpointId,
          ticketIds,
        }).catch((error: unknown) => failed("排序失敗", error));
        return;
      }

      void moveTicket({
        auth,
        ticketId: drag.ticketId,
        epicId: drag.epicId,
        checkpointId: target.checkpointId,
      }).catch((error: unknown) => failed("移動失敗", error));
    },
    [auth, failed, moveTicket, reorderCell, ticketsById],
  );

  const unpark = useCallback((ticket: Ticket) => {
    setParkedIds((current) => current.filter((id) => id !== ticket._id));
  }, []);

  const epicsById = useMemo(() => {
    const map = new Map<Id<"epics">, string>();
    for (const epic of board?.epics ?? []) map.set(epic._id, epic.name);
    return map;
  }, [board]);

  const actions = useMemo<BoardActions>(
    () => ({
      openCreate: (epicId, checkpointId) =>
        setEditing({
          mode: "create",
          epicId,
          checkpointId,
          epicName: epicsById.get(epicId) ?? "",
        }),
      openEdit: (ticket) => {
        // Ignore the click that ends a drag; see `lastDragEnd`.
        if (Date.now() - lastDragEnd.current < CLICK_AFTER_DRAG_MS) return;
        setEditing({
          mode: "edit",
          ticket,
          epicName: epicsById.get(ticket.epicId) ?? "",
        });
      },
      cycleStatus,
      checkpoints: board?.checkpoints ?? [],
      canEdit,
      requestMode,
      withdrawRequest: async (ticket) => {
        const requestId = ticket.pendingEdit?.requestId;
        if (requestId) await withdrawRequest({ auth, requestId });
      },
    }),
    [
      auth,
      board?.checkpoints,
      canEdit,
      cycleStatus,
      epicsById,
      requestMode,
      withdrawRequest,
    ],
  );

  // The form hands back strings; the mutations take the typed shape, with null
  // meaning "clear this field" so an emptied box actually empties the value.
  const submitTicket = useCallback(
    async (target: TicketTarget, values: TicketFormValues) => {
      const prs = values.githubPrs
        .map((url) => url.trim())
        .filter((url) => url !== "");

      if (target.mode === "create") {
        await createTicket({
          auth,
          title: values.title,
          epicId: target.epicId,
          checkpointId: values.checkpointId,
          key: values.key.trim() || undefined,
          status: values.status,
          assignee: values.assignee.trim() || undefined,
          dueDate: values.dueDate || undefined,
          tag: values.tag.trim() || undefined,
          githubPrs: prs.length > 0 ? prs : undefined,
        });
        return;
      }

      await updateTicket({
        auth,
        ticketId: target.ticket._id,
        title: values.title,
        checkpointId: values.checkpointId,
        status: values.status,
        assignee: values.assignee.trim() || null,
        dueDate: values.dueDate || null,
        tag: values.tag.trim() || null,
        githubPrs: prs.length > 0 ? prs : null,
      });
    },
    [auth, createTicket, updateTicket],
  );

  return (
    <TooltipProvider>
      {/* The config travels with the board query, so cards read it from context
          rather than through every component between here and the card. */}
      <BoardConfigProvider config={board?.config ?? null}>
       <BoardActionsProvider actions={actions}>
        <DndContext
          sensors={sensors}
          collisionDetection={boardCollision}
          autoScroll={AUTO_SCROLL}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setDragged(null)}
        >
          <div className="flex h-dvh flex-col">
            <BoardHeader
              search={search}
              onSearchChange={setSearch}
              epicFilter={epicFilter}
            onEpicFilterChange={setEpicFilter}
            epicOptions={epicOptions}
            statusFilter={statusFilter}
              onStatusFilterChange={setStatusFilter}
              assigneeFilter={assigneeFilter}
              onAssigneeFilterChange={setAssigneeFilter}
              assigneeOptions={assigneeOptions}
              onReset={() => {
                setSearch("");
                setEpicFilter(NO_EPIC_FILTER);
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
                      // Filtered epics, not all of them: an epic is a column, so
                      // unticking one takes its whole column out and the grid
                      // re-flows to the width of what is left.
                      epics={visibleEpics}
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

        {editing && (
          <TicketDialog
            // Remount per card, so the fields start from the card being opened.
            key={editing.mode === "edit" ? editing.ticket._id : "create"}
            target={editing}
            checkpoints={board?.checkpoints ?? []}
            assigneeSuggestions={assigneeOptions
              .map((option) => option.value)
              .filter((name): name is string => name !== null)}
            today={today}
            requestMode={requestMode}
            onClose={() => setEditing(null)}
            onSubmit={(values) => submitTicket(editing, values)}
            onDelete={async () => {
              if (editing.mode === "edit") {
                await deleteTicket({ auth, ticketId: editing.ticket._id });
              }
            }}
            onWithdraw={async () => {
              if (editing.mode === "edit") await actions.withdrawRequest(editing.ticket);
            }}
          />
        )}
       </BoardActionsProvider>
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
