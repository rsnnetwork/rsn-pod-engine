// ─── Invite people from your connections (26 Oct 2026, C9, POD-02 and the invites half of POD-04) ───
//
// One sheet for the pod page ("Invite members"), the event page ("Invite people", also opened on arrival with
// ?invite=1 after an event is scheduled) and, since T14 (1 Nov 2026), the circle page ("Invite people"), on the REASON
// Sheet: a bottom sheet on phones, a dialog from 768px, with a sticky footer. Your connections, newest first, 30 at a
// time with "Show more", searched by name, role or company. An event opens on its pod ("This pod ({n})"), with "Invite
// everyone in {pod} ({n})"; a pod and a circle list your connections only. People you choose become chips that stay
// while you search and fold into "+N"; the footer sends them all in one call. Rows say Member, Going, Invited or
// Declined and cannot be chosen again. After a send the rows change in place and the sheet stays open until "Done".
// "Invite by email" and "Share a link" (whose note says the link's real cap) are for anyone else.
// P29: the parts live beside it (InviteChosenChips, InviteCandidateList, InviteExtras, useInvitePicker).
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link2, Mail, Search } from 'lucide-react';
import type { InviteCandidateSource } from '@rsn/shared';
import Sheet from '@/features/reason/ui/Sheet';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { cn } from '@/lib/utils';
import {
  BATCH_FULL, DONE, INVITE_BY_EMAIL, SEARCH_PLACEHOLDER, SHARE_A_LINK, YOUR_CONNECTIONS,
  countLabel, inviteEveryoneLabel, linkCap, pickerTitle, podSegmentLabel, sendLabel, type InviteTarget,
} from './invite-picker';
import { targetKey, useInviteCandidates } from './useInviteCandidates';
import { usePodCounts, useInvitePicker } from './useInvitePicker';
import InviteChosenChips from './InviteChosenChips';
import InviteCandidateList from './InviteCandidateList';
import { EmailInvite, ShareLink } from './InviteExtras';
import { BUTTON, QUIET } from './invite-sheet-style';

interface Props {
  open: boolean;
  onClose: () => void;
  target: InviteTarget;
  /** The pod's name (the pod itself, or the event's pod), for "Invite everyone in {pod}". */
  podName?: string;
  /** What a shareable link lets in: the pod's maximum members or the event's capacity; 500 when unset. */
  linkCap?: number | null;
}

export default function InvitePickerSheet(props: Props) {
  // A closed sheet keeps nothing: each opening starts with nobody chosen, no search and the first list.
  if (!props.open) return null;
  return <OpenPicker {...props} />;
}

function OpenPicker({ onClose, target, podName, linkCap: capacity }: Props) {
  const qc = useQueryClient();
  // Every page the sheet read is forgotten when it closes, so the next opening reads one page: a refetch re-reads every
  // page loaded so far, against 60 reads a minute. While it is open the pages stay, so a cleared search shows them again.
  const forget = useRef(targetKey(target));
  useEffect(() => () => { qc.removeQueries({ queryKey: forget.current }); }, [qc]);
  const [segment, setSegment] = useState<InviteCandidateSource>(target.type === 'session' && target.podId ? 'pod' : 'connections');
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search.trim(), 300);
  const [extra, setExtra] = useState<'email' | 'link' | null>(null);
  const cap = linkCap(capacity);

  const list = useInviteCandidates(target, segment, q, true);
  const picker = useInvitePicker(target, list.dataUpdatedAt);
  const { chosen, sent, full, sending, sendNow } = picker;
  const pod = usePodCounts(target, sent);

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
            disabled={chosen.size === 0 || sending}
            className="inline-flex min-h-[44px] items-center rounded-[11px] bg-reason-red px-4 text-[14px] font-bold text-white enabled:hover:bg-reason-red-hover disabled:opacity-60"
          >
            {sending ? 'Sending…' : sendLabel(chosen.size)}
          </button>
        </>
      )}
    >
      {pod.hasPod && (
        <div role="group" aria-label="Who to list" className="mt-3 grid grid-cols-2 gap-1 rounded-[13px] bg-reason-soft p-1">
          {([['pod', podSegmentLabel(pod.count)], ['connections', YOUR_CONNECTIONS]] as const).map(([key, label]) => (
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

      <InviteChosenChips chosen={[...chosen.values()]} onRemove={picker.unchoose} />
      {full && <p role="status" className="mt-2 text-[13px] text-reason-muted">{BATCH_FULL}</p>}

      {segment === 'pod' && pod.available > 0 && (
        <button
          type="button"
          onClick={() => sendNow([], true)}
          disabled={sending}
          className={cn(BUTTON, 'mt-3 w-full border border-reason-red bg-white text-reason-red hover:bg-reason-pink disabled:opacity-60')}
        >
          {inviteEveryoneLabel(podName, countLabel(pod.available, pod.complete))}
        </button>
      )}

      <InviteCandidateList
        query={list}
        segment={segment}
        searched={q}
        podName={podName}
        sent={sent}
        chosen={chosen}
        full={full}
        onToggle={picker.toggle}
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
