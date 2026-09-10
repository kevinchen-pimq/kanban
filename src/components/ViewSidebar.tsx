import type { FunctionReturnType } from "convex/server";
import { LayoutList, Pencil, Plus } from "lucide-react";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

/** One saved 個人看板, exactly as `views:list` returns it. */
export type BoardView = FunctionReturnType<typeof api.views.list>[number];

/**
 * The left sidebar: everybody's personal boards, the caller's first.
 *
 * A row is a saved set of epics (see `convex/views.ts`); clicking it sets the
 * board's Epic 篩選 to that set and nothing else. 「全部 Epic」 is the fixed first
 * entry and means "no view selected", which is also where a hand-edited filter
 * or a deleted view lands.
 *
 * Only 我的看板 rows carry a pencil — `views:update` refuses anybody else's, so
 * offering the button on somebody else's row would be an affordance that only
 * ever produces an error. Everyone's rows are *visible* on purpose: the sidebar
 * doubles as "what is the team tracking".
 *
 * The selected row wears the same indigo tint + left border the matrix gives the
 * current week, so "you are here" looks the same in both places.
 */

const ROW =
  "group flex w-full items-center gap-2 rounded-md border-l-2 py-1.5 pr-1.5 pl-2 text-left text-xs";
const ROW_IDLE =
  "border-transparent text-slate-600 hover:bg-slate-50 hover:text-slate-900";
const ROW_ACTIVE = "border-indigo-500 bg-indigo-50 font-medium text-indigo-900";
const GROUP_LABEL =
  "flex items-center justify-between px-2 pt-3 pb-1 text-[11px] font-semibold text-slate-400";

export function ViewSidebar({
  views,
  selectedViewId,
  onSelectAll,
  onSelect,
  onCreate,
  onEdit,
}: {
  /** `undefined` while `views:list` is still loading. */
  views: readonly BoardView[] | undefined;
  selectedViewId: Id<"views"> | null;
  /** Pick 「全部 Epic」: no view, no epic filter. */
  onSelectAll: () => void;
  onSelect: (view: BoardView) => void;
  onCreate: () => void;
  onEdit: (view: BoardView) => void;
}) {
  const mine = (views ?? []).filter((view) => view.mine);
  // `views:list` already sorts by owner then name, so a group is a run of rows
  // with the same owner and this keeps that order.
  const others = new Map<string, BoardView[]>();
  for (const view of views ?? []) {
    if (view.mine) continue;
    const group = others.get(view.owner);
    if (group) group.push(view);
    else others.set(view.owner, [view]);
  }

  return (
    <aside className="flex w-56 shrink-0 flex-col overflow-y-auto border-r border-slate-200 bg-white">
      <nav className="p-2">
        <button
          type="button"
          onClick={onSelectAll}
          className={`${ROW} ${selectedViewId === null ? ROW_ACTIVE : ROW_IDLE}`}
        >
          <LayoutList className="size-3.5 shrink-0 opacity-60" aria-hidden />
          <span className="truncate">全部 Epic</span>
        </button>

        <p className={GROUP_LABEL}>
          我的看板
          <button
            type="button"
            onClick={onCreate}
            title="新增看板"
            aria-label="新增看板"
            className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-indigo-600"
          >
            <Plus className="size-3.5" aria-hidden />
          </button>
        </p>

        {views === undefined ? (
          <p className="px-2 py-1 text-[11px] text-slate-400">載入中...</p>
        ) : mine.length === 0 ? (
          <p className="px-2 py-1 text-[11px] leading-relaxed text-slate-400">
            還沒有看板，按 + 新增
          </p>
        ) : (
          mine.map((view) => (
            <ViewRow
              key={view._id}
              view={view}
              active={view._id === selectedViewId}
              onSelect={() => onSelect(view)}
              onEdit={() => onEdit(view)}
            />
          ))
        )}

        {[...others].map(([owner, group]) => (
          <div key={owner}>
            <p className={GROUP_LABEL}>{owner}</p>
            {group.map((view) => (
              <ViewRow
                key={view._id}
                view={view}
                active={view._id === selectedViewId}
                onSelect={() => onSelect(view)}
              />
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}

/**
 * One view. The pencil is only rendered when `onEdit` is given (i.e. it is
 * mine), and it stays invisible until the row is hovered or the button itself
 * is focused — so the list reads as names, and the keyboard still reaches it.
 */
function ViewRow({
  view,
  active,
  onSelect,
  onEdit,
}: {
  view: BoardView;
  active: boolean;
  onSelect: () => void;
  onEdit?: () => void;
}) {
  return (
    <div className={`${ROW} ${active ? ROW_ACTIVE : ROW_IDLE}`}>
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
      >
        <span className="truncate">{view.name}</span>
        <span className="shrink-0 text-[10px] text-slate-400 tabular-nums">
          {view.epicCodes.length} 個 Epic
        </span>
      </button>

      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          title="編輯看板"
          aria-label={`編輯看板 ${view.name}`}
          className="shrink-0 rounded p-0.5 text-slate-400 opacity-0 group-hover:opacity-100 hover:bg-slate-100 hover:text-indigo-600 focus-visible:opacity-100"
        >
          <Pencil className="size-3" aria-hidden />
        </button>
      )}
    </div>
  );
}
