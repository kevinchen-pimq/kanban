import { Loader2, Trash2, Undo2 } from "lucide-react";
import { useState } from "react";

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
import {
  describeCheckpoints,
  STATUS_ORDER,
  STATUS_STYLES,
  type Checkpoint,
  type Ticket,
  type TicketStatus,
} from "@/lib/board";
import type { Id } from "../../convex/_generated/dataModel";

/** What the dialog is working on: a new card in one cell, or an existing card. */
export type TicketTarget =
  | {
      mode: "create";
      epicId: Id<"epics">;
      epicName: string;
      checkpointId: Id<"checkpoints">;
    }
  | { mode: "edit"; ticket: Ticket; epicName: string };

/** Fields the create call takes; `key` empty means "generate a LOCAL- one". */
export type TicketFormValues = {
  title: string;
  key: string;
  checkpointId: Id<"checkpoints">;
  status: TicketStatus;
  assignee: string;
  dueDate: string;
  tag: string;
  githubPrs: string[];
};

const FIELD = "flex flex-col gap-1";
const LABEL = "text-[11px] font-semibold text-slate-500";
const CONTROL =
  "h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-800 focus-visible:border-indigo-500 focus-visible:outline-none";

function initialValues(target: TicketTarget): TicketFormValues {
  if (target.mode === "create") {
    return {
      title: "",
      key: "",
      checkpointId: target.checkpointId,
      status: "todo",
      assignee: "",
      dueDate: "",
      tag: "",
      githubPrs: [],
    };
  }
  const { ticket } = target;
  return {
    title: ticket.title,
    key: ticket.key,
    checkpointId: ticket.checkpointId,
    status: ticket.status,
    assignee: ticket.assignee ?? "",
    dueDate: ticket.dueDate ?? "",
    tag: ticket.tag ?? "",
    githubPrs: ticket.githubPrs ?? [],
  };
}

/**
 * Create and edit form for a card, and the only place a card can be deleted.
 *
 * Two fields are shown but not editable, for the reasons the mutations enforce:
 * **epic**, because a card changing column would make the matrix lie about which
 * project the work belongs to (the same rule that refuses cross-epic drags), and
 * **key** on an existing card, because that is what an import matches on —
 * renaming it would strand the card and re-create it on the next sync.
 *
 * Remounted per target by a `key` in `App`, so the fields always start from the
 * card being opened rather than from whatever was typed last.
 */
