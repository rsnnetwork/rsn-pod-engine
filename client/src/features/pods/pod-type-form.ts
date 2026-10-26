// client/src/features/pods/pod-type-form.ts
// The pod forms' rules (26 Oct 2026): what a new, duplicated or edited pod starts on, what a change of pod type does
// to its orchestration and communication, the orchestration control a type gets, the size hint, what the fields
// accept, what the forms send, and how a refusal lands. The pod types themselves are the shared table
// (shared/src/events). Pure on purpose (no React, axios, store or router), so a test can run it:
// server/src/__tests__/client/pod-type-form.test.ts.
//
// 25 Oct walkthrough (production): "Pod type: Reason pod. Orchestration is of course not timed rounds, it's
// freeform, but that should be automatic when I choose Reason pod" (Claus). They set Free Form by hand.
//
// A setting follows the type until the member sets it; one they chose stays while the new type allows it, and is
// replaced, with a notice, when it does not: never silently. Communication is never asked: it follows the type.

import { ORCHESTRATION_MODES, POD_TYPES, applyTypeChange, effectiveOrchestration, podTypeRule } from '@rsn/shared';
import type { CommunicationMode, OrchestrationMode, PodType } from '@rsn/shared';
import { errorMessage } from '../reason/errors';

export interface PodFormValues {
  name: string;
  description: string;
  podType: PodType;
  orchestrationMode: OrchestrationMode;
  /** Never asked (25 Oct decision 13): it follows the pod type. */
  communicationMode: CommunicationMode;
  visibility: string;
  /** As the field holds it: blank for no limit. */
  maxMembers: string;
  allowMemberInvites: boolean;
  /** The edit form's pod rules. */
  rules: string;
}

/** A pod as it arrives from the API (or a duplicate's starting values): any of it may be missing. */
export interface PodSource {
  name?: string | null;
  description?: string | null;
  podType?: string | null;
  orchestrationMode?: string | null;
  communicationMode?: string | null;
  visibility?: string | null;
  maxMembers?: number | string | null;
  allowMemberInvites?: boolean | null;
  rules?: string | null;
}

export const POD_NAME_REQUIRED = 'Give your pod a name';
/** The server's limit on a pod name (routes/pods.ts). */
export const POD_NAME_MAX = 200;
export const MAX_MEMBERS_PROBLEM = 'Max members must be a whole number from 1 to 10,000.';
export const TYPE_CHANGE_NOTE = 'Events already scheduled keep their event type.';
const CHECK_POD = "Check the pod's settings and try again.";

/** A new pod's type until the member picks another (production's form starts there too). */
const START_TYPE = 'speed_networking' as string as PodType;
const COMMUNICATION_MODES = ['video', 'audio', 'text', 'hybrid'];

const isPodType = (v: unknown): v is PodType => typeof v === 'string' && Object.prototype.hasOwnProperty.call(POD_TYPES, v);
const isOrchestration = (v: unknown): v is OrchestrationMode => typeof v === 'string' && Object.prototype.hasOwnProperty.call(ORCHESTRATION_MODES, v);
const isCommunication = (v: unknown): v is CommunicationMode => typeof v === 'string' && COMMUNICATION_MODES.includes(v);
const asText = (n: number | string | null | undefined) => (n === null || n === undefined ? '' : String(n));

/** "Reason pods", "Chat pods", "Speed Networking pods". */
function podTypeNoun(label: string): string {
  return label.endsWith(' Pod') ? `${label.slice(0, -' Pod'.length)} pods` : `${label} pods`;
}

/** Every pod type with its one line from the table, in the table's order (Reason first). */
export function podTypeChoices(): { value: PodType; label: string; summary: string }[] {
  return (Object.keys(POD_TYPES) as PodType[]).map((value) => ({ value, label: POD_TYPES[value].label, summary: POD_TYPES[value].summary }));
}

/**
 * The create form as it opens. A new pod starts on its type's own orchestration and communication. A duplicate
 * carries the source pod's choices: its orchestration counts as chosen and is read through its type, so an old Reason
 * pod saved on timed rounds opens as Freeform with the notice saying so; communication follows the type.
 */
