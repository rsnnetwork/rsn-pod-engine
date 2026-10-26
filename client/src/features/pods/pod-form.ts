// ─── The create-pod form's rules (26 Oct 2026) ───────────────────────────────────────────────────
//
// Stefan and Claus, on production, 25 Oct: choosing a Reason pod left Orchestration on Timed Rounds, so they set Free
// Form by hand ("orchestration should follow the pod type"). The shared pod-type table (shared/src/events) says what a
// type's events run as, which modes it allows and what it communicates by; this file applies it to the form.
//
// A setting follows the type until the member sets it. One they chose stays while the new type allows it, and is
// replaced, with a notice, when it does not: never silently (applyTypeChange, the same rule the server's table
// belongs to). Pure functions, so what a type change does is tested without a browser.

import { applyTypeChange, podTypeRule, ORCHESTRATION_MODES } from '@rsn/shared';
import type { PodType, OrchestrationMode } from '@rsn/shared';

export interface PodForm {
  name: string;
  description: string;
  podType: string;
  orchestrationMode: string;
  communicationMode: string;
  visibility: string;
  maxMembers: number | '';
  allowMemberInvites?: boolean;
}

/** The fields a pod type decides. */
type TypeFollowing = Pick<PodForm, 'podType' | 'orchestrationMode' | 'communicationMode'>;

/** What a new pod's form starts on. */
const START_TYPE = 'speed_networking';

/**
 * The form as it opens. A new pod is a speed-networking pod on that type's own orchestration and communication. A
 * duplicate starts as a copy: the source pod's orchestration counts as chosen, read through its type (an old Reason
 * pod saved on timed rounds opens as Freeform, with the notice saying so), and its communication is kept as it was,
 * until the type changes (see afterTypeChange).
 */
export function startingPodForm(initial?: Partial<PodForm>): { values: PodForm; notices: string[]; chosen: Set<string> } {
  const base: PodForm = {
    name: '',
    description: '',
    podType: START_TYPE,
    orchestrationMode: '',
    communicationMode: '',
    visibility: 'private',
    maxMembers: '',
    allowMemberInvites: false,
    ...initial,
  };
  const chosen = new Set<string>(initial ? ['orchestrationMode', 'communicationMode'] : []);
  const { values, notices } = applyTypeChange(base, base.podType as PodType, chosen);
  return { values, notices, chosen };
}

/**
 * What the form's type-following fields become when the type changes, what to tell the member, and what is still
 * theirs to keep. A choice the new type replaced is no longer a choice: the form holds the type's own default now,
 * so going back to the old type finds that type's default, and says nothing a second time.
 */
export function afterTypeChange(
  current: PodForm,
  nextType: string,
  chosen: ReadonlySet<string>,
): { values: TypeFollowing; notices: string[]; chosen: Set<string> } {
  // Communication is nobody's choice on this form (its control is gone), so a type change gives the new type's own,
  // even to a duplicate that started with its source's.
  const stillChosen = new Set(chosen);
  stillChosen.delete('communicationMode');
  const { values, notices } = applyTypeChange(current, nextType as PodType, stillChosen);
  if (notices.length > 0) stillChosen.delete('orchestrationMode');
  return {
    values: { podType: values.podType, orchestrationMode: values.orchestrationMode, communicationMode: values.communicationMode },
    notices,
    chosen: stillChosen,
  };
}

/** The orchestration modes a type allows, as a select lists them (the type's own default first). */
export function orchestrationOptions(podType: string): Array<{ value: string; label: string }> {
  return podTypeRule(podType as PodType).orchestration.allowed.map((mode) => ({ value: mode, label: ORCHESTRATION_MODES[mode].label }));
}

/** The one line a type with a single mode shows instead of a select: "Events in this pod run as Freeform: everyone together in one room." */
export function orchestrationLine(mode: string): string {
  const row = ORCHESTRATION_MODES[mode as OrchestrationMode];
  if (!row) return '';
  return `Events in this pod run as ${row.label}: ${row.summary.charAt(0).toLowerCase()}${row.summary.slice(1)}.`;
}