export function TicketDialog({
  target,
  checkpoints,
  assigneeSuggestions,
  today,
  requestMode,
  onClose,
  onSubmit,
  onDelete,
  onWithdraw,
}: {
  target: TicketTarget;
  checkpoints: readonly Checkpoint[];
  /** Names already on the board, offered as autocomplete. */
  assigneeSuggestions: readonly string[];
  today: string;
  /**
   * True when this account proposes edits instead of making them
   * (`permEditRequest` without `permWrite`). Only the wording changes: the same
   * mutation is called either way, and the server decides what it means.
   */
  requestMode: boolean;
  onClose: () => void;
  onSubmit: (values: TicketFormValues) => Promise<void>;
  onDelete: () => Promise<void>;
  /** Drop the pending request on this card, restoring what the board really says. */
  onWithdraw: () => Promise<void>;
}) {
  const [values, setValues] = useState(() => initialValues(target));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const set = <K extends keyof TicketFormValues>(
    field: K,
    value: TicketFormValues[K],
  ) => setValues((current) => ({ ...current, [field]: value }));

  const rows = describeCheckpoints(checkpoints, today);
  const creating = target.mode === "create";
  const titleMissing = values.title.trim() === "";
  const pending = target.mode === "edit" ? target.ticket.pendingEdit : undefined;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onClose();
    } catch (caught: unknown) {
      // Convex prefixes thrown server errors; the readable part is enough here.
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message.replace(/^\[.*?\]\s*/, "").replace(/^Uncaught Error:\s*/, ""));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {requestMode
              ? creating
                ? "提議新增卡片"
                : "提議修改卡片"
              : creating
                ? "新增卡片"
                : "編輯卡片"}
          </DialogTitle>
          <DialogDescription>
            {target.epicName}
            {creating
              ? " · 手動建立的卡片在下一次完整重新匯入（pruneEpics）時會被刪除,payload 才是事實來源。"
              : " · Epic 與 Key 不能修改。"}
            {requestMode &&
              " 你的修改會先送去審核,通過之後才會出現在其他人的看板上。"}
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (titleMissing) return;
            void run(() => onSubmit(values));
          }}
        >
          <div className={FIELD}>
            <label className={LABEL} htmlFor="ticket-title">
              標題 <span className="text-rose-500">*</span>
            </label>
            <Input
              id="ticket-title"
              value={values.title}
              onChange={(event) => set("title", event.target.value)}
              placeholder="這張卡要做什麼"
              autoFocus
              className="h-8 text-xs md:text-xs"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className={FIELD}>
              <label className={LABEL} htmlFor="ticket-key">
                Key
              </label>
              <Input
                id="ticket-key"
                value={values.key}
                disabled={!creating}
                onChange={(event) => set("key", event.target.value)}
                placeholder="留空自動產生 LOCAL-n"
                className="h-8 font-mono text-xs disabled:bg-slate-50 disabled:text-slate-400 md:text-xs"
              />
            </div>

            <div className={FIELD}>
              <label className={LABEL} htmlFor="ticket-checkpoint">
                週次
              </label>
              <select
                id="ticket-checkpoint"
                className={CONTROL}
                value={values.checkpointId}
                onChange={(event) =>
                  set("checkpointId", event.target.value as Id<"checkpoints">)
                }
              >
                {rows.map((row) => (
                  <option key={row.checkpoint._id} value={row.checkpoint._id}>
                    {row.title} · {row.subtitle}
                  </option>
                ))}
              </select>
            </div>

            <div className={FIELD}>
              <label className={LABEL} htmlFor="ticket-status">
                狀態
              </label>
              <select
                id="ticket-status"
                className={CONTROL}
                value={values.status}
                onChange={(event) =>
                  set("status", event.target.value as TicketStatus)
                }
              >
                {STATUS_ORDER.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_STYLES[status].label}
                  </option>
                ))}
              </select>
            </div>

            <div className={FIELD}>
              <label className={LABEL} htmlFor="ticket-assignee">
                負責人
              </label>
              <Input
                id="ticket-assignee"
                list="ticket-assignee-options"
                value={values.assignee}
                onChange={(event) => set("assignee", event.target.value)}
                placeholder="留空為未指派"
                className="h-8 text-xs md:text-xs"
              />
              <datalist id="ticket-assignee-options">
                {assigneeSuggestions.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </div>

            <div className={FIELD}>
              <label className={LABEL} htmlFor="ticket-due">
                到期日
              </label>
              <input
                id="ticket-due"
                type="date"
                className={CONTROL}
                value={values.dueDate}
                onChange={(event) => set("dueDate", event.target.value)}
              />
            </div>

            <div className={FIELD}>
              <label className={LABEL} htmlFor="ticket-tag">
                標籤
              </label>
              <Input
                id="ticket-tag"
                value={values.tag}
                onChange={(event) => set("tag", event.target.value)}
                className="h-8 text-xs md:text-xs"
              />
            </div>
          </div>

          <div className={FIELD}>
            <label className={LABEL} htmlFor="ticket-prs">
              GitHub PR（一行一個網址）
            </label>
            <textarea
              id="ticket-prs"
              rows={2}
              className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 font-mono text-[11px] text-slate-800 focus-visible:border-indigo-500 focus-visible:outline-none"
              value={values.githubPrs.join("\n")}
              onChange={(event) =>
                set("githubPrs", event.target.value.split("\n"))
              }
              placeholder="https://github.com/org/repo/pull/123"
            />
          </div>

          {error && (
            <p className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1.5 text-[11px] text-rose-700">
              {error}
            </p>
          )}

          <DialogFooter>
            <div className="flex items-center gap-2">
              {/* The way back out of a proposal, on the card it is about. The
                  bell's 我的提議 list carries the same button for requests whose
                  card is not on screen — a proposed deletion, for one. */}
              {pending && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run(onWithdraw)}
                  className="h-7 gap-1.5 border-amber-300 px-2 text-xs text-amber-800 hover:bg-amber-50"
                >
                  <Undo2 className="size-3" aria-hidden />
                  撤回提議
                </Button>
              )}
              {!creating &&
                (confirmingDelete ? (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-rose-600">
                      {requestMode ? "確定提議刪除?" : "確定刪除?"}
                    </span>
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
                    刪除
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
                disabled={busy || titleMissing}
                className="h-7 gap-1.5 bg-indigo-600 px-3 text-xs hover:bg-indigo-700"
              >
                {busy && <Loader2 className="size-3 animate-spin" aria-hidden />}
                {requestMode
                  ? creating
                    ? "提議新增"
                    : "提議修改"
                  : creating
                    ? "建立"
                    : "儲存"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
