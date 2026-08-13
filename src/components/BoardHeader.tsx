import { ChevronDown, LayoutGrid, RotateCcw, Search } from "lucide-react";

import { StatusDot } from "@/components/StatusDot";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { initials, STATUS_ORDER, STATUS_STYLES, type TicketStatus } from "@/lib/board";

/** An empty selection means "no status filter", i.e. every status is shown. */
export type StatusFilter = ReadonlySet<TicketStatus>;

/** Two 52px tiers plus a hairline, matching the requested 105px header. */
const TIER = "flex h-[52px] shrink-0 items-center gap-3 px-6";

export function BoardHeader({
  search,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  onReset,
  visibleCount,
  assignee,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  statusFilter: StatusFilter;
  onStatusFilterChange: (value: StatusFilter) => void;
  onReset: () => void;
  visibleCount: number;
  assignee: string;
}) {
  const toggleStatus = (status: TicketStatus) => {
    const next = new Set(statusFilter);
    if (next.has(status)) next.delete(status);
    else next.add(status);
    onStatusFilterChange(next);
  };

  const selectedLabel =
    statusFilter.size === 0
      ? "所有狀態 (All Status)"
      : STATUS_ORDER.filter((status) => statusFilter.has(status))
          .map((status) => STATUS_STYLES[status].shortLabel)
          .join("、");

  return (
    <header className="h-[105px] shrink-0 border-b border-slate-200 bg-white">
      <div className={TIER}>
        <div className="rounded-lg bg-indigo-600 p-1.5 text-white shadow-sm">
          <LayoutGrid className="size-[18px]" aria-hidden />
        </div>
        <h1 className="truncate text-xl font-bold tracking-tight text-slate-900">
          Epic × Checkpoint 看板
        </h1>
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

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                aria-label="狀態篩選"
                className="h-8 max-w-64 justify-between gap-2 border-slate-300 bg-slate-50 text-xs font-normal"
              >
                <span className="truncate">{selectedLabel}</span>
                <ChevronDown className="size-3.5 shrink-0 opacity-50" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-60">
              {STATUS_ORDER.map((status) => (
                <DropdownMenuCheckboxItem
                  key={status}
                  checked={statusFilter.has(status)}
                  // Keep the menu open so several statuses can be picked at once.
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={() => toggleStatus(status)}
                  className="text-xs"
                >
                  <span className="flex items-center gap-2">
                    <StatusDot status={status} />
                    {STATUS_STYLES[status].label}
                  </span>
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-xs"
                disabled={statusFilter.size === 0}
                onSelect={() => onStatusFilterChange(new Set())}
              >
                顯示所有狀態
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 shadow-sm">
            <Avatar className="size-5">
              <AvatarFallback className="bg-[#7c2d12] text-[9px] font-semibold text-white">
                {initials(assignee)}
              </AvatarFallback>
            </Avatar>
            <span className="text-xs font-medium text-slate-700">{assignee}</span>
            <span className="ml-1 rounded-full bg-slate-100 px-1.5 text-[10px] text-slate-600">
              {visibleCount}
            </span>
          </div>
        </div>

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
    </header>
  );
}
