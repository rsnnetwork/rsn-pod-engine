// Select and move (spec 06): the phone's and the keyboard's way to do what a drag does on a desktop. A tap or Enter
// on a person opens this sheet: swap them with someone, move them to a room with a free seat, put them in the basket,
// lock their meeting, or read their meetings across the rounds. Each target says at once what the shared room checker
// thinks of it; the server still decides. Plain buttons with words, 44px and more, never drag-only.
import type { ReactNode } from 'react';
import { ArrowRightLeft, CalendarRange, Inbox, Lock, LockOpen, MoveRight } from 'lucide-react';
import type { BoardOp, BoardPerson, BoardRound, ScheduleBoard } from '@rsn/shared';
import Sheet from '@/features/reason/ui/Sheet';
import { cn } from '@/lib/utils';
import {
  MOVE_COPY, groupLabels, moveHint, newRoomNumber, roomOfPerson, roomTitle, swapHint, type MoveHint,
} from './board-model';

interface Props {
  board: ScheduleBoard;
  round: BoardRound;
  person: BoardPerson;
  canEdit: boolean;
  /** A change is on its way: the actions wait for it (writes go one at a time). */
  busy: boolean;
  onRun: (op: BoardOp) => void;
  onShowMeetings: (person: BoardPerson) => void;
  onClose: () => void;
}

const HINT_TONE = { ok: 'text-[#1d6b5c]', warn: 'text-amber-700', bad: 'text-red-700' } as const;
const DOT_TONE = { ok: 'bg-[#1d6b5c]', warn: 'bg-amber-500', bad: 'bg-red-600' } as const;

function Row({ icon, label, sub, hint, onClick, testId, disabled = false }: {
  icon: ReactNode; label: string; sub?: string; hint?: MoveHint; onClick: () => void; testId?: string; disabled?: boolean;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        data-testid={testId}
        className="flex min-h-[48px] w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-[#f1f4f5] focus-visible:bg-[#f1f4f5] disabled:opacity-50"
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#eef3f2] text-[#1d6b5c]">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-semibold text-[#12293a] [overflow-wrap:anywhere]">{label}</span>
          {sub && <span className="block text-[13px] text-[#5a6670] [overflow-wrap:anywhere]">{sub}</span>}
          {hint && (
            <span className={cn('mt-0.5 flex items-center gap-1.5 text-[12px] font-semibold', HINT_TONE[hint.tone])}>
              <span className={cn('h-2 w-2 shrink-0 rounded-full', DOT_TONE[hint.tone])} aria-hidden="true" />
              {hint.text}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

const Heading = ({ children }: { children: ReactNode }) => (
  <h3 className="mt-4 px-3 text-[11px] font-extrabold uppercase tracking-[0.12em] text-[#7a858e]">{children}</h3>
);

export default function MoveSheet({ board, round, person, canEdit, busy, onRun, onShowMeetings, onClose }: Props) {
  const r = round.roundNumber;
  const name = person.displayName;
  const mine = roomOfPerson(round, person.userId);
  const mySeat = mine?.seats.find((s) => s.userId === person.userId);
  const held = !!mine && (mine.locked || !!mySeat?.slotLocked);
  const act = (op: BoardOp) => { if (busy) return; onClose(); onRun(op); };

  const swaps = canEdit && !held
    ? round.rooms.filter((room) => room !== mine && !room.locked).flatMap((room) => room.seats
      .filter((s) => !s.slotLocked)
      .map((s) => ({ seat: s, room: room.roomNumber })))
    : [];
  const freeRooms = canEdit && !held
    ? [...round.rooms.filter((room) => room !== mine && !room.locked && room.seats.length < 3).map((room) => room.roomNumber), newRoomNumber(round)]
    : [];

  return (
    <Sheet open onClose={onClose} title={`${name}, round ${r}`}>
      <div className="pb-2">
        {mine
          ? <p className="text-[14px] text-[#5a6670]">{roomTitle(mine.roomNumber)}{mine.locked ? ', locked' : ''}</p>
          : <p className="text-[14px] text-[#5a6670]">Waiting in the basket</p>}
        {!canEdit && <p className="mt-2 text-[14px] text-[#5a6670]">This round can't change now.</p>}
        {canEdit && busy && <p role="status" className="mt-2 text-[14px] font-semibold text-[#1d6b5c]">Saving the last change first…</p>}
        {canEdit && held && <p className="mt-2 text-[14px] text-[#5a6670]">This meeting is locked. Unlock it first to move {name}.</p>}

        <ul className="mt-1 flex flex-col">
          {swaps.length > 0 && <Heading>Swap</Heading>}
          {swaps.map(({ seat, room }) => (
            <Row disabled={busy}
              key={`swap-${seat.userId}`}
              testId={`move-swap-${seat.userId}`}
              icon={<ArrowRightLeft className="h-4 w-4" aria-hidden="true" />}
              label={MOVE_COPY.swapWith(seat.displayName)}
              sub={[roomTitle(room), ...groupLabels(board, seat.groupKeys)].join(' · ')}
              hint={swapHint(board, r, person.userId, seat.userId)}
              onClick={() => act({ kind: 'swap', round: r, userId: person.userId, withUserId: seat.userId })}
            />
          ))}

          {freeRooms.length > 0 && <Heading>Move</Heading>}
          {freeRooms.map((room) => (
            <Row disabled={busy}
              key={`move-${room}`}
              testId={`move-room-${room}`}
              icon={<MoveRight className="h-4 w-4" aria-hidden="true" />}
              label={MOVE_COPY.moveTo(room)}
              hint={moveHint(board, r, person.userId, room)}
              onClick={() => act({ kind: 'move', round: r, userId: person.userId, toRoom: room })}
            />
          ))}

          {canEdit && mine && <Heading>This meeting</Heading>}
          {canEdit && mine && !held && (
            <Row disabled={busy} testId="move-basket" icon={<Inbox className="h-4 w-4" aria-hidden="true" />} label={MOVE_COPY.toBasket}
              onClick={() => act({ kind: 'unassign', round: r, userId: person.userId })} />
          )}
          {canEdit && mine && (
            mine.locked
              ? <Row disabled={busy} testId="move-unlock" icon={<LockOpen className="h-4 w-4" aria-hidden="true" />} label={MOVE_COPY.unlockMeeting}
                  onClick={() => act({ kind: 'unlock_room', round: r, room: mine.roomNumber })} />
              : <Row disabled={busy} testId="move-lock" icon={<Lock className="h-4 w-4" aria-hidden="true" />} label={MOVE_COPY.lockMeeting}
                  onClick={() => act({ kind: 'lock_room', round: r, room: mine.roomNumber })} />
          )}
          {canEdit && mine && !mine.locked && (
            mySeat?.slotLocked
              ? <Row disabled={busy} testId="move-unlock-seat" icon={<LockOpen className="h-4 w-4" aria-hidden="true" />} label={MOVE_COPY.unlockSeat(name)}
                  onClick={() => act({ kind: 'unlock_slot', round: r, userId: person.userId })} />
              : <Row disabled={busy} testId="move-lock-seat" icon={<Lock className="h-4 w-4" aria-hidden="true" />} label={MOVE_COPY.lockSeat(name)}
                  onClick={() => act({ kind: 'lock_slot', round: r, userId: person.userId })} />
          )}

          <Heading>Across the rounds</Heading>
          <Row testId="move-show-meetings" icon={<CalendarRange className="h-4 w-4" aria-hidden="true" />} label={MOVE_COPY.showMeetings(name)}
            onClick={() => { onClose(); onShowMeetings(person); }} />
        </ul>
      </div>
    </Sheet>
  );
}
