import { useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { readableError, type Credentials } from "@/lib/auth";
import {
  commandSummary,
  resolveCommand,
  type AssistantBoard,
  type ChatMessage,
  type ResolvedCommand,
} from "@/lib/assistant";
import { api } from "../../convex/_generated/api";

/**
 * The half of the board assistant that actually touches the board.
 *
 * The agent posts commands; this runs them — in the user's browser, with the
 * user's credential, through the same five `board:*` mutations a click uses. That
 * is the point of the whole arrangement rather than an implementation detail: the
 * agent cannot write to the board, so "what may this change do" is answered by
 * the account watching the chat, not by whatever the agent was told. An account
 * with `permWrite` sees its board change; one with only `permEditRequest` gets a
 * pending edit request, badged and reviewable exactly like a dragged card, and
 * the command reports back `proposed` instead of `executed`. Neither path has any
 * code of its own here.
 *
 * Three deliberate choices:
 *
 * **Claim before running.** `messages:claim` flips one pending row to `running`
 * in its own transaction and says whether this tab won. Two open tabs therefore
 * execute a command once between them, instead of both moving the same card.
 *
 * **One at a time, oldest first.** A batch of commands from one turn usually
 * depends on itself (create a card, then order the cell it landed in), so they run
 * in the order the agent wrote them and each waits for the last to report.
 *
 * **Failures are answers.** A key that matches nothing, a week that is not on the
 * board, a mutation refusing the change — all of it is reported as `failed` with
 * the reason, because the agent reads that reason and corrects itself. Nothing is
 * guessed at and nothing is retried silently.
 *
 * It lives in the assistant's mounted component rather than in the chat window, so
 * closing the window does not strand a command mid-conversation.
 */
export function useCommandExecutor(
  messages: readonly ChatMessage[] | undefined,
  auth: Credentials,
  /** True when this account proposes edits instead of making them. */
  requestMode: boolean,
): void {
  const pending = useMemo(
    () =>
      (messages ?? []).filter(
        (message) => message.command && message.status === "pending",
      ),
    [messages],
  );

  // Resolving keys and week numbers needs the *whole* board, not the window the
  // matrix happens to be showing: a card the agent names may sit in a week nobody
  // has scrolled back to. Subscribed only while there is something to run, so an
  // idle chat costs one subscription rather than two.
  const board = useQuery(api.board.get, pending.length > 0 ? { auth } : "skip");

  const claim = useMutation(api.messages.claim);
  const report = useMutation(api.messages.report);
  const moveTicket = useMutation(api.board.moveTicket);
  const reorderCell = useMutation(api.board.reorderCell);
  const createTicket = useMutation(api.board.createTicket);
  const updateTicket = useMutation(api.board.updateTicket);
  const deleteTicket = useMutation(api.board.deleteTicket);

  /** Send one resolved command to the mutation that owns it. */
  const call = useCallback(
    async (resolved: ResolvedCommand) => {
      switch (resolved.kind) {
        case "moveTicket":
          await moveTicket({
            auth,
            ticketId: resolved.ticketId,
            epicId: resolved.epicId,
            checkpointId: resolved.checkpointId,
          });
          return;
        case "reorderCell":
          await reorderCell({
            auth,
            epicId: resolved.epicId,
            checkpointId: resolved.checkpointId,
            ticketIds: resolved.ticketIds,
          });
          return;
        case "createTicket":
          await createTicket({
            auth,
            title: resolved.title,
            epicId: resolved.epicId,
            checkpointId: resolved.checkpointId,
            key: resolved.key,
            status: resolved.status,
            assignee: resolved.assignee,
            dueDate: resolved.dueDate,
            tag: resolved.tag,
            githubPrs: resolved.githubPrs,
          });
          return;
        case "updateTicket":
          await updateTicket({
            auth,
            ticketId: resolved.ticketId,
            title: resolved.title,
            checkpointId: resolved.checkpointId,
            status: resolved.status,
            assignee: resolved.assignee,
            dueDate: resolved.dueDate,
            tag: resolved.tag,
            githubPrs: resolved.githubPrs,
          });
          return;
        case "deleteTicket":
          await deleteTicket({ auth, ticketId: resolved.ticketId });
          return;
      }
    },
    [auth, createTicket, deleteTicket, moveTicket, reorderCell, updateTicket],
  );

  const run = useCallback(
    async (message: ChatMessage, snapshot: AssistantBoard) => {
      const command = message.command;
      if (!command) return;

      const { claimed } = await claim({ auth, messageId: message._id });
      if (!claimed) return; // another tab has it

      try {
        await call(resolveCommand(command, snapshot));
        await report({
          auth,
          messageId: message._id,
          outcome: requestMode ? "proposed" : "executed",
          detail: commandSummary(command),
        });
      } catch (caught: unknown) {
        await report({
          auth,
          messageId: message._id,
          outcome: "failed",
          detail: readableError(caught),
        });
      }
    },
    [auth, call, claim, report, requestMode],
  );

  // `running` is state rather than a ref so that finishing one command re-runs
  // this effect and picks up the next: a ref would go quiet after the last
  // message update and leave the queue stalled.
  const [running, setRunning] = useState<string | null>(null);

  useEffect(() => {
    if (running !== null) return;
    const next = pending[0];
    if (!next || board === undefined) return;

    setRunning(next._id);
    void run(next, board)
      // A report that itself fails leaves the command `running` until the claim
      // goes stale, which is the same recovery a closed tab gets.
      .catch(() => undefined)
      .finally(() => setRunning(null));
  }, [board, pending, run, running]);
}
