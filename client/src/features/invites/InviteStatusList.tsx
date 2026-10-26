// ─── Who is invited and who declined, always on screen for the people who run a pod or event (26 Oct 2026, C9) ───
//
// It replaces the "Pending Invites" chip and banner of the pod and event pages, the list they opened, and the event
// page's grey rows at the end of its participants: Claus closed the invite modal to see whether his invite had worked,
// and a decline was never shown. The pod page draws this for its director, host and admins; the event page for its
// host, co-hosts and admins while the event can still take people (the same people the server lets read the lists).
// Each invite can be reminded or withdrawn; Remind all goes to everyone still waiting. What it reads follows the
// pod's or event's invites tag, so an invite sent, accepted, declined or withdrawn changes it without a reload.
import { useId } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Link2, Send, Trash2 } from 'lucide-react';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import { useToastStore } from '@/stores/toastStore';
import { Skeleton } from '@/components/ui/Spinner';
import { cn } from '@/lib/utils';
import { inviteErrorSentence, targetTags, type InviteTarget, type Notice } from './invite-picker';
import {
  CHOOSE_PEOPLE, LOAD_FAILED, NOBODY_INVITED, NOT_REMINDED, NOT_WITHDRAWN, REMIND_GAP_MS, SHAREABLE_LINK, STATUS_TITLE, WITHDRAWN, WITHDRAW_CONFIRM,
  dayOf, inviteStatusGroups, personLine, remindAllSentence, remindSentence, settleInTurn, statusSummary, tallyReminders,
  type InviteListRow,
} from './invite-status';
import { invalidateTags } from './useInviteCandidates';

interface Props {
  target: InviteTarget;
  /** The ids of the people already in: the pod's active members, or the event's guests (neither Invited nor Declined). */
  present: readonly string[];
  /** How many are in, as the page counts them: Members of a pod, Going to an event. */
  presentCount: number;
  /** Opens the invite sheet: the empty list offers it too, which on a phone is far below the page's own button. */
  onInvite: () => void;
}

interface ReminderAnswer { reminded?: boolean; recentlyReminded?: boolean }

const CARD = 'rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5';
const ROW_BUTTON = 'inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60';

export default function InviteStatusList(props: Props) {
  return props.target.type === 'pod'
    ? <PodInviteStatus {...props} podId={props.target.podId} />
    : <EventInviteStatus {...props} sessionId={props.target.sessionId} />;
}

function PodInviteStatus({ podId, ...props }: Props & { podId: string }) {
  const pending = useQuery({
    queryKey: ['pod-pending-invites', podId],
    queryFn: () => api.get(`/invites/pod/${podId}?status=pending`).then((r) => (r.data.data ?? []) as InviteListRow[]),
    meta: { entities: [E.pod(podId), E.podInvites(podId)] },
  });
  const history = useQuery({
    queryKey: ['pod-invite-history', podId],
    queryFn: () => api.get(`/invites/pod/${podId}`).then((r) => (r.data.data ?? []) as InviteListRow[]),
    meta: { entities: [E.pod(podId), E.podInvites(podId)] },
  });
  // A pod has no remind-all route: each invite is reminded on its own, one at a time half a second apart (every reminder
  // is an email, and the provider drops sends that arrive together), and every answer is counted, so a reminder that did
  // not go is never called sent.
  const remindEveryoneInPod = async (rows: InviteListRow[]): Promise<Notice> => {
    const results = await settleInTurn(
      rows,
      (row) => api.post(`/invites/${row.id}/remind`).then((r) => r.data.data as ReminderAnswer),
      REMIND_GAP_MS,
    );
    return remindAllSentence(tallyReminders(results));
  };
  return <InviteStatusCard {...props} kind="pod" pending={pending} history={history} remindAll={remindEveryoneInPod} />;
}

