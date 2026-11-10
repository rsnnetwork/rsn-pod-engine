// One meeting of a round on the matching board: "Room 03", its lock, the checker's verdict, and its people. The card
// is a drop target for a free place (a move); each person in it is one for a swap. While someone is dragged over it,
// the card says what the room checker thinks of them joining (the server still decides). Nothing on the board changes
// size during a drag, so the seat under the pointer stays where it was.
import { useState, type DragEvent } from 'react';
import { Lock, LockOpen } from 'lucide-react';
import type { BoardPerson, BoardRoom, ScheduleBoard } from '@rsn/shared';
import { cn } from '@/lib/utils';
import type { DragSource, DropTarget } from './board-dnd';
import { groupLabels, roomTitle, seatPicked, verdictBadges, type BoardFilter, type MoveHint } from './board-model';
import SeatChip from './SeatChip';

interface Props {
  board: ScheduleBoard;
  round: number;
  room: BoardRoom;
  canEdit: boolean;
  draggable: boolean;
  filter: BoardFilter;
  selectedId: string | null;
  dragging: DragSource | null;
  /** What the checker thinks of the dragged person joining this room, or null. */
  dropHint: MoveHint | null;
  busy: boolean;
  onSelect: (person: BoardPerson, room: number) => void;
  onDragStart: (source: DragSource) => void;
  onDragEnd: () => void;
  onDrop: (target: DropTarget) => void;
  onToggleLock: (room: BoardRoom) => void;
}

const HINT_TONE = { ok: 'text-[#1d6b5c]', warn: 'text-amber-700', bad: 'text-red-700' } as const;

export default function BoardRoomCard({
  board, round, room, canEdit, draggable, filter, selectedId, dragging, dropHint, busy,
  onSelect, onDragStart, onDragEnd, onDrop, onToggleLock,
}: Props) {
  const [over, setOver] = useState(false);
  const full = room.seats.length >= 3;
  const fromHere = !!dragging && room.seats.some((s) => s.userId === dragging.userId);
  // Nothing is taken while a change is on its way: writes go one at a time.
  const acceptsMove = !!dragging && canEdit && !busy && !room.locked && !full && !fromHere;
  const placeholders = Math.max(0, 2 - room.seats.length);
  const badges = verdictBadges(room);
  const moveTarget: DropTarget = { kind: 'seat', round, room: room.roomNumber, occupantId: null };

  const dragOver = (e: DragEvent<HTMLElement>) => {
    if (!acceptsMove) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setOver(true);
  };
  const drop = (e: DragEvent<HTMLElement>) => {
    if (!acceptsMove) return;
    e.preventDefault();
    setOver(false);
    onDrop(moveTarget);
  };

  return (
    <section
      aria-label={roomTitle(room.roomNumber)}
      data-testid={`board-room-${room.roomNumber}`}
      onDragOver={dragOver}
      // Over a person the drop is a swap, not a move: the move hint gives way (a person who takes no drop hands the
      // dragover back to the card, which shows it again).
      onDragEnter={(e) => { if (e.target instanceof Element && e.target.closest('[data-seat]')) setOver(false); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }}
      onDrop={drop}
      className={cn(
        'relative flex min-w-0 flex-col gap-2 rounded-2xl border bg-white p-3 shadow-[0_1px_2px_rgba(18,41,58,.05)]',
        room.locked ? 'border-[#9fcfc4]' : 'border-[#e3e7ea]',
        over && 'border-[#1d6b5c] ring-2 ring-[#1d6b5c]/30',
      )}
    >
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <h3 className="text-[14px] font-semibold text-[#3d4a55]">{roomTitle(room.roomNumber)}</h3>
        <button
          type="button"
          onClick={() => onToggleLock(room)}
          disabled={!canEdit || busy}
          aria-pressed={room.locked}
          aria-label={room.locked ? `Unlock ${roomTitle(room.roomNumber)}` : `Lock ${roomTitle(room.roomNumber)}`}
          className={cn(
            'inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-2 text-[12px] font-extrabold uppercase tracking-[0.08em] disabled:opacity-60',
            room.locked ? 'text-[#1d6b5c]' : 'text-[#5a6670] hover:text-[#1d6b5c]',
          )}
        >
          {room.locked ? <Lock className="h-3.5 w-3.5" aria-hidden="true" /> : <LockOpen className="h-3.5 w-3.5" aria-hidden="true" />}
          {room.locked ? 'Locked' : 'Lock'}
        </button>
      </header>

      {badges.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Checks">
          {badges.map((b) => (
            <li
              key={b.label}
              className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', b.tone === 'problem' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800')}
            >
              {b.label}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-2">
        {room.seats.map((seat) => (
          <SeatChip
            key={seat.userId}
            person={seat}
            groups={groupLabels(board, seat.groupKeys)}
            source={{ round, userId: seat.userId, fromRoom: room.roomNumber }}
            dropTarget={canEdit && !busy && !room.locked && !seat.slotLocked ? { kind: 'seat', round, room: room.roomNumber, occupantId: seat.userId } : null}
            slotLocked={seat.slotLocked}
            draggable={draggable && !busy && !room.locked && !seat.slotLocked}
            selected={selectedId === seat.userId}
            picked={seatPicked(seat, filter, false)}
            onSelect={() => onSelect(seat, room.roomNumber)}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDropOn={onDrop}
            dragging={!!dragging}
          />
        ))}
        {Array.from({ length: placeholders }, (_, i) => (
          <div
            key={`empty-${i}`}
            className="flex min-h-[44px] items-center rounded-xl border border-dashed border-[#cfd6db] px-3 text-[14px] text-[#7a858e]"
          >
            Empty seat
          </div>
        ))}
      </div>

      {over && acceptsMove && dropHint && (
        <p
          role="status"
          className={cn(
            'pointer-events-none absolute -bottom-3 left-3 right-3 truncate rounded-full border border-[#dfe5e8] bg-white px-2.5 py-0.5 text-[12px] font-semibold shadow-sm',
            HINT_TONE[dropHint.tone],
          )}
        >
          {dropHint.text}
        </p>
      )}
    </section>
  );
}
