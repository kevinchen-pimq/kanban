import { useBoardConfig } from "@/components/BoardConfigProvider";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { assigneeColor, initials } from "@/lib/assignee";
import { cn } from "@/lib/utils";

/**
 * Round avatar with the assignee's initials on their own colour.
 *
 * Shared by the ticket card and the assignee filter so one person looks the
 * same in both. The colour comes from the board config's `assigneeColors` when
 * it names this person, and from the hashed palette when it does not; `null`
 * means unassigned and draws the neutral slate chip.
 */
export function AssigneeAvatar({
  name,
  className,
  textClassName,
}: {
  name: string | null;
  /** Size overrides, e.g. `size-4` on a card, `size-5` in the filter menu. */
  className?: string;
  textClassName?: string;
}) {
  const config = useBoardConfig();

  return (
    <Avatar className={cn("size-4", className)}>
      <AvatarFallback
        className={cn("text-[8px] font-semibold text-white", textClassName)}
        style={{ backgroundColor: assigneeColor(name, config?.assigneeColors) }}
      >
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  );
}
