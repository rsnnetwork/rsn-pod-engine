// ─── "Matching groups" on the event page, for its organisers (Part 2 Task 11; spec 05, 07) ──────────────────────────
// The event's groups with how many people are in each, its round rules, the fallback, and the capacity notice the
// server worked out for the people registered now (spec 05: RSN says when groups are uneven). Set up / Edit opens the
// groups form; Remove groups asks first. Organisers only: anyone else gets no rules back, and the card draws nothing.
import { useState } from 'react';
import { Pencil, Trash2, Users } from 'lucide-react';
import type { EventGroupRules, EventGroupsView } from '@rsn/shared';
import { useConfirm } from '@/hooks/useConfirm';
import { useToastStore } from '@/stores/toastStore';
import { notForThisViewer, organiserSentence } from '../organiser-errors';
import { DANGER_BUTTON, EmptyRow, ErrorRow, LoadingRows, OrganiserCard, PRIMARY_BUTTON, QUIET_BUTTON } from '../organiser-ui';
import { FALLBACK_OPTIONS, GROUPS_COPY, ruleLine } from './group-form';
import { useSaveEventGroups } from './useEventGroups';
import CapacityNotice from './CapacityNotice';
import GroupsEditorSheet from './GroupsEditorSheet';

interface Props {
  sessionId: string;
  numberOfRounds: number;
  /** The page's read of the groups (useEventGroups), shared with the participant list's group chips. */
  view: { data?: EventGroupsView; isLoading: boolean; isError: boolean; error: unknown; refetch: () => unknown };
}

export default function EventGroupsCard({ sessionId, numberOfRounds, view }: Props) {
  const addToast = useToastStore((s) => s.addToast);
  const { ask, confirmDialog } = useConfirm();
  const save = useSaveEventGroups(sessionId);
  const [editing, setEditing] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // Not an organiser (no rules in the answer) or refused: nothing to show.
  if (view.isError && notForThisViewer(view.error)) return null;
  if (view.data && view.data.rules === undefined) return null;

  const rules = view.data?.rules ?? null;
  const counts = view.data?.counts ?? {};
  const ungrouped = view.data?.ungrouped ?? 0;
  const hasGroups = !!rules && rules.groups.length > 0;

  const saveRules = (next: EventGroupRules) => {
    setServerError(null);
    return save.mutateAsync(next).then(() => {
      addToast(next.groups.length === 0 ? GROUPS_COPY.removed : GROUPS_COPY.saved, 'success');
      setEditing(false);
    }, (err: unknown) => {
      setServerError(organiserSentence(err, GROUPS_COPY.fallback));
      throw err;
    });
  };
  const removeAll = async () => {
    if (!rules || !(await ask({ title: GROUPS_COPY.removeTitle, body: GROUPS_COPY.removeBody, confirmLabel: GROUPS_COPY.remove, tone: 'danger' }))) return;
    saveRules({ ...rules, groups: [], rounds: [] }).catch((err: unknown) => addToast(organiserSentence(err, GROUPS_COPY.fallback), 'error'));
  };
  const openEditor = () => { setServerError(null); setEditing(true); };

  return (
    <OrganiserCard
      testId="event-groups-card"
      title={GROUPS_COPY.title}
      hint={GROUPS_COPY.hint}
      action={view.data && (
        <button type="button" data-testid="groups-edit" onClick={openEditor} className={hasGroups ? QUIET_BUTTON : PRIMARY_BUTTON}>
          <Pencil className="h-4 w-4" aria-hidden="true" /> {hasGroups ? GROUPS_COPY.edit : GROUPS_COPY.setUp}
        </button>
      )}
    >
      {view.isLoading && <LoadingRows label="Loading the groups" />}
      {view.isError && <ErrorRow message={GROUPS_COPY.error} onRetry={() => view.refetch()} />}
      {view.data && !hasGroups && <EmptyRow testId="groups-empty">{GROUPS_COPY.none}</EmptyRow>}
      {rules && hasGroups && (
        <div className="space-y-3">
          <ul className="flex flex-wrap gap-2">
            {rules.groups.map((g) => (
              <li key={g.key} data-testid="group-summary" className="inline-flex min-w-0 items-center gap-2 rounded-full bg-gray-100 px-3 py-1.5 text-sm text-[#1a1a2e]">
                <Users className="h-4 w-4 shrink-0 text-gray-500" aria-hidden="true" />
                <span className="min-w-0 [overflow-wrap:anywhere]">{g.label}</span>
                <span className="text-gray-500">{GROUPS_COPY.members(counts[g.key] ?? 0)}</span>
              </li>
            ))}
          </ul>
          {ungrouped > 0 && <p className="text-sm text-amber-700">{GROUPS_COPY.ungrouped(ungrouped)}</p>}
          <ul className="space-y-1 text-sm text-gray-700">
            {rules.rounds.map((r) => <li key={`${r.fromRound}-${r.toRound}`} className="[overflow-wrap:anywhere]">{ruleLine(r, rules.groups)}</li>)}
            <li className="text-gray-500">{GROUPS_COPY.fallbackLegend} {FALLBACK_OPTIONS.find((o) => o.value === rules.fallback)?.label}</li>
          </ul>
          <CapacityNotice rules={rules} counts={counts} ungrouped={ungrouped} numberOfRounds={numberOfRounds} />
          <button type="button" onClick={() => void removeAll()} disabled={save.isPending} className={DANGER_BUTTON}>
            <Trash2 className="h-4 w-4" aria-hidden="true" /> {GROUPS_COPY.remove}
          </button>
        </div>
      )}
      <GroupsEditorSheet
        open={editing}
        onClose={() => setEditing(false)}
        saved={rules}
        counts={counts}
        ungrouped={ungrouped}
        numberOfRounds={numberOfRounds}
        busy={save.isPending}
        onSave={saveRules}
        serverError={serverError}
      />
      {confirmDialog}
    </OrganiserCard>
  );
}