export function newPodValues(source?: PodSource): { values: PodFormValues; chosen: Set<string>; notices: string[] } {
  const podType = isPodType(source?.podType) ? source.podType : START_TYPE;
  const base: PodFormValues = {
    name: source?.name ?? '',
    description: source?.description ?? '',
    podType,
    orchestrationMode: (isOrchestration(source?.orchestrationMode) ? source.orchestrationMode : podTypeRule(podType).orchestration.default),
    communicationMode: podTypeRule(podType).communication,
    visibility: source?.visibility ?? 'private',
    maxMembers: asText(source?.maxMembers),
    allowMemberInvites: !!source?.allowMemberInvites,
    rules: source?.rules ?? '',
  };
  const chosen = new Set<string>(isOrchestration(source?.orchestrationMode) ? ['orchestrationMode'] : []);
  const { values, notices } = applyTypeChange(base, podType, chosen);
  return { values, chosen, notices };
}

/**
 * The edit form as it opens. The saved orchestration counts as chosen. An old combination (a Reason pod on timed
 * rounds) is shown as its type reads it, with a note, and saved only when the director saves.
 */
export function editPodValues(pod: PodSource): { values: PodFormValues; chosen: Set<string>; note: string | null } {
  const podType = isPodType(pod.podType) ? pod.podType : START_TYPE;
  const rule = podTypeRule(podType);
  const stored = isOrchestration(pod.orchestrationMode) ? pod.orchestrationMode : null;
  const effective = effectiveOrchestration({ podType, orchestrationMode: stored });
  const values: PodFormValues = {
    name: pod.name ?? '',
    description: pod.description ?? '',
    podType,
    orchestrationMode: effective,
    communicationMode: isCommunication(pod.communicationMode) ? pod.communicationMode : rule.communication,
    visibility: pod.visibility ?? 'private',
    maxMembers: asText(pod.maxMembers),
    allowMemberInvites: !!pod.allowMemberInvites,
    rules: pod.rules ?? '',
  };
  const note = stored && stored !== effective
    ? `This pod was set to ${ORCHESTRATION_MODES[stored].label}, which ${podTypeNoun(rule.label)} don't use. Saving changes it to ${ORCHESTRATION_MODES[effective].label}.`
    : null;
  return { values, chosen: new Set(['orchestrationMode']), note };
}

/** The form after its pod type changes, and what to tell the member (applyTypeChange, the table's own rule). */
export function changeType(values: PodFormValues, next: PodType, chosen: ReadonlySet<string>): { values: PodFormValues; notices: string[] } {
  const { values: changed, notices } = applyTypeChange(values, next, chosen);
  return { values: changed, notices };
}

/** "Events in this pod run as Freeform: everyone together in one room." */
export function orchestrationLine(mode: OrchestrationMode): string {
  const row = ORCHESTRATION_MODES[mode];
  return `Events in this pod run as ${row.label}: ${row.summary.charAt(0).toLowerCase()}${row.summary.slice(1)}.`;
}

export type OrchestrationChoice =
  | { kind: 'line'; text: string }
  | { kind: 'select'; options: { value: OrchestrationMode; label: string; summary: string }[] };

/** A type with one mode says it in one line; a type with several offers only those, its default first. */
export function orchestrationChoice(podType: PodType): OrchestrationChoice {
  const { allowed } = podTypeRule(podType).orchestration;
  if (allowed.length === 1) return { kind: 'line', text: orchestrationLine(allowed[0]) };
  return {
    kind: 'select',
    options: allowed.map((value) => ({ value, label: ORCHESTRATION_MODES[value].label, summary: ORCHESTRATION_MODES[value].summary })),
  };
}

/** The recommended size, shown and never enforced: "Up to 12 recommended" for a Reason pod. */
export function sizeHint(podType: PodType): string | null {
  const n = podTypeRule(podType).sizeHint;
  return n ? `Up to ${n} recommended` : null;
}

export function podNameProblem(name: string): string | null {
  const t = (name ?? '').trim();
  if (!t) return POD_NAME_REQUIRED;
  return t.length > POD_NAME_MAX ? `Keep the name to ${POD_NAME_MAX} characters.` : null;
}

/** Blank is no limit; otherwise a whole number from 1 to 10,000 (the server's limits). */
export function maxMembersProblem(text: string): string | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  if (!/^\d+$/.test(t)) return MAX_MEMBERS_PROBLEM;
  const n = Number(t);
  return n >= 1 && n <= 10000 ? null : MAX_MEMBERS_PROBLEM;
}

export interface NewPodBody {
  name: string;
  description?: string;
  podType: PodType;
  orchestrationMode: OrchestrationMode;
  communicationMode: CommunicationMode;
  visibility: string;
  maxMembers?: number;
  allowMemberInvites: boolean;
}

