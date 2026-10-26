import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { Loader2, Users } from 'lucide-react';
import { GROUP_CHAT_MAX_MEMBERS, GROUP_CHAT_MIN_MEMBERS } from '@rsn/shared';
import Sheet from '@/features/reason/ui/Sheet';
import { formResolver } from '@/lib/form-resolver';
import { useAuthStore } from '@/stores/authStore';
import { TEXT_BUTTON } from '@/features/messages/buttons';
import PeopleChoices from '@/features/messages/PeopleChoices';
import { useEventPeople, useMyGroups, useStartGroupChat } from '@/features/messages/useGroups';
import {
  CANCEL, EVENT_GROUPS, GROUP_FULL, GROUP_LIMIT, GROUP_TOO_SMALL, PEOPLE_FAILED, PEOPLE_LEGEND, START_FAILED,
  START_INTRO, START_MANY, START_SUBMIT, START_TITLE, TRY_AGAIN,
  byName, groupErrorSentence, ofMax, roomLeft, startBody, startChosen, startProblem, startSchema, tookPart,
  type EventPerson, type StartValues,
} from '@/features/messages/group-chat-text';

// ─── "Start a group chat" on a completed event's page (26 Oct 2026, C12, COM-04) ───
//
// For the people who ran the event, beside "Message everyone who took part": a group chat in Messages with the people
// who took part, 3 to 50 with the organiser. The sheet lists them, everyone ticked when they all fit; when more than 49
// took part the organiser picks up to 49, and is pointed to the message-everyone panel for the rest. The groups already
// started from this event are linked here, so a second press is a choice, not an accident.

// min-w-0: the card is an item of the event page's grid, which would otherwise grow to fit a long group name on one line
// and push both after-event cards past the edge of a phone.
const CARD = 'min-w-0 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm';

