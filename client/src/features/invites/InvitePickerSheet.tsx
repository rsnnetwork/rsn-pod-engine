// ─── Invite people from your connections (26 Oct 2026, C9, POD-02 and the invites half of POD-04) ───
//
// One sheet for the pod page ("Invite members") and the event page ("Invite people", also opened on arrival with
// ?invite=1 after an event is scheduled), on the REASON Sheet: a bottom sheet on phones, a dialog from 768px, with a
// sticky footer. Your connections, newest first, 30 at a time with "Show more", searched by name, role or company. An
// event opens on its pod ("This pod ({n})"), with "Invite everyone in {pod} ({n})". People you choose become chips that
// stay while you search and fold into "+N"; the footer sends them all in one call. Rows say Member, Going, Invited or
// Declined and cannot be chosen again. After a send the rows change in place and the sheet stays open until "Done".
// "Invite by email" and "Share a link" (whose note says the link's real cap) are for anyone else.
import { useEffect, useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Check, Copy, Link2, Mail, Search, X } from 'lucide-react';
import type { InviteCandidate, InviteCandidateSource, InviteCandidateState } from '@rsn/shared';
import Sheet from '@/features/reason/ui/Sheet';
import ReasonSheep from '@/features/reason/brand/ReasonSheep';
import { CONNECTION_LOST } from '@/features/reason/errors';
import Avatar from '@/components/ui/Avatar';
import { Skeleton } from '@/components/ui/Spinner';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { formResolver } from '@/lib/form-resolver';
import { cn } from '@/lib/utils';
import { useToastStore } from '@/stores/toastStore';
import {
  BATCH_FULL, BATCH_MAX, CHIPS_SHOWN, DONE, INVITE_BY_EMAIL, LINK_NOT_MADE, LOAD_MORE_FAILED, NOT_SENT, POD_PAGES_MAX,
  SEARCH_PLACEHOLDER, SHARE_A_LINK, SHOW_MORE, YOUR_CONNECTIONS,
  batchSentence, canPick, chipsView, countLabel, effectiveState, emailSchema, everyoneOnce, inviteErrorSentence,
  inviteEveryoneLabel, linkCap, pickerTitle, podSegmentLabel, sendLabel, shareLinkNote, stateAfter, stateLabel,
  type EmailValues, type InviteTarget,
} from './invite-picker';
import { targetKey, useInviteByEmail, useInviteCandidates, useSendInvites, useShareLink } from './useInviteCandidates';

interface Props {
  open: boolean;
  onClose: () => void;
  target: InviteTarget;
  /** The pod's name (the pod itself, or the event's pod), for "Invite everyone in {pod}". */
  podName?: string;
  /** What a shareable link lets in: the pod's maximum members or the event's capacity; 500 when unset. */
  linkCap?: number | null;
}

interface Chosen { userId: string; displayName: string }

const BUTTON = 'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-[11px] px-4 text-[14px] font-bold';
const QUIET = cn(BUTTON, 'border border-reason-line bg-white text-[#2d3440] hover:bg-reason-soft');
const BADGE: Record<InviteCandidateState, string> = {
  available: '',
  member: 'bg-[#e8f6ef] text-[#11744a]',
  going: 'bg-[#e8f6ef] text-[#11744a]',
  invited: 'bg-[#fff4e5] text-[#8a4f06]',
  declined: 'bg-reason-soft text-[#4f5562]',
};

export default function InvitePickerSheet(props: Props) {
  // A closed sheet keeps nothing: each opening starts with nobody chosen, no search and the first list.
  if (!props.open) return null;
  return <OpenPicker {...props} />;
}