export interface PodChangesBody {
  name: string;
  description: string;
  podType: PodType;
  orchestrationMode: OrchestrationMode;
  communicationMode: CommunicationMode;
  visibility: string;
  maxMembers: number | null;
  rules: string;
  allowMemberInvites: boolean;
}

/** Public (open join) means anyone may join, so members may always invite. */
const membersMayInvite = (v: PodFormValues) => (v.visibility === 'public' ? true : v.allowMemberInvites);

/** POST /pods: the orchestration the form shows and the communication its type implies. */
export function podBody(v: PodFormValues): NewPodBody {
  const max = v.maxMembers.trim();
  return {
    name: v.name.trim(),
    description: v.description.trim() || undefined,
    podType: v.podType,
    orchestrationMode: v.orchestrationMode,
    communicationMode: v.communicationMode,
    visibility: v.visibility,
    maxMembers: max ? Number(max) : undefined,
    allowMemberInvites: membersMayInvite(v),
  };
}

/** PUT /pods/:id: every field; a cleared max members is null (no limit). */
export function podChanges(v: PodFormValues): PodChangesBody {
  const max = v.maxMembers.trim();
  return {
    name: v.name.trim(),
    description: v.description.trim(),
    podType: v.podType,
    orchestrationMode: v.orchestrationMode,
    communicationMode: v.communicationMode,
    visibility: v.visibility,
    maxMembers: max ? Number(max) : null,
    rules: v.rules.trim(),
    allowMemberInvites: membersMayInvite(v),
  };
}

// ---- a refusal from the server -------------------------------------------------------------------

export type PodField = 'name' | 'description' | 'maxMembers' | 'rules';

export interface PodProblemCopy {
  fallback: string;
  forbidden: string;
}

interface Refusal { response?: { status?: number; data?: { error?: { code?: unknown; details?: unknown } } } }

/** The words for a field the route's validation refused. Never zod's own text. */
const POD_FIELD_WORDS: Record<PodField, (said: string) => string> = {
  name: (said) => (/at most|too long/i.test(said) ? `Keep the name to ${POD_NAME_MAX} characters.` : POD_NAME_REQUIRED),
  description: () => 'Keep the description to 2,000 characters.',
  maxMembers: () => MAX_MEMBERS_PROBLEM,
  rules: () => 'Keep the rules to 5,000 characters.',
};

const isPodField = (key: string): key is PodField => Object.prototype.hasOwnProperty.call(POD_FIELD_WORDS, key);

/** Where a refused pod form says what went wrong: at each field it names, else one sentence beside the button. */
export function podProblems(err: unknown, copy: PodProblemCopy): { fields: Partial<Record<PodField, string>>; form: string | null } {
  const response = (err as Refusal | null | undefined)?.response;
  if (!response) return { fields: {}, form: errorMessage(err, copy.fallback) };
  const error = response.data?.error;
  if (response.status === 400 && error?.code === 'VALIDATION_ERROR') {
    const details = error.details && typeof error.details === 'object' ? (error.details as Record<string, unknown>) : {};
    const fields: Partial<Record<PodField, string>> = {};
    let unplaced = false;
    for (const [key, messages] of Object.entries(details)) {
      const said = Array.isArray(messages) && typeof messages[0] === 'string' ? messages[0] : '';
      if (isPodField(key)) fields[key] ??= POD_FIELD_WORDS[key](said);
      else unplaced = true;
    }
    return { fields, form: unplaced || Object.keys(fields).length === 0 ? CHECK_POD : null };
  }
  if (response.status === 403) return { fields: {}, form: copy.forbidden };
  if (response.status === 404) return { fields: {}, form: 'This pod could not be found. It may have been archived.' };
  if (response.status === 429) return { fields: {}, form: errorMessage(err, copy.fallback) };
  return { fields: {}, form: copy.fallback };
}

const POD_FIELD_LABELS: Record<PodField, string> = { name: 'Pod name', description: 'Description', maxMembers: 'Max members', rules: 'Pod rules' };
const POD_FIELD_ORDER: PodField[] = ['name', 'description', 'maxMembers', 'rules'];

/** "Fix 1 thing: Pod name": the fields with a problem, in the order the form shows them. */
export function podProblemSummary(keys: string[]): { lead: string; items: { key: string; label: string }[] } | null {
  const sorted = POD_FIELD_ORDER.filter((key) => keys.includes(key));
  if (sorted.length === 0) return null;
  return {
    lead: sorted.length === 1 ? 'Fix 1 thing:' : `Fix ${sorted.length} things:`,
    items: sorted.map((key) => ({ key, label: POD_FIELD_LABELS[key] })),
  };
}