export default function StartGroupChatCard({ sessionId }: { sessionId: string }) {
  const myUserId = useAuthStore((s) => s.user?.id as string | undefined);
  const people = useEventPeople(sessionId);
  const groups = useMyGroups();
  const [open, setOpen] = useState(false);

  if (people.isPending) {
    return (
      <div data-testid="start-group-loading" className={CARD} aria-busy="true">
        <div className="h-4 w-44 max-w-full animate-pulse rounded bg-gray-200" />
        <div className="mt-3 h-3 w-full animate-pulse rounded bg-gray-100" />
        <div className="mt-4 h-11 w-44 max-w-full animate-pulse rounded-xl bg-gray-100" />
      </div>
    );
  }
  if (people.isError) {
    return (
      <section data-testid="start-group-error" className={CARD}>
        <p className="text-sm text-gray-700">{PEOPLE_FAILED}</p>
        <button
          type="button"
          onClick={() => { void people.refetch(); }}
          className={`${TEXT_BUTTON} mt-3 w-full border border-gray-300 bg-white text-gray-800 hover:bg-gray-50 sm:w-auto`}
        >
          {TRY_AGAIN}
        </button>
      </section>
    );
  }

  const candidates = byName(tookPart(people.data, myUserId ? [myUserId] : []));
  const tooFew = candidates.length + 1 < GROUP_CHAT_MIN_MEMBERS;
  const fromThisEvent = (groups.data ?? []).filter((g) => g.sessionId === sessionId);

  return (
    <section data-testid="start-group-chat" aria-labelledby="start-group-title" className={CARD}>
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rsn-red/10">
          <Users className="h-5 w-5 text-rsn-red" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 id="start-group-title" className="text-base font-semibold text-[#1a1a2e]">{START_TITLE}</h2>
          <p className="mt-1 text-sm text-gray-500">{START_INTRO} {GROUP_LIMIT}</p>
        </div>
      </div>

      {fromThisEvent.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-semibold text-gray-500">{EVENT_GROUPS}</p>
          <ul className="mt-1 divide-y divide-gray-100">
            {fromThisEvent.map((g) => (
              <li key={g.id}>
                <Link to={`/messages/g/${g.id}`} className="flex min-h-[44px] items-center justify-between gap-3 text-sm text-[#1a1a2e] hover:underline">
                  <span className="min-w-0 truncate font-medium">{g.name}</span>
                  <span className="shrink-0 text-xs text-gray-500">{ofMax(g.memberCount)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {tooFew ? (
        <p data-testid="start-group-too-few" className="mt-3 text-sm text-gray-600">{GROUP_TOO_SMALL}</p>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`${TEXT_BUTTON} mt-4 w-full bg-rsn-red text-white hover:bg-rsn-red-hover sm:w-auto`}
        >
          <Users className="h-4 w-4" aria-hidden="true" /> {START_TITLE}
        </button>
      )}

      {open && <StartSheet sessionId={sessionId} candidates={candidates} onClose={() => setOpen(false)} />}
    </section>
  );
}

/** Who is in the new group: the people who took part, ticked; "{n} of 50" as they choose; Start opens the group. */
function StartSheet({ sessionId, candidates, onClose }: { sessionId: string; candidates: EventPerson[]; onClose: () => void }) {
  const navigate = useNavigate();
  const start = useStartGroupChat(sessionId);
  const [refusal, setRefusal] = useState<string | null>(null);
  const { register, handleSubmit, watch } = useForm<StartValues>({
    defaultValues: { memberIds: startChosen(candidates) },
    resolver: formResolver(startSchema),
  });
  const chosen = watch('memberIds') ?? [];
  const problem = startProblem(chosen.length);
  const room = roomLeft(1, chosen.length);
  const close = () => { if (!start.isPending) onClose(); };

  const submit = handleSubmit(({ memberIds }) => {
    setRefusal(null);
    start.mutate(startBody(memberIds, candidates), {
      onSuccess: (created) => {
        onClose();
        navigate(`/messages/g/${created.id}`);
      },
      onError: (err) => setRefusal(groupErrorSentence(err, START_FAILED)),
    });
  });

  const footer = (
    <>
      <button type="button" onClick={close} disabled={start.isPending} className={`${TEXT_BUTTON} border border-gray-300 bg-white text-gray-700 hover:bg-gray-50`}>
        {CANCEL}
      </button>
      <button
        type="submit"
        form="start-group-form"
        disabled={start.isPending || problem !== null}
        aria-describedby={problem ? 'start-group-problem' : undefined}
        className={`${TEXT_BUTTON} bg-rsn-red text-white hover:bg-rsn-red-hover`}
      >
        {start.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        {START_SUBMIT}
      </button>
    </>
  );

  return (
    <Sheet open onClose={close} title={START_TITLE} footer={footer}>
      <form id="start-group-form" onSubmit={submit} noValidate data-testid="start-group-form">
        <p data-testid="start-group-count" className="text-sm font-semibold text-[#1a1a2e]">{ofMax(chosen.length + 1)}</p>
        <p className="mt-0.5 text-sm text-gray-500">{GROUP_LIMIT}</p>
        {candidates.length > GROUP_CHAT_MAX_MEMBERS - 1 && <p className="mt-2 text-sm text-gray-700">{START_MANY}</p>}
        <div className="mt-3">
          <PeopleChoices legend={PEOPLE_LEGEND} people={candidates} chosen={chosen} room={room} field={register('memberIds')} />
        </div>
        {/* Why Start is off (too few), or why the boxes not ticked are off (the group would be full). */}
        {problem && <p id="start-group-problem" className="mt-2 text-sm text-gray-600">{problem}</p>}
        {!problem && room === 0 && chosen.length < candidates.length && <p className="mt-2 text-sm text-gray-600">{GROUP_FULL}</p>}
        {refusal && <p role="alert" data-testid="start-group-refusal" className="mt-2 text-sm text-red-600">{refusal}</p>}
      </form>
    </Sheet>
  );
}