function EventInviteStatus({ sessionId, ...props }: Props & { sessionId: string }) {
  const pending = useQuery({
    queryKey: ['session-pending-invites', sessionId],
    queryFn: () => api.get(`/invites/session/${sessionId}?status=pending`).then((r) => (r.data.data ?? []) as InviteListRow[]),
    meta: { entities: [E.session(sessionId), E.sessionInvites(sessionId)] },
  });
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
  remindAll: (rows: InviteListRow[]) => Promise<Notice>;
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
  const remindEveryone = useMutation({
    networkMode: 'always',
    mutationFn: remindAll,
    onSuccess: say,
    onError: (err) => addToast(inviteErrorSentence(err, NOT_REMINDED), 'error'),
  });
  const revokeInviteMutation = useMutation({
    networkMode: 'always',
    mutationFn: (inviteId: string) => api.delete(`/invites/${inviteId}`),
    onSuccess: () => {
      invalidateTags(qc, targetTags(target));
      addToast(WITHDRAWN, 'success');
    },
    onError: (err) => addToast(inviteErrorSentence(err, NOT_WITHDRAWN), 'error'),
  });
  const withdraw = (inviteId: string) => {
    if (revokeInviteMutation.isPending) return;
    if (window.confirm(WITHDRAW_CONFIRM)) revokeInviteMutation.mutate(inviteId);
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
            <div className="mt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-gray-700">Invited ({groups.invited.length})</h3>
                {groups.invited.length > 1 && (
                  <button
                    type="button"
                    onClick={() => { if (!remindEveryone.isPending) remindEveryone.mutate(groups.invited); }}
                    disabled={remindEveryone.isPending}
                    className={cn(ROW_BUTTON, 'border-purple-200 bg-white text-purple-700 hover:bg-purple-50')}
                  >
                    <Send className="h-3.5 w-3.5" aria-hidden="true" />
                    {remindEveryone.isPending ? 'Reminding…' : `Remind all (${groups.invited.length})`}
                  </button>
                )}
              </div>
              <ul className="mt-2 grid grid-cols-1 gap-2">
                {groups.invited.map((row) => {
                  const { name, detail } = personLine(row);
                  const reminding = remind.isPending && remind.variables === row.id;
                  const withdrawing = revokeInviteMutation.isPending && revokeInviteMutation.variables === row.id;
                  return (
                    <li key={row.id} data-testid={`invite-row-${row.id}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl border border-gray-100 p-3">
                      <div className="min-w-0 flex-[1_1_11rem]">
                        <p className="truncate text-sm font-medium text-gray-800">{name}</p>
                        {detail && <p className="truncate text-xs text-gray-500">{detail}</p>}
                        <p className="text-xs text-gray-500">Invited {dayOf(row.createdAt)}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          type="button"
                          onClick={() => { if (!reminding) remind.mutate(row.id); }}
                          disabled={reminding}
                          className={cn(ROW_BUTTON, 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50')}
                        >
                          <Send className="h-3.5 w-3.5" aria-hidden="true" /> {reminding ? 'Sending…' : 'Remind'}
                        </button>
                        <button
                          type="button"
                          onClick={() => withdraw(row.id)}
                          disabled={withdrawing}
                          className={cn(ROW_BUTTON, 'border-red-200 bg-white text-red-600 hover:bg-red-50')}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Withdraw
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {groups.declined.length > 0 && (
            <div className="mt-4">
              <h3 className="text-sm font-semibold text-gray-700">Declined ({groups.declined.length})</h3>
              <ul className="mt-2 grid grid-cols-1 gap-2">
                {groups.declined.map((row) => {
                  const { name, detail } = personLine(row);
                  return (
                    <li key={row.id} data-testid={`invite-row-${row.id}`} className="min-w-0 rounded-xl bg-gray-50 p-3">
                      <p className="truncate text-sm font-medium text-gray-700">{name}</p>
                      {detail && <p className="truncate text-xs text-gray-500">{detail}</p>}
                      <p className="text-xs text-gray-500">Declined {row.declinedAt ? dayOf(row.declinedAt) : ''}</p>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {groups.links.length > 0 && (
            <div className="mt-4">
              <h3 className="text-sm font-semibold text-gray-700">Shareable links ({groups.links.length})</h3>
              <ul className="mt-2 grid grid-cols-1 gap-2">
                {groups.links.map((row) => (
                  <li key={row.id} data-testid={`invite-row-${row.id}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl border border-gray-100 p-3">
                    <div className="min-w-0 flex-[1_1_11rem]">
                      <p className="flex items-center gap-1.5 text-sm font-medium text-gray-800">
                        <Link2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> {SHAREABLE_LINK}
                      </p>
                      <p className="text-xs text-gray-500">
                        Made {dayOf(row.createdAt)}
                        {row.maxUses !== undefined && row.useCount !== undefined ? ` · used ${row.useCount} of ${row.maxUses}` : ''}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => withdraw(row.id)}
                      disabled={revokeInviteMutation.isPending && revokeInviteMutation.variables === row.id}
                      className={cn(ROW_BUTTON, 'border-red-200 bg-white text-red-600 hover:bg-red-50')}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Withdraw
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
