// One person on the matching board: their group, their name, their standing. A button, so a tap or Enter selects them
// (MoveSheet), and on a desktop pointer it can be dragged (native drag and drop, board-dnd.ts). An occupied seat is
// also a drop target: dropping someone on it swaps the two. Part 3 Task 10: their answers to the event's matching
// questions, under the name (organisers only: the board's answers context is empty for anyone else).
import { useContext, useState, type DragEvent } from 'react';
import { Lock } from 'lucide-react';
import type { BoardPerson } from '@rsn/shared';
import { cn } from '@/lib/utils';
import { BOARD_DRAG_TYPE, encodeDrag, type DragSource, type DropTarget } from './board-dnd';
import { statusNote } from './board-model';
import { BoardAnswersContext } from './board-answers';

interface Props {
  person: BoardPerson;
  groups: string[];
  source: DragSource;
  /** Where a drop onto this chip lands (an occupied seat), or null in the basket. */
  dropTarget: DropTarget | null;
  slotLocked?: boolean;
  draggable: boolean;
  selected: boolean;
  picked: boolean;
  tone?: 'seat' | 'basket';
  onSelect: () => void;
  onDragStart: (source: DragSource) => void;
  onDragEnd: () => void;
  onDropOn: (target: DropTarget) => void;
  dragging: boolean;
}

export default function SeatChip({
  person, groups, source, dropTarget, slotLocked = false, draggable, selected, picked, tone = 'seat',
  onSelect, onDragStart, onDragEnd, onDropOn, dragging,
}: Props) {
  const [over, setOver] = useState(false);
  const note = statusNote(person.status);
  const answers = useContext(BoardAnswersContext).labelsFor(person.userId);
  const accepts = !!dropTarget && dragging;
  const label = [
    groups.length ? `${groups.join(', ')}:` : '', person.displayName, note ? `(${note})` : '',
    answers.length ? `(${answers.join(', ')})` : '', slotLocked ? '(seat locked)' : '',
  ].filter(Boolean).join(' ');

  const start = (e: DragEvent<HTMLButtonElement>) => {
    e.dataTransfer.setData(BOARD_DRAG_TYPE, encodeDrag(source));
    e.dataTransfer.effectAllowed = 'move';
    onDragStart(source);
  };
  const dragOver = (e: DragEvent<HTMLButtonElement>) => {
    if (!accepts) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setOver(true);
  };
  const drop = (e: DragEvent<HTMLButtonElement>) => {
    if (!accepts || !dropTarget) return;
    e.preventDefault();
    e.stopPropagation();
    setOver(false);
    onDropOn(dropTarget);
  };

  return (
    <button
      type="button"
      data-seat
      data-testid={`board-person-${person.userId}`}
      aria-label={label}
      aria-pressed={selected}
      draggable={draggable}
      onClick={onSelect}
      onDragStart={draggable ? start : undefined}
      onDragEnd={onDragEnd}
      onDragOver={dragOver}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      className={cn(
        'flex min-h-[44px] w-full min-w-0 items-center gap-2 rounded-xl px-3 py-2 text-left text-[15px] text-[#12293a] outline-none transition-colors',
        'focus-visible:ring-2 focus-visible:ring-[#1d6b5c] focus-visible:ring-offset-1',
        tone === 'basket' ? 'border border-[#ecc6ad] bg-white' : 'bg-[#f1f4f5]',
        draggable && 'cursor-grab active:cursor-grabbing',
        selected && 'ring-2 ring-[#1d6b5c]',
        picked && !selected && 'ring-2 ring-amber-400',
        over && 'bg-[#e3f1ee] ring-2 ring-[#1d6b5c]',
      )}
    >
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        {groups.length > 0 && <span className="text-[#5a6670]">{groups.join(', ')}: </span>}
        <span className="font-medium">{person.displayName}</span>
        {note && <span className="ml-1.5 inline-block rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">{note}</span>}
        {answers.length > 0 && (
          <span data-testid="seat-answers" className="mt-1 flex flex-wrap gap-1">
            {answers.map((a, i) => (
              <span key={`${a}-${i}`} className="max-w-full truncate rounded-full bg-[#e3f1ee] px-2 py-0.5 text-[11px] font-semibold text-[#1d6b5c]">{a}</span>
            ))}
          </span>
        )}
      </span>
      {slotLocked && <Lock className="h-3.5 w-3.5 shrink-0 text-[#1d6b5c]" aria-hidden="true" />}
    </button>
  );
}
