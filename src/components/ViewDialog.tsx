import { Loader2, Trash2 } from "lucide-react";
import { useState } from "react";

import type { BoardView } from "@/components/ViewSidebar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { FilterOption } from "@/components/MultiSelectFilter";

/** Creating a new personal board, or editing one of mine. */
export type ViewTarget = { mode: "create" } | { mode: "edit"; view: BoardView };

const LABEL = "text-[11px] font-semibold text-slate-500";

/**
 * Create / rename / delete one 個人看板.
 *
 * A view is only two things — a name and a set of epics — so the form is those
 * two, ticked from the same `CODE · 名稱` list the Epic 篩選 offers (the codes are
 * what the payload and the Jira keys speak). Deleting lives here rather than on
 * the sidebar row, following `TicketDialog`: destructive actions ask twice, and
 * the second press is a button that says 刪除.
 *
 * Errors are shown inline. The mutations throw readable Chinese — a duplicate
 * name, an epic the board no longer has — and those sentences are the answer the
 * person needs, not something to leave in the console.
 */
export function ViewDialog({
  target,
  epicOptions,
  onClose,
  onSubmit,
  onDelete,
}: {
  target: ViewTarget;
  /** The board's epics, labelled exactly as the Epic 篩選 labels them. */
  epicOptions: readonly FilterOption<string>[];
  onClose: () => void;
  onSubmit: (values: { name: string; epicCodes: string[] }) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const creating = target.mode === "create";
  const [name, setName] = useState(() =>
    target.mode === "edit" ? target.view.name : "",
  );
  const [codes, setCodes] = useState<ReadonlySet<string>>(
    () => new Set(target.mode === "edit" ? target.view.epicCodes : []),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const toggle = (code: string) => {
    const next = new Set(codes);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    setCodes(next);
  };

  const incomplete = name.trim() === "" || codes.size === 0;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onClose();
    } catch (caught: unknown) {
      // Convex prefixes thrown server errors; the readable part is enough here.
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(
        message.replace(/^\[.*?\]\s*/, "").replace(/^Uncaught Error:\s*/, ""),
      );
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{creating ? "新增看板" : "編輯看板"}</DialogTitle>
          <DialogDescription>
            選幾個 Epic 存成自己的看板。看板只是一組欄位的選擇,不會改到卡片,
            也不需要審核;每個人都看得到彼此的看板,但只有自己能修改。
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (incomplete) return;
            void run(() => onSubmit({ name, epicCodes: [...codes] }));
          }}
        >
          <div className="flex flex-col gap-1">
            <label className={LABEL} htmlFor="view-name">
              名稱 <span className="text-rose-500">*</span>
            </label>
            <Input
              id="view-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如:我追的 Epic"
              maxLength={40}
              autoFocus
              className="h-8 text-xs md:text-xs"
            />
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className={LABEL}>
                Epic <span className="text-rose-500">*</span>
              </span>
              <span className="flex items-center gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setCodes(new Set(epicOptions.map((option) => option.value)))
                  }
                  className="h-6 px-1.5 text-[11px] text-slate-500"
                >
                  全選
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setCodes(new Set())}
                  className="h-6 px-1.5 text-[11px] text-slate-500"
                >
                  清除
                </Button>
              </span>
            </div>

            <div className="grid max-h-56 gap-0.5 overflow-y-auto rounded-md border border-slate-200 p-1.5">
              {epicOptions.length === 0 ? (
                <p className="px-1 py-1 text-[11px] text-slate-400">
                  看板上還沒有 Epic。
                </p>
              ) : (
                epicOptions.map((option) => (
                  <label
                    key={option.value}
                    className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs text-slate-700 hover:bg-slate-50"
                  >
                    <input
                      type="checkbox"
                      checked={codes.has(option.value)}
                      onChange={() => toggle(option.value)}
                      className="size-3.5 accent-indigo-600"
                    />
                    <span className="truncate">{option.label}</span>
                  </label>
                ))
              )}
            </div>
          </div>

          {error && (
            <p className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1.5 text-[11px] text-rose-700">
              {error}
            </p>
          )}

          <DialogFooter>
            <div className="flex items-center gap-2">
              {!creating &&
                (confirmingDelete ? (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-rose-600">確定刪除?</span>
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy}
                      onClick={() => void run(onDelete)}
                      className="h-7 bg-rose-600 px-2 text-xs hover:bg-rose-700"
                    >
                      刪除
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmingDelete(false)}
                      className="h-7 px-2 text-xs"
                    >
                      取消
                    </Button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmingDelete(true)}
                    className="h-7 gap-1.5 px-2 text-xs text-slate-500 hover:text-rose-600"
                  >
                    <Trash2 className="size-3" aria-hidden />
                    刪除看板
                  </Button>
                ))}
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={onClose}
                className="h-7 px-2 text-xs"
              >
                取消
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={busy || incomplete}
                className="h-7 gap-1.5 bg-indigo-600 px-3 text-xs hover:bg-indigo-700"
              >
                {busy && <Loader2 className="size-3 animate-spin" aria-hidden />}
                {creating ? "建立" : "儲存"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
