// ─── The organiser's settings on the event page (Part 2 Task 11; spec 03, 04, 05, 11) ───────────────────────────────
// In order: the event's status and lifecycle steps, the RSN Call link, admission, matching groups and (Part 3 Task 10)
// the extra matching questions. Each card asks the server and draws nothing for someone it refuses, so `mayRunEvent`
// (the page's guess at who runs the event) only spares everyone else the requests. Admission and groups change only
// before the event (the server refuses while it is live or once it is over), so they show only then; groups only for an
// event with rounds. The questions show while live too, locked.
import { DEFAULT_SESSION_CONFIG, type EventGroupsView } from '@rsn/shared';
import { isEventLifecycleChip } from './statusConfig';
import type { StatusPhase } from './statusConfig';
import EventLifecycleActions from './lifecycle/EventLifecycleActions';
import CallLinkCard from './CallLinkCard';
import EventAdmissionCard from './admission/EventAdmissionCard';
import EventGroupsCard from './groups/EventGroupsCard';
import EventQuestionsCard from './questions/EventQuestionsCard';

/** The fields of GET /sessions/:id these cards read. */
export interface OrganiserEvent {
  id: string;
  title?: string | null;
  lifecycle?: unknown;
  allowedActions?: unknown;
  archivedAt?: string | null;
  cancelReason?: string | null;
  config?: { numberOfRounds?: number } | null;
}

interface Props {
  event: OrganiserEvent;
  phase: StatusPhase;
  mayRunEvent: boolean;
  isRoundsEvent: boolean;
  /** The owner or a super admin: the only people who may choose who can override the group rules. */
  mayChooseOverride: boolean;
  groups: { data?: EventGroupsView; isLoading: boolean; isError: boolean; error: unknown; refetch: () => unknown };
}

export default function OrganiserSettings({ event, phase, mayRunEvent, isRoundsEvent, mayChooseOverride, groups }: Props) {
  const lifecycle = isEventLifecycleChip(event.lifecycle) ? event.lifecycle : null;
  const hasActions = Array.isArray(event.allowedActions) && event.allowedActions.length > 0;
  if (!mayRunEvent && !hasActions) return null;
  const title = event.title || 'Event';
  const before = phase === 'pre' && lifecycle !== 'archived';
  // The rounds the server checks the rules against: the event's own, else the platform default (as event-groups does).
  const numberOfRounds = Math.max(1, Number(event.config?.numberOfRounds) || DEFAULT_SESSION_CONFIG.numberOfRounds);

  return (
    <section aria-label="Event settings" data-testid="organiser-settings" className="grid min-w-0 gap-4">
      {lifecycle && (
        <EventLifecycleActions
          sessionId={event.id}
          title={title}
          lifecycle={lifecycle}
          allowedActions={event.allowedActions}
          archived={!!event.archivedAt}
          cancelReason={event.cancelReason}
        />
      )}
      {mayRunEvent && (phase === 'pre' || phase === 'live') && <CallLinkCard sessionId={event.id} isDraft={lifecycle === 'draft'} />}
      {mayRunEvent && before && <EventAdmissionCard sessionId={event.id} title={title} />}
      {mayRunEvent && before && isRoundsEvent && <EventGroupsCard sessionId={event.id} numberOfRounds={numberOfRounds} view={groups} mayChooseOverride={mayChooseOverride} />}
      {/* Part 3 Task 10: the extra matching questions, after the groups; shown live too, locked (the server refuses a change). */}
      {mayRunEvent && (before || phase === 'live') && isRoundsEvent && <EventQuestionsCard sessionId={event.id} locked={phase === 'live'} />}
    </section>
  );
}