function OpenPicker({ onClose, target, podName, linkCap: capacity }: Props) {
  const addToast = useToastStore((s) => s.addToast);
  const qc = useQueryClient();
  // Every page the sheet read is forgotten when it closes, so the next opening reads one page: a refetch re-reads every
  // page loaded so far, against 60 reads a minute. While it is open the pages stay, so a cleared search shows them again.
  const forget = useRef(targetKey(target));
  useEffect(() => () => { qc.removeQueries({ queryKey: forget.current }); }, [qc]);
  const hasPod = target.type === 'session' && !!target.podId;
  const [segment, setSegment] = useState<InviteCandidateSource>(target.type === 'session' && target.podId ? 'pod' : 'connections');
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search.trim(), 300);
  const [chosen, setChosen] = useState<Map<string, Chosen>>(() => new Map());
  // Where people stand after a send, until the list read again says so itself (see effectiveState).
  const [sent, setSent] = useState<Map<string, InviteCandidateState>>(() => new Map());
  const [extra, setExtra] = useState<'email' | 'link' | null>(null);
  const cap = linkCap(capacity);

  const list = useInviteCandidates(target, segment, q, true);
  // The whole pod, unsearched, for its two counts. While the pod segment is shown unsearched it is the same query.
  const pod = useInviteCandidates(target, 'pod', '', hasPod);
  const { hasNextPage: podHasMore, isFetchingNextPage: podFetching, isFetchNextPageError: podStuck, fetchNextPage: podNext } = pod;
  const podPages = pod.data?.pages.length ?? 0;
  useEffect(() => {
    // Read a pod of up to 200 to its end, so its counts are exact; a bigger one says "200+".
    if (podHasMore && !podFetching && !podStuck && podPages < POD_PAGES_MAX) void podNext();
  }, [podHasMore, podFetching, podStuck, podPages, podNext]);
  const podPeople = everyoneOnce(pod.data?.pages ?? []);
  const podComplete = !!pod.data && !podHasMore;
  const podCount = pod.data ? countLabel(podPeople.length, podComplete) : null;
  const podAvailable = podPeople.filter((p) => canPick(effectiveState(p, sent))).length;

  // A ref, not isPending: a double tap lands before React draws the button as disabled.
  const inFlight = useRef(false);
  const send = useSendInvites(target, {
    onSuccess: (res) => {
      const { message, tone } = batchSentence(res);
      addToast(message, tone);
      setSent((before) => {
        const next = new Map(before);
        for (const r of res.results) {
          const state = stateAfter(r.outcome);
          if (state) next.set(r.userId, state);
        }
        return next;
      });
      // Everyone answered for leaves the chips; someone whose invite failed stays chosen, to try again.
      setChosen((before) => {
        const next = new Map(before);
        for (const r of res.results) if (r.outcome !== 'failed') next.delete(r.userId);
        return next;
      });
    },
    onError: (err) => addToast(inviteErrorSentence(err, NOT_SENT), 'error'),
    onSettled: () => { inFlight.current = false; },
  });
  const sendNow = (ids: string[], allPodMembers = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    send.mutate({ ids, allPodMembers });
  };

  const full = chosen.size >= BATCH_MAX;
  const toggle = (person: InviteCandidate) => {
    setChosen((before) => {
      const next = new Map(before);
      if (next.has(person.userId)) next.delete(person.userId);
      else if (next.size < BATCH_MAX) next.set(person.userId, { userId: person.userId, displayName: person.displayName });
      return next;
    });
  };
  const unchoose = (userId: string) => setChosen((before) => {
    const next = new Map(before);
    next.delete(userId);
    return next;
  });

  return (
    <Sheet
      open
      onClose={onClose}
      title={pickerTitle(target)}
      footer={(
        <>
          <button type="button" onClick={onClose} className="inline-flex min-h-[44px] items-center rounded-[11px] border border-reason-line px-4 text-[14px] font-bold">
            {DONE}
          </button>
          <button
            type="button"
            data-testid="invite-send"
            onClick={() => sendNow([...chosen.keys()])}
            disabled={chosen.size === 0 || send.isPending}
            className="inline-flex min-h-[44px] items-center rounded-[11px] bg-reason-red px-4 text-[14px] font-bold text-white enabled:hover:bg-reason-red-hover disabled:opacity-60"
          >
            {send.isPending ? 'Sending…' : sendLabel(chosen.size)}
          </button>
        </>
      )}
    >
      {hasPod && (
        <div role="group" aria-label="Who to list" className="mt-3 grid grid-cols-2 gap-1 rounded-[13px] bg-reason-soft p-1">
          {([['pod', podSegmentLabel(podCount)], ['connections', YOUR_CONNECTIONS]] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={segment === key}
              onClick={() => setSegment(key)}
              className={cn('min-h-[44px] rounded-[10px] px-2 text-[13px] font-bold', segment === key ? 'bg-white text-reason-ink shadow-sm' : 'text-[#4f5562]')}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <label className="relative mt-3 block">
        <span className="sr-only">{segment === 'pod' ? 'Search the pod' : 'Search your connections'}</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-reason-muted" aria-hidden="true" />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          maxLength={100}
          enterKeyHint="search"
          placeholder={SEARCH_PLACEHOLDER}
          className="min-h-[44px] w-full rounded-[11px] border border-reason-line bg-white pl-9 pr-3 text-[16px] text-reason-ink placeholder:text-reason-muted md:text-[14px]"
        />
      </label>

      <ChosenChips chosen={[...chosen.values()]} onRemove={unchoose} />
      {full && <p role="status" className="mt-2 text-[13px] text-reason-muted">{BATCH_FULL}</p>}

      {segment === 'pod' && podAvailable > 0 && (
        <button
          type="button"
          onClick={() => sendNow([], true)}
          disabled={send.isPending}
          className={cn(BUTTON, 'mt-3 w-full border border-reason-red bg-white text-reason-red hover:bg-reason-pink disabled:opacity-60')}
        >
          {inviteEveryoneLabel(podName, countLabel(podAvailable, podComplete))}
        </button>
      )}

      <CandidateList
        query={list}
        segment={segment}
        searched={q}
        podName={podName}
        sent={sent}
        chosen={chosen}
        full={full}
        onToggle={toggle}
      />

      <div className="mt-4 border-t border-reason-line pt-3">
        <div className="grid grid-cols-2 gap-2">
          <button type="button" aria-expanded={extra === 'email'} onClick={() => setExtra(extra === 'email' ? null : 'email')} className={cn(QUIET, 'px-2 text-[13px]')}>
            <Mail className="h-4 w-4 shrink-0" aria-hidden="true" /> {INVITE_BY_EMAIL}
          </button>
          <button type="button" aria-expanded={extra === 'link'} onClick={() => setExtra(extra === 'link' ? null : 'link')} className={cn(QUIET, 'px-2 text-[13px]')}>
            <Link2 className="h-4 w-4 shrink-0" aria-hidden="true" /> {SHARE_A_LINK}
          </button>
        </div>
        {extra === 'email' && <EmailInvite target={target} />}
        {extra === 'link' && <ShareLink target={target} cap={cap} />}
      </div>
    </Sheet>
  );
}

/** The people chosen so far, each a chip that removes them; after three the rest fold into "+N". */
function ChosenChips({ chosen, onRemove }: { chosen: Chosen[]; onRemove: (userId: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  if (chosen.length === 0) return null;
  const { chips, more } = chipsView(chosen, expanded);
  return (
    <div className="mt-3 flex flex-wrap gap-2" aria-label="Chosen">
      {chips.map((c) => (
        <button
          key={c.userId}
          type="button"
          onClick={() => onRemove(c.userId)}
          aria-label={`Remove ${c.displayName}`}
          className="inline-flex min-h-[44px] max-w-full items-center gap-1.5 rounded-full bg-reason-pink pl-3 pr-2.5 text-[13px] font-bold text-reason-ink"
        >
          <span className="max-w-[10rem] truncate">{c.displayName}</span>
          <X className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        </button>
      ))}
      {more > 0 && (
        <button type="button" onClick={() => setExpanded(true)} aria-label={`Show all ${chosen.length} chosen`} className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full border border-reason-line px-3 text-[13px] font-bold">
          +{more}
        </button>
      )}
      {expanded && chosen.length > CHIPS_SHOWN && (
        <button type="button" onClick={() => setExpanded(false)} className="inline-flex min-h-[44px] items-center rounded-full px-3 text-[13px] font-bold text-reason-muted underline">
          Show fewer
        </button>
      )}
    </div>
  );
}

interface ListProps {
  query: ReturnType<typeof useInviteCandidates>;
  segment: InviteCandidateSource;
  searched: string;
  podName?: string;
  sent: ReadonlyMap<string, InviteCandidateState>;
  chosen: ReadonlyMap<string, Chosen>;
  full: boolean;
  onToggle: (person: InviteCandidate) => void;
}

/** The list: loading, a refusal or no connection, nobody, or the people with "Show more". */
function CandidateList({ query, segment, searched, podName, sent, chosen, full, onToggle }: ListProps) {
  const { data, isPending, isError, fetchStatus, refetch, hasNextPage, fetchNextPage, isFetchingNextPage, isFetchNextPageError, isPlaceholderData } = query;
  const people = everyoneOnce(data?.pages ?? []);
  const whose = segment === 'pod' ? "the pod's members" : 'your connections';

  if (data === undefined && (isError || (isPending && fetchStatus === 'paused'))) {
    return (
      <div role="alert" className="mt-3 rounded-2xl border border-reason-line p-3.5">
        <p className="text-[14px] font-bold">We could not load {whose} just now.</p>
        {fetchStatus === 'paused' && <p className="mt-1 text-[13px] text-reason-muted">{CONNECTION_LOST}</p>}
        <button type="button" onClick={() => void refetch()} className={cn(BUTTON, 'mt-3 bg-reason-red text-white hover:bg-reason-red-hover')}>Try again</button>
      </div>
    );
  }
  if (isPending) {
    return (
      <div className="mt-3 grid gap-2" aria-busy="true">
        <p className="sr-only">Loading {whose}</p>
        {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-[56px]" />)}
      </div>
    );
  }
  if (people.length === 0) {
    return (
      <div className="mt-3 flex items-start gap-3 rounded-2xl bg-reason-warm p-3.5">
        <ReasonSheep pose="hopeful" className="h-[52px] w-[52px] shrink-0" />
        <div className="min-w-0 text-[13px] text-reason-muted [overflow-wrap:anywhere]">
          {searched ? (
            <p className="font-bold text-reason-ink">Nobody in {segment === 'pod' ? 'the pod' : 'your connections'} matches “{searched}”.</p>
          ) : segment === 'pod' ? (
            <p className="font-bold text-reason-ink">Nobody else is in {podName || 'this pod'} yet.</p>
          ) : (
            <>
              <p className="font-bold text-reason-ink">No connections yet.</p>
              <p className="mt-1">When someone accepts your meeting request, or you meet at an event, they are listed here. Anyone else you can invite by email or with a link, below.</p>
            </>
          )}
        </div>
      </div>
    );
  }
  return (
    <>
      {isPlaceholderData && <p aria-live="polite" className="mt-2 text-[12px] text-reason-muted">Searching…</p>}
      <ul className="mt-2 divide-y divide-reason-line" aria-label={segment === 'pod' ? 'Members of the pod' : YOUR_CONNECTIONS}>
        {people.map((person) => (
          <CandidateRow
            key={person.userId}
            person={person}
            state={effectiveState(person, sent)}
            checked={chosen.has(person.userId)}
            full={full}
            onToggle={onToggle}
          />
        ))}
      </ul>
      {isFetchNextPageError && <p role="alert" className="mt-2 text-[13px] text-reason-muted">{LOAD_MORE_FAILED}</p>}
      {hasNextPage && (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            onClick={() => { if (!isFetchingNextPage) void fetchNextPage(); }}
            aria-disabled={isFetchingNextPage || undefined}
            className={cn(QUIET, isFetchingNextPage && 'cursor-progress')}
          >
            {isFetchingNextPage ? 'Loading more…' : SHOW_MORE}
          </button>
        </div>
      )}
    </>
  );
}

/** A person: a checkbox the whole row toggles, their name and work, and where they stand when they cannot be chosen. */
function CandidateRow({ person, state, checked, full, onToggle }: {
  person: InviteCandidate; state: InviteCandidateState; checked: boolean; full: boolean; onToggle: (person: InviteCandidate) => void;
}) {
  const label = stateLabel(state);
  const pickable = canPick(state);
  const blocked = !pickable || (!checked && full);
  const work = [person.jobTitle, person.company].filter(Boolean).join(' · ');
  return (
    <li>
      <label
        data-testid={`invite-candidate-${person.userId}`}
        className={cn('flex min-h-[56px] items-center gap-3 py-2', blocked ? 'cursor-not-allowed' : 'cursor-pointer')}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={blocked}
          onChange={() => onToggle(person)}
          className="h-5 w-5 shrink-0 accent-reason-red"
        />
        <Avatar src={person.avatarUrl} name={person.displayName} size="md" className="shrink-0" />
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate text-[14px] font-bold', !pickable && 'text-[#4f5562]')}>{person.displayName}</span>
          {work && <span className="block truncate text-[12px] text-reason-muted">{work}</span>}
        </span>
        {label && <span className={cn('shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold', BADGE[state])}>{label}</span>}
      </label>
    </li>
  );
}

/** One address, checked at the field; the server's refusal (already invited, can't be invited) is said there too. */
function EmailInvite({ target }: { target: InviteTarget }) {
  const addToast = useToastStore((s) => s.addToast);
  const fieldId = useId();
  const errorId = useId();
  const form = useForm<EmailValues>({ defaultValues: { email: '' }, resolver: formResolver(emailSchema) });
  const invite = useInviteByEmail(target, {
    onSuccess: (email) => {
      addToast(`Invitation sent to ${email}.`, 'success');
      form.reset({ email: '' });
    },
    onError: (err) => form.setError('email', { type: 'server', message: inviteErrorSentence(err, 'That invitation could not be sent. Try again.') }),
  });
  // Asked for, so the field is ready to type in (the sheet itself never focuses a field on opening).
  const { setFocus } = form;
  useEffect(() => { setFocus('email'); }, [setFocus]);
  const submit = form.handleSubmit(({ email }) => { if (!invite.isPending) invite.mutate(email); });
  const error = form.formState.errors.email?.message;
  return (
    <form onSubmit={submit} noValidate className="mt-3 grid gap-1.5">
      <label htmlFor={fieldId} className="text-[12px] font-bold">Their email address</label>
      <div className="flex flex-col gap-2 min-[420px]:flex-row">
        <input
          id={fieldId}
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="name@example.com"
          aria-invalid={!!error || undefined}
          aria-describedby={error ? errorId : undefined}
          {...form.register('email')}
          className="min-h-[44px] min-w-0 flex-1 rounded-[11px] border border-reason-line bg-white px-3 text-[16px] text-reason-ink placeholder:text-reason-muted md:text-[14px]"
        />
        <button type="submit" disabled={invite.isPending} className={cn(BUTTON, 'bg-reason-red text-white enabled:hover:bg-reason-red-hover disabled:opacity-60')}>
          {invite.isPending ? 'Sending…' : 'Send invite'}
        </button>
      </div>
      {error && <p id={errorId} role="alert" className="text-[13px] text-reason-red">{error}</p>}
    </form>
  );
}

/** A link anyone can use, up to the real cap, for a week: what it allows is said before it is made. */
function ShareLink({ target, cap }: { target: InviteTarget; cap: number }) {
  const [link, setLink] = useState<string | null>(null);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const make = useShareLink(target, cap, {
    onSuccess: (code) => { setLink(`${window.location.origin}/invite/${code}`); setError(null); },
    onError: (err) => setError(inviteErrorSentence(err, LINK_NOT_MADE)),
  });
  const copyLink = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  };
  return (
    <div className="mt-3 grid gap-2">
      <p className="text-[13px] text-reason-muted">{shareLinkNote(target, cap)}</p>
      {link ? (
        <div className="flex gap-2">
          <input
            readOnly
            value={link}
            aria-label="Invite link"
            onFocus={(e) => e.currentTarget.select()}
            className="min-h-[44px] min-w-0 flex-1 rounded-[11px] border border-reason-line bg-reason-soft px-3 text-[16px] text-reason-ink md:text-[14px]"
          />
          <button type="button" onClick={() => void copyLink(link)} className={cn(QUIET, 'shrink-0 px-3')}>
            {copy === 'copied' ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
            {copy === 'copied' ? 'Copied' : 'Copy'}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => { if (!make.isPending) make.mutate(); }}
          disabled={make.isPending}
          className={cn(QUIET, 'w-full disabled:opacity-60')}
        >
          {make.isPending ? 'Making the link…' : 'Make a link'}
        </button>
      )}
      {copy === 'failed' && <p role="status" className="text-[13px] text-reason-muted">Select the link above and copy it.</p>}
      {error && <p role="alert" className="text-[13px] text-reason-red">{error}</p>}
    </div>
  );
}
