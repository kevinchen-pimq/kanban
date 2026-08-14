import { TicketCard } from "@/components/TicketCard";
import {
  describeCheckpoints,
  type Checkpoint,
  type Epic,
  type Ticket,
} from "@/lib/board";
import { cn } from "@/lib/utils";

/**
 * Width of the rotated checkpoint gutter. Narrow like a spreadsheet's row
 * header, since the label reads vertically and costs no horizontal room.
 */
const GUTTER_PX = 48;

/**
 * Every epic column is exactly this wide. The table is sized from the column
 * count rather than stretched to the container, so a board with one epic gets
 * the same readable card width as a board with six, and extra epics scroll
 * horizontally instead of squeezing.
 */
const COLUMN_PX = 300;

export function BoardMatrix({
  epics,
  checkpoints,
  tickets,
  today,
}: {
  epics: readonly Epic[];
  checkpoints: readonly Checkpoint[];
  tickets: readonly Ticket[];
  today: string;
}) {
  const rows = describeCheckpoints(checkpoints, today);

  // Bucket once by cell instead of re-scanning the ticket list per cell.
  const byCell = new Map<string, Ticket[]>();
  const epicTotals = new Map<string, number>();
  for (const ticket of tickets) {
    const cellKey = `${ticket.checkpointId}:${ticket.epicId}`;
    const cell = byCell.get(cellKey);
    if (cell) cell.push(ticket);
    else byCell.set(cellKey, [ticket]);

    epicTotals.set(ticket.epicId, (epicTotals.get(ticket.epicId) ?? 0) + 1);
  }

  return (
    // table-fixed plus an explicit width makes the column sizes exact rather
    // than a hint the browser may stretch when there is spare room.
    <table
      className="table-fixed border-collapse text-left"
      style={{ width: GUTTER_PX + epics.length * COLUMN_PX }}
    >
      <thead>
        <tr>
          <th
            style={{ width: GUTTER_PX }}
            className="sticky top-0 left-0 z-40 border-r border-b border-slate-200 bg-slate-100"
          >
            <span className="sr-only">週 Checkpoint</span>
          </th>
          {epics.map((epic) => (
            <th
              key={epic._id}
              style={{ width: COLUMN_PX }}
              className="sticky top-0 z-30 border-r border-b border-slate-200 bg-slate-50 p-3.5"
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className="truncate text-sm font-bold text-slate-800"
                  title={epic.name}
                >
                  {epic.name}
                </span>
                <span className="shrink-0 rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                  {epicTotals.get(epic._id) ?? 0}
                </span>
              </div>
            </th>
          ))}
        </tr>
      </thead>

      <tbody>
        {rows.map((row) => {
          const isCurrent = row.phase === "current";
          return (
            <tr
              key={row.checkpoint._id}
              // Marks the row for today so the board can open scrolled to it.
              data-current-week={isCurrent || undefined}
              className={isCurrent ? "bg-indigo-50/20" : "hover:bg-slate-50/50"}
            >
              <th
                scope="row"
                style={{ width: GUTTER_PX }}
                className={cn(
                  "sticky left-0 z-20 border-r border-b border-slate-200 bg-white p-0",
                  isCurrent && "border-l-4 border-l-indigo-600",
                )}
              >
                {/* Rotated so the row label costs vertical space, not width.
                    vertical-rl + rotate-180 reads bottom-to-top, which keeps
                    the week number at the top of the row. text-orientation
                    must be sideways: the default leaves CJK glyphs upright,
                    and rotate-180 would then render them upside down. */}
                <div className="flex h-full items-center justify-center py-3">
                  <div className="flex flex-row-reverse items-center gap-2 whitespace-nowrap [text-orientation:sideways] [writing-mode:vertical-rl] rotate-180">
                    <span className="text-xs font-bold text-slate-800">
                      {row.title}
                    </span>
                    <span className="text-[11px] font-normal text-slate-400">
                      {row.subtitle}
                    </span>
                  </div>
                </div>
              </th>

              {epics.map((epic) => {
                const cellTickets =
                  byCell.get(`${row.checkpoint._id}:${epic._id}`) ?? [];
                return (
                  <td
                    key={epic._id}
                    className="border-r border-b border-slate-200 p-3 align-top"
                  >
                    <div className="min-h-20 space-y-2.5">
                      {cellTickets.length === 0 ? (
                        <div className="flex h-16 items-center justify-center rounded-xl border-2 border-dashed border-slate-100 text-xs text-slate-300 transition hover:border-slate-200">
                          無對應項目
                        </div>
                      ) : (
                        cellTickets.map((ticket) => (
                          <TicketCard
                            key={ticket._id}
                            ticket={ticket}
                            today={today}
                          />
                        ))
                      )}
                    </div>
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
