import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type FilterOption<T> = {
  /** Stable identity. `null` is a legitimate value, e.g. "no assignee". */
  value: T;
  label: string;
  /** Optional leading mark, such as a status light. */
  icon?: ReactNode;
};

/**
 * Toolbar dropdown that filters by any number of values at once.
 *
 * An empty selection means "no filter" rather than "match nothing", so the
 * board opens showing everything and clearing the last tick restores that.
 */
export function MultiSelectFilter<T>({
  label,
  allLabel,
  clearLabel,
  options,
  selected,
  onChange,
}: {
  /** Accessible name for the trigger. */
  label: string;
  /** Trigger text when nothing is selected. */
  allLabel: string;
  /** Menu entry that clears the selection. */
  clearLabel: string;
  options: readonly FilterOption<T>[];
  selected: ReadonlySet<T>;
  onChange: (next: ReadonlySet<T>) => void;
}) {
  const toggle = (value: T) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  };

  const summary =
    selected.size === 0
      ? allLabel
      : options
          .filter((option) => selected.has(option.value))
          .map((option) => option.label)
          .join("、");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={label}
          className="h-8 max-w-64 justify-between gap-2 border-slate-300 bg-slate-50 text-xs font-normal"
        >
          <span className="truncate">{summary}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-50" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        {options.map((option) => (
          <DropdownMenuCheckboxItem
            key={String(option.value)}
            checked={selected.has(option.value)}
            // Keep the menu open so several values can be picked at once.
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={() => toggle(option.value)}
            className="text-xs"
          >
            <span className="flex items-center gap-2">
              {option.icon}
              {option.label}
            </span>
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-xs"
          disabled={selected.size === 0}
          onSelect={() => onChange(new Set())}
        >
          {clearLabel}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
