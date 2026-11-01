// ─── Who is invited and who declined, always on screen for the people who run a pod or event (26 Oct 2026, C9) ───
//
// It replaces the "Pending Invites" chip and banner of the pod and event pages, the list they opened, and the event
// page's grey rows at the end of its participants: Claus closed the invite modal to see whether his invite had worked,
// and a decline was never shown. The pod page draws this for its director, host and admins; the event page for its
// host, co-hosts and admins while the event can still take people (the same people the server lets read the lists).
// Each invite can be reminded or withdrawn; Remind all goes to everyone still waiting. What it reads follows the
// pod's or event's invites tag, so an invite sent, accepted, declined or withdrawn changes it without a reload.
import { useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import { useToastStore } from '@/stores/toastStore';
import { Skeleton } from '@/components/ui/Spinner';
import { cn } from '@/lib/utils';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { inviteErrorSentence, targetTags, type InviteTarget, type Notice } from './invite-picker';
import {
  CHOOSE_PEOPLE, LOAD_FAILED, NOBODY_INVITED, NOT_REMINDED, NOT_REMINDED_ALL, NOT_WITHDRAWN, REMIND_GAP_MS, STATUS_TITLE, WITHDRAWN,
  WITHDRAW_BODY, WITHDRAW_TITLE, inviteStatusGroups, remindAllSentence, remindAllStopped, remindSentence, settleInTurn,
  statusSummary, tallyReminders, type InTurnOptions, type InviteListRow,
} from './invite-status';
import { DeclinedSection, InvitedSection, LinksSection, ROW_BUTTON, type RemindProgress } from './InviteStatusRows';
import { invalidateEntities } from '@/realtime/invalidate-entities';
import { usePendingInvites } from './useInviteCandidates';

interface Props {
  /** A pod's or an event's invitations (a circle has no such card). */
  target: Exclude<InviteTarget, { type: 'circle' }>;
  /** The ids of the people already in: the pod's active members, or the event's guests (neither Invited nor Declined). */
  present: readonly string[];
  /** How many are in, as the page counts them: Members of a pod, Going to an event. */
  presentCount: number;
  /** Opens the invite sheet: the empty list offers it too, which on a phone is far below the page's own button. */
  onInvite: () => void;
}

interface ReminderAnswer { reminded?: boolean; recentlyReminded?: boolean }

const CARD = 'rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5';

export default function InviteStatusList(props: Props) {
  return props.target.type === 'pod'
    ? <PodInviteStatus {...props} podId={props.target.podId} />
    : <EventInviteStatus {...props} sessionId={props.target.sessionId} />;
}

function PodInviteStatus({ podId, ...props }: Props & { podId: string }) {
  const pending = usePendingInvites(props.target);
  const history = useQuery({
    queryKey: ['pod-invite-history', podId],
    queryFn: () => api.get(`/invites/pod/${podId}`).then((r) => (r.data.data ?? []) as InviteListRow[]),
    meta: { entities: [E.pod(podId), E.podInvites(podId)] },
  });
  // A pod has no remind-all route: each invite is reminded on its own, one at a time half a second apart (every reminder
  // is an email, and the provider drops sends that arrive together), and every answer is counted, so a reminder that did
  // not go is never called sent. It says which reminder is on its way, and Stop sends no further one (P1 item 34).
  const remindEveryoneInPod = async (rows: InviteListRow[], options: InTurnOptions): Promise<Notice> => {
    const results = await settleInTurn(
      rows,
      (row) => api.post(`/invites/${row.id}/remind`).then((r) => r.data.data as ReminderAnswer),
      REMIND_GAP_MS,
      undefined,
      options,
    );
    const tally = tallyReminders(results);
    return results.length < rows.length ? remindAllStopped(tally, rows.length) : remindAllSentence(tally);
  };
  return <InviteStatusCard {...props} kind="pod" pending={pending} history={history} remindAll={remindEveryoneInPod} />;
}

function EventInviteStatus({ sessionId, ...props }: Props & { sessionId: string }) {
  const pending = usePendingInvites(props.target);
  const history = useQuery({
    queryKey: ['session-invite-history', sessionId],
    queryFn: () => api.get(`/invites/session/${sessionId}`).then((r) => (r.data.data ?? []) as InviteListRow[]),
    meta: { entities: [E.session(sessionId), E.sessionInvites(sessionId)] },
  });
  // The event's route reminds everyone still waiting and says how many went (a reminder sent within the hour is not sent
  // again, and is counted apart).
  const remindEveryoneAtEvent = async (): Promise<Notice> =>
    remindAllSentence((await api.post(`/invites/remind-all/${sessionId}`)).data.data);
  return <InviteStatusCard {...props} kind="session" pending={pending} history={history} remindAll={remindEveryoneAtEvent} />;
}

interface CardProps extends Props {
  kind: 'pod' | 'session';
  pending: UseQueryResult<InviteListRow[]>;
  history: UseQueryResult<InviteListRow[]>;
  remindAll: (rows: InviteListRow[], options: InTurnOptions) => Promise<Notice>;
}

function InviteStatusCard({ target, kind, pending, history, remindAll, present, presentCount, onInvite }: CardProps) {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const titleId = useId();
  const say = (notice: Notice) => addToast(notice.message, notice.tone);

  const remind = useMutation({
    networkMode: 'always',
    mutationFn: (inviteId: string) => api.post(`/invites/${inviteId}/remind`).then((r) => r.data.data as ReminderAnswer),
    onSuccess: (answer) => say(remindSentence(answer)),
    onError: (err) => addToast(inviteErrorSentence(err, NOT_REMINDED), 'error'),
  });
  // A pod's Remind all runs a reminder at a time: how far it is, and the Stop that ends it before the next one.
  const [progress, setProgress] = useState<RemindProgress | null>(null);
  const stopRef = useRef<AbortController | null>(null);
  const remindEveryone = useMutation({
    networkMode: 'always',
    mutationFn: (rows: InviteListRow[]) => {
      stopRef.current = new AbortController();
      return remindAll(rows, { onProgress: (done) => setProgress({ done, total: rows.length }), signal: stopRef.current.signal });
    },
    onSuccess: say,
    // Nothing was sent: said as such, with the server's reason when it gives one (P1 item 13).
    onError: (err) => addToast(`${NOT_REMINDED_ALL} ${inviteErrorSentence(err, 'Please try again in a moment.')}`, 'error'),
    onSettled: () => { setProgress(null); stopRef.current = null; },
  });
  const revokeInviteMutation = useMutation({
    networkMode: 'always',
    mutationFn: (inviteId: string) => api.delete(`/invites/${inviteId}`),
    onSuccess: () => {
      void invalidateEntities(qc, targetTags(target));
      addToast(WITHDRAWN, 'success');
    },
    onError: (err) => addToast(inviteErrorSentence(err, NOT_WITHDRAWN), 'error'),
  });
  // Withdraw asks first; the question stays open and busy until the server answers.
  const [askingWithdraw, setAskingWithdraw] = useState<string | null>(null);
  const withdraw = (inviteId: string) => {
    if (revokeInviteMutation.isPending) return;
    setAskingWithdraw(inviteId);
  };
  const confirmWithdraw = () => {
    if (!askingWithdraw || revokeInviteMutation.isPending) return;
    revokeInviteMutation.mutate(askingWithdraw, { onSettled: () => setAskingWithdraw(null) });
  };

  if (pending.isPending || history.isPending) {
    return (
      <section data-testid="invite-status" className={CARD} aria-busy="true">
        <h2 className="text-lg font-semibold text-[#1a1a2e]">{STATUS_TITLE}</h2>
        <div className="mt-3 grid grid-cols-3 gap-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}</div>
        <Skeleton className="mt-3 h-16" />
      </section>
    );
  }
  if (!pending.data || !history.data) {
    return (
      <section data-testid="invite-status" className={CARD}>
        <h2 className="text-lg font-semibold text-[#1a1a2e]">{STATUS_TITLE}</h2>
        <p role="alert" className="mt-2 text-sm text-gray-700">{LOAD_FAILED}</p>
        <button
          type="button"
          onClick={() => { void pending.refetch(); void history.refetch(); }}
          className={cn(ROW_BUTTON, 'mt-3 border-gray-300 bg-white text-gray-800 hover:bg-gray-50')}
        >
          Try again
        </button>
      </section>
    );
  }

  const groups = inviteStatusGroups(pending.data, history.data, new Set(present));
  const nothing = groups.invited.length === 0 && groups.declined.length === 0 && groups.links.length === 0;
  const withdrawingId = revokeInviteMutation.isPending ? revokeInviteMutation.variables ?? null : null;
  return (
    <section data-testid="invite-status" aria-labelledby={titleId} className={CARD}>
      <h2 id={titleId} className="text-lg font-semibold text-[#1a1a2e]">{STATUS_TITLE}</h2>
      <dl className="mt-3 grid grid-cols-3 gap-2">
        {statusSummary(kind, presentCount, groups).map((s) => (
          <div key={s.label} className="flex flex-col-reverse rounded-xl bg-gray-50 px-2 py-2 text-center">
            <dt className="text-xs text-gray-500">{s.label}</dt>
            <dd className="text-lg font-bold text-[#1a1a2e]">{s.count}</dd>
          </div>
        ))}
      </dl>

      {nothing ? (
        <div className="mt-4 flex flex-col items-start gap-3">
          <p className="text-sm text-gray-500">{NOBODY_INVITED}</p>
          <button type="button" onClick={onInvite} className={cn(ROW_BUTTON, 'border-gray-300 bg-white font-semibold text-[#1a1a2e] hover:bg-gray-50')}>
            {CHOOSE_PEOPLE}
          </button>
        </div>
      ) : (
        <>
          {groups.invited.length > 0 && (
            <InvitedSection
              rows={groups.invited}
              remindAllBusy={remindEveryone.isPending}
              progress={progress}
              onRemindAll={() => remindEveryone.mutate(groups.invited)}
              onStop={kind === 'pod' ? () => stopRef.current?.abort() : undefined}
              remindingId={remind.isPending ? remind.variables ?? null : null}
              withdrawingId={withdrawingId}
              onRemind={(id) => remind.mutate(id)}
              onWithdraw={withdraw}
            />
          )}
          {groups.declined.length > 0 && <DeclinedSection rows={groups.declined} />}
          {groups.links.length > 0 && <LinksSection rows={groups.links} withdrawingId={withdrawingId} onWithdraw={withdraw} />}
        </>
      )}
      <ConfirmDialog
        open={!!askingWithdraw}
        title={WITHDRAW_TITLE}
        body={WITHDRAW_BODY}
        confirmLabel="Withdraw"
        busyLabel="Withdrawing…"
        tone="danger"
        busy={revokeInviteMutation.isPending}
        onConfirm={confirmWithdraw}
        onCancel={() => setAskingWithdraw(null)}
      />
    </section>
  );
}
