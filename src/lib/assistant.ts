import type { FunctionReturnType } from "convex/server";

import type { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { TicketId } from "./board";

/**
 * The board assistant's client half: reading a command and turning it into a call.
 *
 * A command names things the way a person and an agent can: cards by **key**,
 * columns by epic **code**, rows by **week number**. The board's mutations want
 * Convex ids. Resolving one into the other is this module's whole job, and it
 * happens *here*, in the browser, because that is where the credential that may
 * make the change lives — the agent never learns an id, and never gets a path to
 * the board that does not pass through the user's own permissions.
 *
 * A name that matches nothing is not something to guess at: it fails the command
 * with a reason the agent can read and correct (`docs/architecture.md`).
 */

type ThreadMessage = FunctionReturnType<typeof api.messages.thread>[number];

/** One chat message as the window renders it. */
export type ChatMessage = ThreadMessage;

/** The structured half of an agent command message. */
export type AssistantCommand = NonNullable<ThreadMessage["command"]>;

/** Where a command wants a card: a week number, or the undated backlog pool. */
export type CheckpointRef = number | "backlog";

/**
 * What resolving needs from the board — structurally what `board:get` returns, so
 * the executor can hand its query result straight over.
 */
export type AssistantBoard = {
  epics: readonly { _id: Id<"epics">; code: string }[];
  checkpoints: readonly {
    _id: Id<"checkpoints">;
    kind: "week" | "backlog";
    weekNumber?: number;
  }[];
  tickets: readonly {
    _id: TicketId;
    key: string;
    epicId: Id<"epics">;
    checkpointId: Id<"checkpoints">;
  }[];
};

/** A command with every name resolved: ready to be sent to a `board:*` mutation. */
export type ResolvedCommand =
  | {
      kind: "moveTicket";
      ticketId: TicketId;
      epicId: Id<"epics">;
      checkpointId: Id<"checkpoints">;
    }
  | {
      kind: "reorderCell";
      epicId: Id<"epics">;
      checkpointId: Id<"checkpoints">;
      ticketIds: TicketId[];
    }
  | {
      kind: "createTicket";
      epicId: Id<"epics">;
      checkpointId: Id<"checkpoints">;
      title: string;
      key?: string;
      status?: "todo" | "doing" | "testing" | "done";
      assignee?: string;
      dueDate?: string;
      tag?: string;
      githubPrs?: string[];
    }
  | {
      kind: "updateTicket";
      ticketId: TicketId;
      title?: string;
      checkpointId?: Id<"checkpoints">;
      status?: "todo" | "doing" | "testing" | "done";
      assignee?: string | null;
      dueDate?: string | null;
      tag?: string | null;
      githubPrs?: string[] | null;
    }
  | { kind: "deleteTicket"; ticketId: TicketId };

/** How a checkpoint reference reads in a sentence. */
export function checkpointLabel(ref: CheckpointRef): string {
  return ref === "backlog" ? "Backlog" : `W${ref}`;
}

/**
 * Keys and codes are matched case-insensitively.
 *
 * They are typed by an agent that may have read them from prose, a commit message
 * or a Jira page, and `abc-12` and `ABC-12` are never two different cards. The
 * board's own writes stay exact; this is only about finding what was meant.
 */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function findTicket(board: AssistantBoard, key: string) {
  const ticket = board.tickets.find((candidate) => sameName(candidate.key, key));
  if (!ticket) {
    throw new Error(
      `看板上找不到 key 為 ${key.trim()} 的卡片。請確認 key,或改用另一種方式描述。`,
    );
  }
  return ticket;
}

function findEpic(board: AssistantBoard, code: string) {
  const epic = board.epics.find((candidate) => sameName(candidate.code, code));
  if (!epic) {
    const known = board.epics.map((candidate) => candidate.code).join(", ");
    throw new Error(
      `看板上沒有 code 為 ${code.trim()} 的 Epic。目前有:${known || "(無)"}`,
    );
  }
  return epic;
}

function findCheckpoint(board: AssistantBoard, ref: CheckpointRef) {
  const checkpoint = board.checkpoints.find((candidate) =>
    ref === "backlog"
      ? candidate.kind === "backlog"
      : candidate.kind === "week" && candidate.weekNumber === ref,
  );
  if (!checkpoint) {
    throw new Error(
      `看板上沒有 ${checkpointLabel(ref)} 這一列。要先有這個 checkpoint 才能把卡片放進去。`,
    );
  }
  return checkpoint;
}

/**
 * Resolve one command against the board, or throw the reason it cannot be done.
 *
 * Only names are resolved here. Everything else — the epic guard, field
 * validation, key uniqueness, cell membership — is left to the mutation, so a
 * command is held to exactly the same standard as a click and there is no second
 * set of rules to keep in step.
 */
export function resolveCommand(
  command: AssistantCommand,
  board: AssistantBoard,
): ResolvedCommand {
  switch (command.kind) {
    case "moveTicket": {
      const ticket = findTicket(board, command.key);
      return {
        kind: "moveTicket",
        ticketId: ticket._id,
        // The epic the card must stay in — the mutation's guard, not a target.
        epicId: ticket.epicId,
        checkpointId: findCheckpoint(board, command.checkpoint)._id,
      };
    }

    case "reorderCell": {
      const epic = findEpic(board, command.epicCode);
      const checkpoint = findCheckpoint(board, command.checkpoint);
      if (command.keys.length === 0) {
        throw new Error("排序指令要給這一格完整的 key 順序,不能是空的。");
      }
      return {
        kind: "reorderCell",
        epicId: epic._id,
        checkpointId: checkpoint._id,
        ticketIds: command.keys.map((key) => findTicket(board, key)._id),
      };
    }

    case "createTicket": {
      const epic = findEpic(board, command.epicCode);
      // No week given means the backlog pool: an honest row for work that has no
      // delivery week yet, rather than quietly filing it under this week.
      const checkpoint = findCheckpoint(board, command.checkpoint ?? "backlog");
      return {
        kind: "createTicket",
        epicId: epic._id,
        checkpointId: checkpoint._id,
        title: command.title,
        key: command.key,
        status: command.status,
        assignee: command.assignee,
        dueDate: command.dueDate,
        tag: command.tag,
        githubPrs: command.githubPrs,
      };
    }

    case "updateTicket": {
      const ticket = findTicket(board, command.key);
      return {
        kind: "updateTicket",
        ticketId: ticket._id,
        title: command.title,
        checkpointId:
          command.checkpoint === undefined
            ? undefined
            : findCheckpoint(board, command.checkpoint)._id,
        status: command.status,
        assignee: command.assignee,
        dueDate: command.dueDate,
        tag: command.tag,
        githubPrs: command.githubPrs,
      };
    }

    case "deleteTicket":
      return { kind: "deleteTicket", ticketId: findTicket(board, command.key)._id };
  }
}

/** The fields an `updateTicket` command actually changes, for the summary line. */
function updatedFields(
  command: Extract<AssistantCommand, { kind: "updateTicket" }>,
): string[] {
  const parts: string[] = [];
  if (command.title !== undefined) parts.push(`標題=${command.title}`);
  if (command.checkpoint !== undefined) {
    parts.push(`週次=${checkpointLabel(command.checkpoint)}`);
  }
  if (command.status !== undefined) parts.push(`狀態=${command.status}`);
  if (command.assignee !== undefined) {
    parts.push(`負責人=${command.assignee ?? "(清空)"}`);
  }
  if (command.dueDate !== undefined) {
    parts.push(`到期日=${command.dueDate ?? "(清空)"}`);
  }
  if (command.tag !== undefined) parts.push(`標籤=${command.tag ?? "(清空)"}`);
  if (command.githubPrs !== undefined) {
    parts.push(`PR=${command.githubPrs?.join(" ") ?? "(清空)"}`);
  }
  return parts;
}

/**
 * The command itself, in one compact line.
 *
 * Shown under the agent's own description and copied into the reported result, so
 * both the person and the agent can check that the sentence and the payload say
 * the same thing.
 */
export function commandSummary(command: AssistantCommand): string {
  switch (command.kind) {
    case "moveTicket":
      return `moveTicket ${command.key} → ${checkpointLabel(command.checkpoint)}`;
    case "reorderCell":
      return `reorderCell ${command.epicCode}/${checkpointLabel(command.checkpoint)}: ${command.keys.join(" → ")}`;
    case "createTicket":
      return `createTicket ${command.epicCode}/${checkpointLabel(command.checkpoint ?? "backlog")}: ${command.title}`;
    case "updateTicket": {
      const fields = updatedFields(command);
      return `updateTicket ${command.key}: ${fields.length > 0 ? fields.join(", ") : "(沒有欄位)"}`;
    }
    case "deleteTicket":
      return `deleteTicket ${command.key}`;
  }
}

/**
 * When this account last had the chat window open, per account.
 *
 * That timestamp is the whole unread rule: an agent message newer than it lights
 * the dot on the button. Kept in localStorage so a reload does not re-announce
 * messages already read, and per account because two people may share a browser.
 */
const SEEN_KEY = "kanban.chat.seen.v1";

export function loadSeenAt(account: string): number {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    if (!raw) return 0;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return 0;
    const at = (parsed as Record<string, unknown>)[account];
    return typeof at === "number" ? at : 0;
  } catch {
    // Unreadable preference: treat everything as unread rather than break.
    return 0;
  }
}

export function saveSeenAt(account: string, at: number): void {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const all =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, number>)
        : {};
    all[account] = at;
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(all));
  } catch {
    // Private mode or a full quota: the dot just comes back next visit.
  }
}
