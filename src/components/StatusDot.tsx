import { STATUS_STYLES, type TicketStatus } from "@/lib/board";
import { cn } from "@/lib/utils";

/** The coloured light that carries a ticket's status everywhere on the board. */
export function StatusDot({
  status,
  className,
}: {
  status: TicketStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-block size-3 rounded-full",
        STATUS_STYLES[status].dot,
        className,
      )}
    />
  );
}
