// ─── The organiser matching board (10 Nov 2026 spec, Part 2 Task 13; spec 06, 07, 12/06-10) ───────────────
//
// /sessions/:sessionId/board, for the people running a rounds event. A round view ("ROUND 02 / MATCHING BOARD",
// rooms, the basket) and an all-rounds table; Auto generate, edit by drag and drop on a desktop pointer or by select and
// move (MoveSheet) on a phone or the keyboard, lock, redistribute, late and no-show marks, conflicts, and Publish. The
// server checks and answers every change with the whole board (useBoard); this page only decides what to ask.
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Loader2 } from 'lucide-react';
import type { BoardOp, BoardOpResult, BoardPerson, BoardRoom, ScheduleBoard } from '@rsn/shared';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import { useConfirm } from '@/hooks/useConfirm';
import { useToastStore } from '@/stores/toastStore';
import { Skeleton } from '@/components/ui/Spinner';
import { dropIntent, dropRefusal, type DragSource, type DropTarget } from './board-dnd';
import {
  BOARD_COPY, NO_FILTER, personOfOp, roundOf, roundTitle, startsAtLabel,
  type BoardConflict, type BoardFilter,
} from './board-model';
import { useBoard } from './useBoard';
import { feedbackFor, useMoveFeedback } from './useMoveFeedback';
import BoardToolbar from './BoardToolbar';
import BoardFilters, { type BoardView } from './BoardFilters';
import RoundView from './RoundView';
import AllRoundsOverview from './AllRoundsOverview';
import MoveSheet from './MoveSheet';
import RefusalSheet from './RefusalSheet';
import PersonTimeline from './PersonTimeline';
import PublishPanel from './PublishPanel';
import LiveConflictsNotice from './LiveConflictsNotice';

const BACK = 'inline-flex min-h-[44px] items-center gap-2 text-[14px] text-[#5a6670] hover:text-[#12293a]';

/** A mouse or trackpad: drag and drop is offered there; a touch screen uses select and move. */
function useFinePointer(): boolean {
  const query = '(pointer: fine)';
  const [fine, setFine] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const change = () => setFine(list.matches);
    list.addEventListener('change', change);
    return () => list.removeEventListener('change', change);
  }, []);
  return fine;
}

const seatedCount = (result: BoardOpResult) => new Set(result.changed.flatMap((c) => c.userIds)).size;
const firstEditableRound = (board: ScheduleBoard) => board.rounds.find((r) => r.editable)?.roundNumber ?? board.rounds[0]?.roundNumber ?? 1;

