// One round of the matching board (spec 06 "round view"): its capacity sentence and the fallback the organiser chose,
// its conflicts, its rooms and its basket. The arrow keys move between the people on it (each is a button: Enter
// selects them for MoveSheet). A round that has started is shown, never edited.
import type { KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { Info } from 'lucide-react';
import type { BoardPerson, BoardRoom, BoardRound, ScheduleBoard } from '@rsn/shared';
import type { DragSource, DropTarget } from './board-dnd';
import { BOARD_COPY, conflictsOf, moveHint, roomMatches, type BoardConflict, type BoardFilter } from './board-model';
import BoardRoomCard from './BoardRoomCard';
import BasketTray from './BasketTray';
import ConflictList from './ConflictList';

interface Props {
  sessionId: string;
  board: ScheduleBoard;
  round: BoardRound;
  editing: boolean;
  draggable: boolean;
  filter: BoardFilter;
  selectedId: string | null;
  dragging: DragSource | null;
  busy: boolean;
  onSelect: (person: BoardPerson) => void;
  onDragStart: (source: DragSource) => void;
  onDragEnd: () => void;
  onDrop: (target: DropTarget) => void;
  onToggleRoomLock: (room: BoardRoom) => void;
  onRedistribute: () => void;
  onShowConflict: (conflict: BoardConflict) => void;
}

const FALLBACK_LINE = {
  leave_unmatched: 'When groups are uneven, the people left over wait in the basket.',
  same_group_meeting: 'When groups are uneven, the people left over may meet their own group.',
} as const;

/** Arrow keys walk the people of the round in reading order. */
function walkSeats(e: KeyboardEvent<HTMLDivElement>) {
  const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
  if (!step || !(e.target instanceof HTMLElement) || !e.target.hasAttribute('data-seat')) return;
  const seats = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-seat]'));
  const next = seats[seats.indexOf(e.target) + step];
  if (!next) return;
  e.preventDefault();
  next.focus();
}

export default function RoundView({
  sessionId, board, round, editing, draggable, filter, selectedId, dragging, busy,
  onSelect, onDragStart, onDragEnd, onDrop, onToggleRoomLock, onRedistribute, onShowConflict,
}: Props) {
  const r = round.roundNumber;
  const canEdit = editing && round.editable;
  const rooms = round.rooms.filter((room) => roomMatches(room, filter));
  const capacity = round.capacity?.sentence ?? null;
  const conflicts = conflictsOf(board, r).filter((c) => c.text !== capacity);
  const hintFor = (room: BoardRoom) => (dragging && dragging.round === r ? moveHint(board, r, dragging.userId, room.roomNumber) : null);

  return (
    <div className="flex flex-col gap-3" onKeyDown={walkSeats}>
      {!round.editable && (
        <p className="flex items-start gap-2 rounded-xl bg-white px-3 py-2 text-[14px] text-[#3d4a55]">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-[#5a6670]" aria-hidden="true" /> {BOARD_COPY.roundStarted}
        </p>
      )}
      {round.beyondLastRound && (
        <p className="rounded-xl bg-white px-3 py-2 text-[14px] text-[#3d4a55]">
          The event now has fewer rounds than this one. These seats stay visible and the next Auto generate clears them.
        </p>
      )}
      {capacity && (
        <div data-testid="board-capacity" className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[14px] text-amber-900">
          <p className="[overflow-wrap:anywhere]">{capacity}</p>
          {board.groupRules && (
            <p className="mt-1 text-[13px]">
              {FALLBACK_LINE[board.groupRules.fallback]}{' '}
              <Link to={`/sessions/${sessionId}#groups`} className="inline-flex min-h-[44px] items-center font-semibold text-amber-900 underline">
                Change this in the event's groups
              </Link>
            </p>
          )}
        </div>
      )}
      <ConflictList title="Conflicts in this round" conflicts={conflicts} onShow={onShowConflict} />

      {round.rooms.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-[#cfd6db] bg-white px-4 py-6 text-center text-[14px] text-[#5a6670]">
          {round.basket.length > 0 ? BOARD_COPY.emptyRound : BOARD_COPY.nobodyYet}
        </p>
      ) : rooms.length === 0 ? (
        <p className="rounded-2xl bg-white px-4 py-6 text-center text-[14px] text-[#5a6670]">No meetings match the filters.</p>
      ) : (
        <div className={`grid gap-3 transition-opacity sm:grid-cols-2 xl:grid-cols-3 ${busy ? 'opacity-70' : ''}`}>
          {rooms.map((room) => (
            <BoardRoomCard
              key={room.roomNumber}
              board={board}
              round={r}
              room={room}
              canEdit={canEdit}
              draggable={draggable && canEdit}
              filter={filter}
              selectedId={selectedId}
              dragging={dragging}
              dropHint={hintFor(room)}
              busy={busy}
              onSelect={onSelect}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onDrop={onDrop}
              onToggleLock={onToggleRoomLock}
            />
          ))}
        </div>
      )}

      <BasketTray
        board={board}
        round={r}
        basket={round.basket}
        canEdit={canEdit}
        draggable={draggable && canEdit}
        filter={filter}
        selectedId={selectedId}
        dragging={dragging}
        busy={busy}
        onSelect={onSelect}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDrop={onDrop}
        onRedistribute={onRedistribute}
      />
    </div>
  );
}
