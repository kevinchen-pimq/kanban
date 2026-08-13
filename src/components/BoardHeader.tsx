import { Info, LayoutGrid, RotateCcw, Search } from "lucide-react";

import { StatusDot } from "@/components/StatusDot";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  initials,
  STATUS_ORDER,
  STATUS_STYLES,
  type TicketStatus,
} from "@/lib/board";

export type StatusFilter = TicketStatus | "ALL";

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
  return (
    <header className="border-b border-slate-200 bg-white px-6 py-4 shadow-sm">
      <div className="flex max-w-full flex-col justify-between gap-4 md:flex-row md:items-center">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-indigo-600 p-2 text-white shadow">
            <LayoutGrid className="size-[18px]" aria-hidden />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">
              Epic × Checkpoint 看板
            </h1>
            <p className="text-xs text-slate-500">
              以 Epic 為欄、週 Checkpoint 為列的全新可視化模式
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4 rounded-xl border border-slate-200 bg-slate-50 p-2.5 text-xs">
          <span className="mr-1 flex items-center gap-1 font-semibold text-slate-600">
            <Info className="size-3.5 text-slate-400" aria-hidden />
            狀態指示燈:
          </span>
          {STATUS_ORDER.map((status) => (
            <div key={status} className="flex items-center gap-1.5">
              <StatusDot status={status} />
              <span className="font-medium text-slate-700">
                {STATUS_STYLES[status].label}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3 text-sm">
        <div className="flex flex-wrap items-center gap-3">
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

          <Select
            value={statusFilter}
            onValueChange={(value) => onStatusFilterChange(value as StatusFilter)}
          >
            <SelectTrigger
              size="sm"
              aria-label="狀態篩選"
              className="border-slate-300 bg-slate-50 text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">所有狀態 (All Status)</SelectItem>
              {STATUS_ORDER.map((status) => (
                <SelectItem key={status} value={status}>
                  {STATUS_STYLES[status].filterLabel}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

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
