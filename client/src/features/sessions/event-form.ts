// ─── The Schedule Event form's rules (26 Oct 2026) ───────────────────────────────────────────────
//
// Stefan and Claus, on production, 25 Oct: scheduling a Video Meeting showed 5 rounds of 8 minutes and speed
// networking's description, and offered formats the pod could not hold. The shared event-format table
// (shared/src/events) says what each format is and which a pod's type holds; this file applies it to the form, as
// pure functions, so each rule is tested without a browser. useEventFormat.ts keeps the form's state; the page draws.

import {
  EVENT_FORMATS, EVENT_FORMAT_KEYS, checkEventInput, defaultEventFormat, eventFormatsForPod, liveKindOf,
} from '@rsn/shared';
import type { EventFormat, PodType } from '@rsn/shared';

export interface SessionForm {
  podId: string;
  title: string;
  description: string;
  scheduledAt: string;
  numberOfRounds: number;
  roundDurationSeconds: number;
  durationMinutes: number;
  maxParticipants: number;
  timerVisibility: string;
  matchingTemplateId: string;
  // Phase 4 (29 April 2026 spec) — three matching policies, default
  // 'within_event'. See shared/src/types/session.ts MatchingPolicy.
  matchingPolicy: 'platform_wide' | 'within_event' | 'none';
}

/** One pod as the form's list has it. */
export interface PodRow {
  id: string;
  name: string;
  podType: PodType;
  memberRole?: string | null;
}

/** What the picker offers before a pod is chosen: every format that is on offer, never one that is only defined. */
export const OFFERED_NOW: EventFormat[] = EVENT_FORMAT_KEYS.filter((f) => EVENT_FORMATS[f].available);

/** The lengths a meeting's picker lists, within the format's own limits. */
const MEETING_LENGTHS = [15, 30, 45, 60, 90, 120, 180, 240];

/** The formats an organiser may pick: the pod's type's, or the ones on offer while no pod is chosen. */
export function offeredFor(podType: PodType | undefined): EventFormat[] {
  return podType ? eventFormatsForPod(podType) : OFFERED_NOW;
}

/** The format the form is on: the one the organiser picked while the pod's type holds it, else the type's own default. */
export function formatFor(picked: EventFormat | null, podType: PodType | undefined): EventFormat {
  if (!podType) return picked ?? 'speed_networking';
  return picked && eventFormatsForPod(podType).includes(picked) ? picked : defaultEventFormat(podType);
}

/**
 * What an organiser is told when the format they picked is not one the pod they then chose holds, so the form moved
 * to the pod's own: "Changed to Video meeting: Speed networking isn't available in this pod." Null when nothing moved.
 */
export function switchNotice(picked: EventFormat | null, podType: PodType | undefined, format: EventFormat): string | null {
  if (!picked || !podType || eventFormatsForPod(podType).includes(picked)) return null;
  return `Changed to ${EVENT_FORMATS[format].label}: ${EVENT_FORMATS[picked].label} isn't available in this pod.`;
}

/** A setting's limits as a hint under it: "2 – 100 participants". */
export function rangeHint(format: EventFormat, key: string, noun: string): string {
  const { min = 0, max = 0 } = EVENT_FORMATS[format].fields[key];
  return `${min.toLocaleString('en-US')} – ${max.toLocaleString('en-US')} ${noun}`;
}

/** The round length's limits in seconds, which is how this form takes it (the definition holds minutes). */
export function roundSeconds(format: EventFormat): { min: number; max: number; defaultMinutes: number } {
  const { min = 1, max = 60, default: fallback = 8 } = EVENT_FORMATS[format].fields.roundMinutes ?? {};
  return { min: min * 60, max: max * 60, defaultMinutes: Number(fallback) };
}

/** The definition's own sentence for a setting out of range ("Number of rounds must be between 1 and 20."), else true. */
export function fieldMessage(format: EventFormat, key: string, value: unknown): string | true {
  return checkEventInput(format, { [key]: value })[0]?.message ?? true;
}

/** The lengths a meeting's picker lists: those inside the format's own limits. */
export function meetingLengthsFor(format: EventFormat): number[] {
  const { min = 0, max = Infinity } = EVENT_FORMATS[format].fields.durationMinutes ?? {};
  return MEETING_LENGTHS.filter((n) => n >= min && n <= max);
}

/**
 * What is posted to create the event: the format at the top level, and the settings of that format only. A meeting
 * carries its length and capacity and no round settings; speed networking carries exactly what it always has.
 * `eventType` stays in the config for a server that reads only that.
 */
export function sessionBody(data: SessionForm & { format: EventFormat }) {
  return {
    podId: data.podId,
    title: data.title,
    description: data.description || undefined,
    scheduledAt: new Date(data.scheduledAt).toISOString(),
    format: data.format,
    config: liveKindOf(data.format) === 'rounds'
      ? {
        eventType: data.format,
        numberOfRounds: data.numberOfRounds,
        roundDurationSeconds: data.roundDurationSeconds,
        maxParticipants: data.maxParticipants,
        timerVisibility: data.timerVisibility,
        matchingPolicy: data.matchingPolicy,
        ...(data.matchingTemplateId && { matchingTemplateId: data.matchingTemplateId }),
      }
      : {
        eventType: data.format,
        durationMinutes: data.durationMinutes,
        maxParticipants: data.maxParticipants,
      },
  };
}

/** The fields of the form a refusal can be said at. */
const FORM_FIELDS = [
  'podId', 'title', 'scheduledAt', 'numberOfRounds', 'roundDurationSeconds', 'durationMinutes',
  'maxParticipants', 'timerVisibility', 'matchingPolicy',
] as const;
export type FormField = typeof FORM_FIELDS[number];

/** What the server calls a setting, where the form calls it something else (the round length: minutes there, seconds here). */
const SERVER_NAMES: Record<string, FormField> = { roundMinutes: 'roundDurationSeconds' };

/**
 * A refusal from the server, split into what belongs at a field, what belongs at the format picker, and what is left
 * for a toast. The server says `details: { field: [sentence] }` (and `config.field` for an old-style schema check):
 * each sentence is said at its own field, in the server's words, and only what could not be placed becomes a toast.
 */
export function serverFieldErrors(error: unknown): { fields: Array<{ name: FormField; message: string }>; format: string | null; toast: string | null } {
  const body = (error as { response?: { data?: { error?: { message?: unknown; details?: unknown } } } } | null)?.response?.data?.error;
  const message = typeof body?.message === 'string' && body.message ? body.message : 'Failed to create event';
  const details = body?.details && typeof body.details === 'object' ? (body.details as Record<string, unknown>) : {};

  const fields: Array<{ name: FormField; message: string }> = [];
  let format: string | null = null;
  let unplaced = 0;
  for (const [rawKey, value] of Object.entries(details)) {
    const text = Array.isArray(value) ? value.find((v): v is string => typeof v === 'string') : typeof value === 'string' ? value : undefined;
    const key = rawKey.replace(/^config\./, '');
    if (text && key === 'format') {
      format = text;
      continue;
    }
    const name = (FORM_FIELDS as readonly string[]).includes(key) ? (key as FormField) : SERVER_NAMES[key];
    if (text && name) fields.push({ name, message: text });
    else unplaced += 1;
  }
  const placed = fields.length > 0 || format !== null;
  return { fields, format, toast: placed && unplaced === 0 ? null : message };
}