export default function MatchingBoardPage() {
  const { sessionId = '' } = useParams();
  const { data: session } = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => api.get(`/sessions/${sessionId}`).then((r) => r.data.data as { title?: string }),
    enabled: !!sessionId,
    meta: { entities: [E.session(sessionId)] },
  });
  const { board, isLoading, error, refetch, busy, run, runAll, applyReturnedBoard, refusal, clearRefusal } = useBoard(sessionId);
  const { ask, confirmDialog } = useConfirm();
  const addToast = useToastStore((s) => s.addToast);
  const fine = useFinePointer();
  const [view, setView] = useState<BoardView>('round');
  const [roundNo, setRoundNo] = useState<number | null>(null);
  const [filter, setFilter] = useState<BoardFilter>(NO_FILTER);
  const [editing, setEditing] = useState(true);
  const [dragging, setDragging] = useState<DragSource | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [timelineFor, setTimelineFor] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [focusRoom, setFocusRoom] = useState<number | null>(null);
  const feedback = useMoveFeedback(board);

  useEffect(() => {
    if (focusRoom === null) return;
    document.querySelector(`[data-testid="board-room-${focusRoom}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFocusRoom(null);
  }, [focusRoom]);

  const back = <Link to={`/sessions/${sessionId}`} className={BACK}><ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to the event</Link>;

  if (isLoading) {
    return (
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-3" aria-busy="true">
        {back}
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-[420px] w-full" />
      </div>
    );
  }
  // A board on screen stays there when a refresh fails (a dropped connection): only a first read that failed shows this.
  if (!board) {
    return (
      <div className="mx-auto w-full max-w-[720px]">
        {back}
        <div className="mt-3 rounded-2xl border border-[#e3e7ea] bg-white p-6 text-center">
          <p className="text-[15px] text-[#3d4a55]">{error?.message ?? "We couldn't load the board. Try again."}</p>
          {error?.status !== 403 && error?.status !== 404 && (
            <button type="button" onClick={() => void refetch()} className="mt-3 inline-flex min-h-[44px] items-center rounded-xl bg-[#12293a] px-4 text-[14px] font-bold text-white">
              Try again
            </button>
          )}
        </div>
      </div>
    );
  }

  const active = roundOf(board, roundNo ?? firstEditableRound(board));
  const r = active?.roundNumber ?? 1;
  const roundRooms = active?.rooms ?? [];
  const canEditRound = editing && !!active?.editable;
  const lockAction = !canEditRound || roundRooms.length === 0 ? null : roundRooms.some((room) => !room.locked) ? 'lock' : 'unlock';
  const findPerson = (id: string | null): BoardPerson | undefined => (id && active
    ? active.rooms.flatMap((room) => room.seats).find((s) => s.userId === id) ?? active.basket.find((p) => p.userId === id)
    : undefined);
  const selectedPerson = findPerson(selected);
  const timelinePerson = timelineFor ? board.people.find((p) => p.userId === timelineFor) ?? findPerson(timelineFor) : undefined;

  /**
   * One change, with its feedback (fix round 1): once the server answers, focus goes to the person it moved, in their
   * new seat, and the live region says where they are; a refused change gives focus back to where it started.
   */
  const act = async (o: BoardOp, opts: { origin?: string | null; success?: (res: BoardOpResult) => string | null } = {}) => {
    const origin = opts.origin ?? personOfOp(o);
    const outcome = await run({ kind: 'op', op: o }, opts.success);
    feedback.apply(feedbackFor(outcome, o, origin, board, outcome.ok ? opts.success?.(outcome.result) ?? null : null));
  };
  const op = (o: BoardOp, success?: string) => void act(o, success ? { success: () => success } : {});
  const onDrop = (target: DropTarget) => {
    const source = dragging;
    setDragging(null);
    // One write at a time: a drop made while the last change is on its way is not taken (the board shows it is busy).
    if (!source || busy) return;
    const intent = dropIntent(source, target);
    if (intent) void act(intent, { origin: source.userId });
    else if (dropRefusal(source, target)) addToast(dropRefusal(source, target)!, 'info');
  };
  const onSelect = (person: BoardPerson) => (canEditRound ? setSelected(person.userId) : setTimelineFor(person.userId));
  const toggleRoomLock = (room: BoardRoom) => op(room.locked ? { kind: 'unlock_room', round: r, room: room.roomNumber } : { kind: 'lock_room', round: r, room: room.roomNumber });
  const redistribute = () => void act({ kind: 'redistribute', rounds: [r] }, { success: (res) => {
    const n = seatedCount(res);
    return n === 0 ? 'Nobody else can be seated in this round under its rules.' : `Redistributed: ${n} ${n === 1 ? 'person' : 'people'} placed.`;
  } });
  const generate = async () => {
    const planned = board.rounds.some((round) => round.editable && round.rooms.some((room) => !room.locked));
    if (planned && !(await ask({
      title: 'Auto generate the rounds?',
      body: 'Every round that has not started is planned again with the matching rules. Locked meetings and seats stay as they are.',
      confirmLabel: 'Auto generate',
    }))) return;
    void run({ kind: 'generate', rounds: 'all' }, () => 'The rounds are planned. Locked meetings stayed as they were.');
  };
  const toggleRoundLock = () => {
    const locking = lockAction === 'lock';
    const ops: BoardOp[] = roundRooms.filter((room) => room.locked !== locking)
      .map((room) => ({ kind: locking ? 'lock_room' : 'unlock_room', round: r, room: room.roomNumber }));
    void runAll(ops, locking ? `Every meeting in round ${r} is locked.` : `Round ${r} is unlocked.`);
  };
  const showConflict = (c: BoardConflict) => { setView('round'); setRoundNo(c.round); setFocusRoom(c.room); };
  const time = startsAtLabel(active?.startsAt ?? null);

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-[1200px] flex-col gap-4">
      <div className="flex flex-col gap-1">
        {back}
        <p className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-[#c4532f]">Organiser workbench</p>
        <h1 className="text-[24px] font-extrabold leading-tight tracking-[-0.03em] text-[#12293a] [overflow-wrap:anywhere] sm:text-[32px]">
          {session?.title ? `Matching board: ${session.title}` : 'Matching board'}
        </h1>
        <p className="text-[14px] text-[#5a6670]" data-testid="board-publish-state">
          {board.publishedVersion === null
            ? 'A private draft. Attendees see nothing until you publish.'
            : `Version ${board.publishedVersion} is published${board.draftDiffersFromPublished ? '; the draft has changes since' : ''}.`}
        </p>
        {error && <p role="status" className="text-[13px] text-amber-800">The board could not refresh just now. It catches up as soon as the connection is back.</p>}
      </div>

      <LiveConflictsNotice conflicts={board.liveConflicts} onShow={showConflict} onPublish={() => setPublishOpen(true)} />

      <section className="flex min-w-0 flex-col gap-4 rounded-[20px] bg-[#f1f4f4] p-3 sm:p-5" aria-label="Matching board" aria-busy={busy}>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <h2 className="text-[17px] font-extrabold uppercase tracking-[0.04em] text-[#12293a] sm:text-[20px]">
              {view === 'round' ? roundTitle(r) : BOARD_COPY.allRoundsTitle}
            </h2>
            {view === 'round' && time && <p className="text-[13px] text-[#5a6670]">Starts about {time}</p>}
            {busy && (
              <p data-testid="board-saving" className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-0.5 text-[12px] font-semibold text-[#1d6b5c]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Saving the last change…
              </p>
            )}
            {/* What the last change did, read out politely; a new element each time so the same words are read again. */}
            <p role="status" aria-live="polite" data-testid="board-announcement" className="mt-1 text-[13px] text-[#3d4a55]">
              {feedback.announcement.text && <span key={feedback.announcement.n}>{feedback.announcement.text}</span>}
            </p>
          </div>
          <BoardToolbar
            canGenerate={editing && board.rounds.some((round) => round.editable)}
            editing={editing}
            lockAction={view === 'round' ? lockAction : null}
            busy={busy}
            onGenerate={() => void generate()}
            onToggleEdit={() => setEditing((v) => !v)}
            onToggleLock={toggleRoundLock}
            onPublish={() => setPublishOpen(true)}
          />
        </div>

        <BoardFilters
          view={view} onView={setView} rounds={board.rounds} round={r} onRound={setRoundNo}
          groups={board.groupRules?.groups ?? []} filter={filter} onFilter={setFilter}
        />

        {view === 'round' && !active && (
          <p className="rounded-2xl bg-white px-4 py-6 text-center text-[14px] text-[#5a6670]">This event has no rounds to plan yet.</p>
        )}
        {view === 'round' && active && (
          <RoundView
            sessionId={sessionId} board={board} round={active} editing={editing} draggable={fine}
            filter={filter} selectedId={selected} dragging={dragging} busy={busy}
            onSelect={onSelect} onDragStart={setDragging} onDragEnd={() => setDragging(null)} onDrop={onDrop}
            onToggleRoomLock={toggleRoomLock} onRedistribute={redistribute} onShowConflict={showConflict}
          />
        )}
        {view === 'all' && (
          <AllRoundsOverview board={board} filter={filter} onOpenPerson={setTimelineFor}
            onOpenRound={(n) => { setView('round'); setRoundNo(n); }} />
        )}
      </section>

      {selectedPerson && active && (
        <MoveSheet board={board} round={active} person={selectedPerson} canEdit={canEditRound} busy={busy}
          onRun={(o) => void act(o, { origin: selectedPerson.userId })} onShowMeetings={(p) => setTimelineFor(p.userId)} onClose={() => setSelected(null)} />
      )}
      {timelinePerson && (
        <PersonTimeline board={board} person={timelinePerson} busy={busy} canEdit={editing}
          onRun={(o, success) => op(o, success)} onClose={() => setTimelineFor(null)} />
      )}
      {refusal && (
        <RefusalSheet board={board} refusal={refusal} onChoose={(o) => void act(o)}
          onClose={() => { clearRefusal(); feedback.releaseFocusAfterSheet(board.revision); }} />
      )}
      <PublishPanel sessionId={sessionId} board={board} open={publishOpen} onClose={() => setPublishOpen(false)} applyReturnedBoard={applyReturnedBoard} />
      {confirmDialog}
    </div>
  );
}

