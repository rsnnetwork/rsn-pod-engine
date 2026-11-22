// The round's unassigned basket (spec 06): the people of the round without a seat. They stay known and are never
// treated as gone. Dropping someone here unassigns them for the round; Redistribute seats whoever may be seated
// into valid places, never into a locked meeting.
//
// The basket sits under the rooms, so on a board taller than the window it is out of sight when a drag starts
// (preview smoke, 11 Nov: a drag from the rooms had to scroll mid-drag to reach it). While someone seated is dragged, a
// basket drop zone pins itself to the foot of the window (sticky, after the basket: it only adds height at the end
// of the board, so nothing the pointer is aiming at moves) and goes when the drag ends.
import { useEffect, useState, type DragEvent } from 'react';
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

/** The pinned drop zone's words while someone seated is dragged. */
export const BASKET_DROP_HERE = 'Drop here to move them to the unassigned basket';

/** Someone the basket can seat automatically: people who left or did not come wait until an organiser seats them. */
const seatable = (p: BoardPerson) => p.status === 'registered' || p.status === 'present';

export default function BasketTray({
  board, round, basket, canEdit, draggable, filter, selectedId, dragging, busy,
  onSelect, onDragStart, onDragEnd, onDrop, onRedistribute,
}: Props) {
  const [over, setOver] = useState(false);
  const [overZone, setOverZone] = useState(false);
  // A drag that ended anywhere (a drop elsewhere, or Escape, which ends it with dragend on the person and clears
  // `dragging`) leaves nothing highlighted for the next one.
  useEffect(() => {
    if (dragging) return undefined;
    setOver(false);
    setOverZone(false);
    return undefined;
  }, [dragging]);
  useEffect(() => {
    if (!dragging) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOver(false); setOverZone(false); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dragging]);
  const accepts = !!dragging && canEdit && !busy && !basket.some((p) => p.userId === dragging.userId);
  const shown = basket.filter((p) => personMatches(p, { ...filter, conflictsOnly: false, lockedOnly: false }, true));

  const dragOverWith = (mark: (v: boolean) => void) => (e: DragEvent<HTMLElement>) => {
    if (!accepts) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    mark(true);
  };
  const drop = (e: DragEvent<HTMLElement>) => {
    if (!accepts) return;
    e.preventDefault();
    setOver(false);
    setOverZone(false);
    onDrop({ kind: 'basket', round });
  };
  const dragOver = dragOverWith(setOver);

  return (
    <>
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
                draggable={draggable && !busy}
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
      {accepts && (
        <div
          data-testid="board-basket-dropzone"
          onDragOver={dragOverWith(setOverZone)}
          onDragLeave={() => setOverZone(false)}
          onDrop={drop}
          className={cn(
            // Below 721px the shell's bottom bar (MobileNav, fixed over the foot of <main>) is there: the zone sits above
            // it by the shell's own bottom padding (ReasonShell, F7). From 721px there is no bar.
            'sticky bottom-[calc(96px+env(safe-area-inset-bottom))] min-[721px]:bottom-[max(8px,env(safe-area-inset-bottom))] z-20 flex min-h-[64px] items-center justify-center rounded-2xl border-2 border-dashed px-4 text-center text-[14px] font-bold shadow-[0_-10px_30px_rgba(18,41,58,.18)]',
            overZone ? 'border-[#c4532f] bg-[#ffe9df] text-[#a8401f]' : 'border-[#ecc6ad] bg-[#fff6f1] text-[#c4532f]',
          )}
        >
          {BASKET_DROP_HERE}
        </div>
      )}
    </>
  );
}
