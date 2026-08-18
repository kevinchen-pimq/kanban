import { getConvexUrl } from "@convex-dev/static-hosting";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Credentials } from "@/lib/auth";
import { STATUS_ORDER, type Ticket, type TicketStatus } from "@/lib/board";
import type { Id } from "../../convex/_generated/dataModel";

/** How long the clicking has to stop before the status is written. */
const DEBOUNCE_MS = 1000;

/** todo → doing → testing → done → todo. */
export function nextStatus(status: TicketStatus): TicketStatus {
  const index = STATUS_ORDER.indexOf(status);
  return STATUS_ORDER[(index + 1) % STATUS_ORDER.length];
}

/**
 * Click-to-advance status, with one write per burst of clicks.
 *
 * Clicking a dot is meant to feel free — four clicks to take a card from To Do
 * back around to To Do should not be four round trips, and the intermediate
 * values are not states anyone meant to record. So each click updates a local
 * override immediately (that is what the dot renders from) and arms a 1s timer;
 * only when the clicking stops does the final value go to the server. It is a
 * debounce, not a throttle: the burst produces exactly one write.
 *
 * `pending` is kept until the mutation resolves rather than cleared on send, so
 * the dot never flicks back to the old colour while the write is in flight.
 *
 * Leaving the page with a timer still armed would drop that click: the normal
 * mutation goes over the Convex WebSocket, and a socket torn down by navigation
 * never gets the frame out — measured, not assumed (a click followed by an
 * immediate reload lost the write). So the flush on `pagehide` /
 * `visibilitychange` goes over Convex's HTTP mutation endpoint with
 * `keepalive: true` instead, which is the same guarantee `navigator.sendBeacon`
 * gives: the browser is obliged to finish the request even as the page dies.
 *
 * The trade-off left is small and deliberate: a keepalive request that fails
 * loses one click, and nothing is watching to retry it. The card then keeps the
 * status it had, which is the same outcome as never having clicked.
 */
export function useStatusCycle(
  save: (ticketId: Id<"tickets">, status: TicketStatus) => Promise<unknown>,
  /**
   * The signed-in credential pair. The normal write carries it through `save`,
   * but the teardown flush builds its own request body, so it needs the pair
   * here too — a keepalive POST without it is rejected like any other
   * unauthenticated call.
   */
  auth: Credentials,
) {
  const [pending, setPending] = useState<
    ReadonlyMap<Id<"tickets">, TicketStatus>
  >(new Map());

  // Refs so the flush path never depends on a re-render having happened.
  const timers = useRef(new Map<Id<"tickets">, ReturnType<typeof setTimeout>>());
  const latest = useRef(new Map<Id<"tickets">, TicketStatus>());
  const saveRef = useRef(save);
  saveRef.current = save;
  const authRef = useRef(auth);
  authRef.current = auth;

  const send = useCallback((ticketId: Id<"tickets">) => {
    const armed = timers.current.get(ticketId);
    if (armed) clearTimeout(armed);
    timers.current.delete(ticketId);

    const status = latest.current.get(ticketId);
    if (status === undefined) return;
    latest.current.delete(ticketId);

    void saveRef.current(ticketId, status).finally(() => {
      setPending((current) => {
        // A click that arrived while the write was in flight owns the override
        // now, so only drop it when nothing newer is queued.
        if (latest.current.has(ticketId)) return current;
        const next = new Map(current);
        next.delete(ticketId);
        return next;
      });
    });
  }, []);

  const cycleStatus = useCallback(
    (ticket: Ticket) => {
      const from = latest.current.get(ticket._id) ?? ticket.status;
      const to = nextStatus(from);

      latest.current.set(ticket._id, to);
      setPending((current) => new Map(current).set(ticket._id, to));

      const armed = timers.current.get(ticket._id);
      if (armed) clearTimeout(armed);
      timers.current.set(
        ticket._id,
        setTimeout(() => send(ticket._id), DEBOUNCE_MS),
      );
    },
    [send],
  );

  const flushAll = useCallback(() => {
    for (const ticketId of [...timers.current.keys()]) send(ticketId);
  }, [send]);

  /**
   * Flush during page teardown. Same mutation, different transport: an HTTP POST
   * marked `keepalive` survives the navigation that closes the WebSocket.
   */
  const flushOnLeave = useCallback(() => {
    const url = import.meta.env.VITE_CONVEX_URL ?? getConvexUrl();
    for (const [ticketId, timer] of [...timers.current.entries()]) {
      clearTimeout(timer);
      timers.current.delete(ticketId);
      const status = latest.current.get(ticketId);
      if (status === undefined) continue;
      latest.current.delete(ticketId);

      void fetch(`${url}/api/mutation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "board:updateTicket",
          args: { auth: authRef.current, ticketId, status },
          format: "json",
        }),
        keepalive: true,
      }).catch(() => {
        // Nothing useful to do: the page is going away.
      });
    }
  }, []);

  useEffect(() => {
    const onHide = () => flushOnLeave();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushOnLeave();
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      // Unmount without the page going away (a route change, say): the socket is
      // still there, so the normal mutation is fine.
      flushAll();
    };
  }, [flushAll, flushOnLeave]);

  /** Apply the local overrides, so every render site shows the clicked value. */
  const withPendingStatus = useCallback(
    (tickets: readonly Ticket[]): Ticket[] =>
      pending.size === 0
        ? [...tickets]
        : tickets.map((ticket) => {
            const status = pending.get(ticket._id);
            return status === undefined || status === ticket.status
              ? ticket
              : { ...ticket, status };
          }),
    [pending],
  );

  return { cycleStatus, withPendingStatus };
}
