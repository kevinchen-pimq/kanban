import { LayoutGrid, RotateCcw, Search } from "lucide-react";

import { AccountBar } from "@/components/AccountBar";
import {
  MultiSelectFilter,
  type FilterOption,
} from "@/components/MultiSelectFilter";
import { StatusDot } from "@/components/StatusDot";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { STATUS_ORDER, STATUS_STYLES, type TicketStatus } from "@/lib/board";

/** An empty selection means "no filter", i.e. every value is shown. */
export type StatusFilter = ReadonlySet<TicketStatus>;
/** `null` stands for tickets with no assignee. */
export type AssigneeFilter = ReadonlySet<string | null>;
/** Epic `code`s, not ids: the selection is remembered across imports. */
export type EpicFilter = ReadonlySet<string>;

/** Two 52px tiers plus a hairline, matching the requested 105px header. */
const TIER = "flex h-[52px] shrink-0 items-center gap-3 px-6";

const STATUS_OPTIONS: FilterOption<TicketStatus>[] = STATUS_ORDER.map(
  (status) => ({
    value: status,
    label: STATUS_STYLES[status].label,
    icon: <StatusDot status={status} />,
  }),
);

export function BoardHeader({
  search,
  onSearchChange,
  epicFilter,
  onEpicFilterChange,
  epicOptions,
  statusFilter,
  onStatusFilterChange,
  assigneeFilter,
  onAssigneeFilterChange,
  assigneeOptions,
  onReset,
  visibleCount,
  totalCount,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  epicFilter: EpicFilter;
  onEpicFilterChange: (value: EpicFilter) => void;
  epicOptions: readonly FilterOption<string>[];
  statusFilter: StatusFilter;
  onStatusFilterChange: (value: StatusFilter) => void;
  assigneeFilter: AssigneeFilter;
  onAssigneeFilterChange: (value: AssigneeFilter) => void;
  assigneeOptions: readonly FilterOption<string | null>[];
  onReset: () => void;
  visibleCount: number;
  totalCount: number;
}) {
  const filtered = visibleCount !== totalCount;

  return (
    <header className="h-[105px] shrink-0 border-b border-slate-200 bg-white">
      <div className={`${TIER} justify-between`}>
        <div className="flex min-w-0 items-center gap-3">
          <div className="rounded-lg bg-indigo-600 p-1.5 text-white shadow-sm">
            <LayoutGrid className="size-[18px]" aria-hidden />
          </div>
          <h1 className="truncate text-xl font-bold tracking-tight text-slate-900">
            Epic × Checkpoint 看板
          </h1>
        </div>

        {/* Reads the session from context rather than taking props: the account
            bar is about who is looking at the board, not about the board. */}
        <AccountBar />
      </div>

      <div className="mx-6 border-t border-slate-100" />

      <div className={`${TIER} justify-between`}>
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-3 -translate-y-1/2 text-slate-400"
              aria-hidden
            />
            <Input
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="搜尋 Key 或 Title..."
              aria-label="搜尋 Key 或 Title"
              className="h-8 w-52 border-slate-300 bg-slate-50 pr-3 pl-8 text-xs md:text-xs"
            />
          </div>

          {/* Epics are the board's columns, so this filter is also how the
              matrix is narrowed to the projects someone actually works on. */}
          <MultiSelectFilter
            label="Epic 篩選"
            allLabel="所有 Epic (All Epics)"
            clearLabel="顯示所有 Epic"
            options={epicOptions}
            selected={epicFilter}
            onChange={onEpicFilterChange}
          />

          <MultiSelectFilter
            label="狀態篩選"
            allLabel="所有狀態 (All Status)"
            clearLabel="顯示所有狀態"
            options={STATUS_OPTIONS}
            selected={statusFilter}
            onChange={onStatusFilterChange}
          />

          <MultiSelectFilter
            label="負責人篩選"
            allLabel="所有負責人 (All Assignees)"
            clearLabel="顯示所有負責人"
            options={assigneeOptions}
            selected={assigneeFilter}
            onChange={onAssigneeFilterChange}
          />
        </div>

        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-500 tabular-nums">
            {filtered ? `${visibleCount} / ${totalCount}` : totalCount} 張
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={onReset}
            className="h-auto px-2 py-1 text-xs font-medium text-slate-500 hover:text-indigo-600"
          >
            <RotateCcw className="size-3" aria-hidden />
            重置篩選
          </Button>
        </div>
      </div>
    </header>
  );
}
