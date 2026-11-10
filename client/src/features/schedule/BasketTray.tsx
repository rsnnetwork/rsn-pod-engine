// The round's unassigned basket (spec 06): the people of the round without a seat. They stay known and are never
// treated as gone. Dropping someone here unassigns them for the round; Redistribute seats whoever may be seated
// into valid places, never into a locked meeting.
import { useState, type DragEvent } from 'react';
import { Loader2, Shuffle } from 'lucide-react';
import type { BoardPerson, ScheduleBoard } from '@rsn/shared';
import { cn } from '@/lib/utils';
import type { DragSource, DropTarget } from './board-dnd';
import { BOARD_COPY, groupLabels, personMatches, seatPicked, waitingLine, type BoardFilter } from './board-model';
import SeatChip from './SeatChip';

interface Props {
  board: ScheduleBoard;
  round: number;
  basket: BoardPerson[];
  canEdit: boolean;
  draggable: boolean;
  filter: BoardFilter;
  selectedId: string | null;
  dragging: DragSource | null;
  busy: boolean;
  onSelect: (person: BoardPerson) => void;
  onDragStart: (source: DragSource) => void;
  onDragEnd: () => void;
  onDrop: (target: DropTarget) => void;
  onRedistribute: () => void;
}

/** Someone the basket can seat automatically: people who left or did not come wait until an organiser seats them. */
const seatable = (p: BoardPerson) => p.status === 'registered' || p.status === 'present';

export default function BasketTray({
  board, round, basket, canEdit, draggable, filter, selectedId, dragging, busy,
  onSelect, onDragStart, onDragEnd, onDrop, onRedistribute,
}: Props) {
  const [over, setOver] = useState(false);
  const accepts = !!dragging && canEdit && !basket.some((p) => p.userId === dragging.userId);
  const shown = basket.filter((p) => personMatches(p, { ...filter, conflictsOnly: false, lockedOnly: false }, true));

  const dragOver = (e: DragEvent<HTMLElement>) => {
    if (!accepts) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setOver(true);
  };
  const drop = (e: DragEvent<HTMLElement>) => {
    if (!accepts) return;
    e.preventDefault();
    setOver(false);
    onDrop({ kind: 'basket', round });
  };

  return (
    <section
      aria-label="Unassigned basket"
      data-testid="board-basket"
      onDragOver={dragOver}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }}
      onDrop={drop}
      className={cn(
        'rounded-2xl border bg-[#fff6f1] p-3 sm:p-4',
        over ? 'border-[#c4532f] ring-2 ring-[#c4532f]/30' : 'border-[#ecc6ad]',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-extrabold uppercase tracking-[0.08em] text-[#c4532f]">{BOARD_COPY.basketTitle}</h3>
          <p className="mt-1 text-[13px] leading-snug text-[#5a6670]">{BOARD_COPY.basketHint}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <span data-testid="board-basket-count" className="text-[13px] text-[#5a6670]">{waitingLine(basket.length)}</span>
          <button
            type="button"
            onClick={onRedistribute}
            disabled={!canEdit || busy || !basket.some(seatable)}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-[#12293a] px-4 text-[14px] font-bold text-white disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Shuffle className="h-4 w-4" aria-hidden="true" />}
            {BOARD_COPY.redistribute}
          </button>
        </div>
      </div>

      {shown.length > 0 && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((p) => (
            <SeatChip
              key={p.userId}
              person={p}
              groups={groupLabels(board, p.groupKeys)}
              source={{ round, userId: p.userId, fromRoom: null }}
              dropTarget={null}
              draggable={draggable}
              selected={selectedId === p.userId}
              picked={seatPicked(p, filter, true)}
              tone="basket"
              onSelect={() => onSelect(p)}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onDropOn={onDrop}
              dragging={!!dragging}
            />
          ))}
        </div>
      )}
      {basket.length > 0 && shown.length === 0 && (
        <p className="mt-3 text-[13px] text-[#5a6670]">Nobody waiting matches the search.</p>
      )}
    </section>
  );
}
