import type { Doc } from "../../convex/_generated/dataModel";
import { formatMonthDay, isBefore } from "./dates";

export type Epic = Doc<"epics">;
export type Checkpoint = Doc<"checkpoints">;
export type Ticket = Doc<"tickets">;
export type TicketStatus = Ticket["status"];
export type EpicAccent = Epic["accent"];

/** Order the status filter and legend are presented in. */
export const STATUS_ORDER = ["todo", "doing", "testing", "done"] as const;

type StatusStyle = {
  /** Full label, used by the legend and the card's dot tooltip. */
  label: string;
  /** Label with its colour cue, used inside the filter dropdown. */
  filterLabel: string;
  /** Classes for the coloured status dot. */
  dot: string;
  /** Border colour a card takes on hover. */
  cardHover: string;
};

export const STATUS_STYLES: Record<TicketStatus, StatusStyle> = {
  todo: {
    label: "To Do / Backlog",
    filterLabel: "⚪ To Do / Backlog",
    dot: "bg-slate-400 ring-2 ring-slate-200",
    cardHover: "hover:border-slate-400",
  },
  doing: {
    label: "Doing",
    filterLabel: "🔵 Doing",
    dot: "bg-blue-500 ring-2 ring-blue-200 animate-pulse",
    cardHover: "hover:border-blue-400",
  },
  testing: {
    label: "Testing & Review / Dev Done",
    filterLabel: "🟡 Testing / Dev Done",
    dot: "bg-amber-400 ring-2 ring-amber-200",
    cardHover: "hover:border-amber-400",
  },
  done: {
    label: "Dev Test Done / Done",
    filterLabel: "🟢 Done / Test Done",
    dot: "bg-emerald-500 ring-2 ring-emerald-200",
    cardHover: "hover:border-emerald-400",
  },
};

/**
 * Epic badge palettes. Written as whole class strings rather than composed from
 * the accent name so Tailwind's scanner can see every class it must emit.
 */
export const EPIC_ACCENT_CLASSES: Record<EpicAccent, string> = {
  indigo: "bg-indigo-100 text-indigo-700 border-indigo-200",
  purple: "bg-purple-100 text-purple-700 border-purple-200",
  cyan: "bg-cyan-100 text-cyan-700 border-cyan-200",
  emerald: "bg-emerald-100 text-emerald-700 border-emerald-200",
};

/** Where a checkpoint sits relative to today. */
export type CheckpointPhase =
  | "past"
  | "previous"
  | "current"
  | "next"
  | "future"
  | "backlog";

const PHASE_BADGES: Record<CheckpointPhase, string> = {
  past: "已過週次",
  previous: "前週完成",
  current: "本週主推",
  next: "下週預計",
  future: "未來週次",
  backlog: "長期待辦",
};

export type CheckpointView = {
  checkpoint: Checkpoint;
  phase: CheckpointPhase;
  /** Bold row title, e.g. "W32". */
  title: string;
  /** Muted row subtitle, e.g. "Checkpoint (08/11 - 08/17)". */
  subtitle: string;
  badge: string;
};

/**
 * Label each checkpoint row against today's date.
 *
 * "前週完成" and "下週預計" are assigned by adjacency to today rather than by a
 * fixed offset, so the board still reads correctly when weeks are missing or
 * when today falls in a gap between two checkpoints.
 */
export function describeCheckpoints(
  checkpoints: readonly Checkpoint[],
  today: string,
): CheckpointView[] {
  const phases = new Map<string, CheckpointPhase>();

  let previousId: string | undefined;
  let previousEnd: string | undefined;
  let nextId: string | undefined;
  let nextStart: string | undefined;

  for (const checkpoint of checkpoints) {
    if (checkpoint.kind === "backlog") {
      phases.set(checkpoint._id, "backlog");
      continue;
    }

    const { startDate, endDate } = checkpoint;
    if (!startDate || !endDate) {
      phases.set(checkpoint._id, "future");
      continue;
    }

    if (isBefore(today, startDate)) {
      phases.set(checkpoint._id, "future");
      if (nextStart === undefined || isBefore(startDate, nextStart)) {
        nextStart = startDate;
        nextId = checkpoint._id;
      }
    } else if (isBefore(endDate, today)) {
      phases.set(checkpoint._id, "past");
      if (previousEnd === undefined || isBefore(previousEnd, endDate)) {
        previousEnd = endDate;
        previousId = checkpoint._id;
      }
    } else {
      phases.set(checkpoint._id, "current");
    }
  }

  if (previousId) phases.set(previousId, "previous");
  if (nextId) phases.set(nextId, "next");

  return checkpoints.map((checkpoint) => {
    const phase = phases.get(checkpoint._id) ?? "future";

    if (checkpoint.kind !== "week") {
      // A backlog label like "未定排程 / Backlog Pool" carries both halves of
      // the row heading, so split it rather than repeating the whole string.
      const [title, ...rest] = (checkpoint.label ?? "Backlog").split(" / ");
      return {
        checkpoint,
        phase,
        title,
        subtitle: rest.join(" / ") || "Backlog Pool",
        badge: PHASE_BADGES[phase],
      };
    }

    const range =
      checkpoint.startDate && checkpoint.endDate
        ? `${formatMonthDay(checkpoint.startDate)} - ${formatMonthDay(checkpoint.endDate)}`
        : undefined;

    return {
      checkpoint,
      phase,
      title: `W${checkpoint.weekNumber}`,
      subtitle: range ? `Checkpoint (${range})` : "Checkpoint",
      badge: PHASE_BADGES[phase],
    };
  });
}

/**
 * A card is overdue when its due date has passed and the work is not finished.
 * Derived rather than stored, so the board never shows a stale red badge.
 */
export function isOverdue(ticket: Ticket, today: string): boolean {
  if (!ticket.dueDate) return false;
  if (ticket.status === "done") return false;
  return isBefore(ticket.dueDate, today);
}

/** Case-insensitive match against the ticket key and title, as in the PoC. */
export function matchesSearch(ticket: Ticket, search: string): boolean {
  if (!search) return true;
  const needle = search.toLowerCase();
  return (
    ticket.key.toLowerCase().includes(needle) ||
    ticket.title.toLowerCase().includes(needle)
  );
}

/** Initials for the assignee avatar, e.g. "KC". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
