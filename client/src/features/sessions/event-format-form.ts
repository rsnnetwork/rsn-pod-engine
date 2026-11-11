// client/src/features/sessions/event-format-form.ts
// The event forms' rules (26 Oct 2026): the event types a pod offers and the one a new event starts on, every
// field's starting value, what a switch of type does (and when it must ask first), what each field accepts, the
// request each form sends, how a refusal from the server lands at its field, and the facts the event page shows.
// The definition itself (types, fields, defaults, limits) is shared/src/events, which the server enforces.
// Pure on purpose (no React, axios, store or router), so a test can run it:
// server/src/__tests__/client/event-format-form.test.ts.
//
// 25 Oct walkthrough: a "Video meeting" in a Reason pod was created with five 8-minute rounds and ran as speed
// networking, and the title's "Required" sat three screens above the button on a phone.

import { z } from 'zod';
import {
  EVENT_FORMAT_KEYS, IN_PERSON_ENABLED_CLIENTS, MATCHING_PRESET_IDS, applyFormatChange, checkEventInput,
  defaultEventFormat, defaultTitle, defaultsFor, effectiveOrchestration, eventFormatsForPod, fieldsFor, formatOffered, formatRule,
  canonicalTimeZone, liveKindOf, missingRequired, resolveEventFormat, utcToZonedWallTime, valuesFromConfig,
  zonedWallTimeToUtc,
} from '@rsn/shared';
import type { EventFormat, OrchestrationMode, PodType } from '@rsn/shared';
import { errorMessage, memberSentence } from '../reason/errors';
import { defaultEventZone, formZone } from '../../lib/event-time';

/**
 * Everything an event form holds. The settings of every offered type are kept, so a switch back restores what the
 * organiser set; only the chosen type's settings are sent.
 */
export interface EventFormValues {
  podId: string;
  title: string;
  description: string;
  /** As a datetime-local field holds it, on the event's own clock (`timezone`): "2026-11-02T10:00". */
  scheduledAt: string;
  /**
   * The event's IANA zone (Part 3, K1): the clock `scheduledAt` is read on, and the one every time of the event is
   * shown in. Changing it keeps the wall clock: 14:00 stays 14:00, now on the new zone's clock.
   */
  timezone: string;
  format: EventFormat;
  numberOfRounds: number;
  roundMinutes: number;
  timerVisibility: string;
  matchingPolicy: string;
  /** The months of the cooldown rule (30 Oct 2026): sent only under that rule. */
  cooldownMonths: number;
  /** Who should meet whom: a preset's id (MATCHING_PRESET_IDS), an admin's template, or empty. */
  matchingTemplateId: string;
  maxParticipants: number;
  durationMinutes: number;
  /** Where an in-person event happens (30 Oct 2026). */
  location: string;
}

export type EventSettingKey =
  'numberOfRounds' | 'roundMinutes' | 'timerVisibility' | 'matchingPolicy' | 'cooldownMonths' | 'matchingTemplateId'
  | 'maxParticipants' | 'durationMinutes' | 'location';

/** Every setting an event form holds, of every type: a switch of type puts them all back, the schema checks them all. */
export const SETTING_KEYS: EventSettingKey[] = [
  'numberOfRounds', 'roundMinutes', 'timerVisibility', 'matchingPolicy', 'cooldownMonths', 'matchingTemplateId',
  'maxParticipants', 'durationMinutes', 'location',
];

/** A pod as the event forms need it. */
export interface EventPod {
  id: string;
  name: string;
  podType: PodType;
  orchestrationMode?: OrchestrationMode | null;
}

export const TITLE_REQUIRED = 'Give your event a title';
/** The server's limit on a title (routes/sessions.ts). */
export const TITLE_MAX = 300;
/** The server's limit on a description. */
export const DESCRIPTION_MAX = 2000;
export const CHECK_SETTINGS = "Check the event's settings and try again.";
export const DATE_REQUIRED = 'Choose a date and time.';
export const POD_REQUIRED = 'Choose a pod.';
/** The server's sentence for a zone it does not know (routes/sessions.ts, Part 3 Task 1). */
export const TIME_ZONE_REQUIRED = "Choose the event's time zone from the list.";

/**
 * Every type these forms may offer, in the table's order. They draw an in-person event's place, so they ask for In
 * person too (IN_PERSON_ENABLED_CLIENTS); production's form does not, and never offers it.
 */
const OFFER = IN_PERSON_ENABLED_CLIENTS;
const OFFERED: EventFormat[] = EVENT_FORMAT_KEYS.filter((f) => formatOffered(f, OFFER));

/**
 * The types an event in a pod of this type may be: the pod's, offered, its default first. With no pod chosen yet,
 * every offered type. An event keeps its own type on the list when its pod no longer offers it, because the server
 * lets an event keep its type after its pod's type changes.
 */
export function offeredFormats(podType?: PodType | null, keep?: EventFormat): EventFormat[] {
  const list = podType ? eventFormatsForPod(podType, OFFER) : [...OFFERED];
  return keep && !list.includes(keep) ? [...list, keep] : list;
}

/**
 * What each orchestration runs its events as. A pod on Freeform ("everyone together in one room") starts its events
 * as a video meeting; moderated events are video meetings until webinars are offered.
 */
const FORMAT_FOR_ORCHESTRATION: Record<string, EventFormat> = {
  timed_rounds: 'speed_networking',
  free_form: 'video_meeting',
  moderated: 'video_meeting',
};

/**
 * The type a new event starts on: the one the pod's orchestration runs, when the pod offers it, else the pod type's
 * default. An old pod saved on a mode its type does not allow reads through effectiveOrchestration (a Reason pod on
 * timed rounds is Freeform). With no pod chosen yet, the first offered type.
 */
export function startingFormat(pod?: Pick<EventPod, 'podType' | 'orchestrationMode'> | null): EventFormat {
  if (!pod) return OFFERED[0];
  // A Physical Event pod's events are in person: its type says so before its orchestration (Freeform) does.
  if ((pod.podType as string) === 'physical_event') return defaultEventFormat(pod.podType, OFFER);
  const offered = eventFormatsForPod(pod.podType, OFFER);
  const byMode = FORMAT_FOR_ORCHESTRATION[effectiveOrchestration(pod)];
  return byMode && offered.includes(byMode) ? byMode : defaultEventFormat(pod.podType, OFFER);
}

/**
 * Who a new event's speed networking pairs first (30 Oct 2026): General, except in a Two-Sided Networking pod, whose
 * events start on Founders and investors (its two groups are meant to meet each other).
 */
export function startingPreset(podType?: PodType | null): string {
  return (podType as string | null | undefined) === 'two_sided_networking' ? MATCHING_PRESET_IDS.foundersInvestors : MATCHING_PRESET_IDS.general;
}

/** Whether an id is one of REASON's presets, which any organiser may choose. */
export function isPresetId(id: unknown): boolean {
  return (Object.values(MATCHING_PRESET_IDS) as string[]).includes(id as string);
}

/**
 * Every setting's starting value: each offered type's defaults, the starting type's last, so a setting two types
 * share (capacity) starts at the starting type's. The admin-only template has no default and starts empty.
 */
function settingDefaults(format: EventFormat, podType?: PodType | null): Pick<EventFormValues, EventSettingKey> {
  const merged: Record<string, unknown> = { matchingTemplateId: startingPreset(podType), location: '' };
  for (const f of OFFERED) Object.assign(merged, defaultsFor(f));
  Object.assign(merged, defaultsFor(format));
  return merged as unknown as Pick<EventFormValues, EventSettingKey>;
}

/**
 * A new event's form: the pod's starting type with that type's defaults, and a title already filled in. Its zone is the
 * one given (the screen passes defaultEventZone: the organiser's own, else the browser's), else the browser's, else UTC.
 */
export function newEventValues(o: { pod?: EventPod | null; scheduledAt: string; timezone?: string | null }): EventFormValues {
  const format = startingFormat(o.pod);
  return {
    podId: o.pod?.id ?? '',
    title: defaultTitle(format, o.pod?.name ?? ''),
    description: '',
    scheduledAt: o.scheduledAt,
    timezone: o.timezone ? formZone(o.timezone) : defaultEventZone(null),
    format,
    ...settingDefaults(format, o.pod?.podType),
  };
}

/**
 * The time an edit form starts on: the event's instant on the event's own clock ("2026-12-01T14:00" for 13:00Z in
 * Copenhagen), whoever opens it and wherever they are; '' for an event with no date.
 */
export function eventWallTime(session: { scheduledAt?: string | null; timezone?: string | null }): string {
  return session.scheduledAt ? utcToZonedWallTime(session.scheduledAt, formZone(session.timezone)) : '';
}

/**
 * An event's edit form: its type (the stored column, else the old config.eventType, as the server reads it), its zone
 * and its saved settings (the round length back in minutes). On an edit every saved setting counts as chosen
 * (`touched`), so a switch that would drop one asks first. `scheduledAt` is eventWallTime's.
 */
export function editEventValues(
  session: {
    podId?: string | null; title?: string | null; description?: string | null; format?: unknown; config?: object | null;
    timezone?: string | null;
  },
  scheduledAt: string,
): { values: EventFormValues; touched: Set<string> } {
  const format = resolveEventFormat({ format: session.format, config: session.config as { eventType?: unknown } | null });
  return {
    values: {
      podId: session.podId ?? '',
      title: session.title ?? '',
      description: session.description ?? '',
      scheduledAt,
      timezone: formZone(session.timezone),
      format,
      ...settingDefaults(format),
      // An event saved with no template pairs on the engine's defaults, which General is: it shows as General.
      ...(valuesFromConfig(format, session.config) as Partial<EventFormValues>),
    },
    touched: new Set(fieldsFor(format)),
  };
}

/**
 * The form after its type changes. Untouched settings take the new type's defaults; a chosen setting the new type
 * also has stays when it fits the new limits and is replaced, with a notice, when it does not. When the switch
 * would drop settings the organiser chose, `confirm` is the question to ask before applying it.
 */
export function switchFormat(
  values: EventFormValues,
  next: EventFormat,
  touched: ReadonlySet<string>,
): { values: EventFormValues; notices: string[]; confirm: string | null } {
  const r = applyFormatChange(values, next, touched);
  if (!r.needsConfirm) return { values: r.values as EventFormValues, notices: r.notices, confirm: null };
  // The question names the round length as people read it ("1.7 min", not "1.6666666666666667 min"), from a copy of
  // the values: the form keeps the exact length, so the stored seconds do not change.
  const asked = applyFormatChange({ ...values, roundMinutes: readableMinutes(values.roundMinutes) }, next, touched).notices;
  return { values: r.values as EventFormValues, notices: r.notices.slice(0, -1), confirm: asked[asked.length - 1] };
}

/** Minutes to one decimal at most, for reading; a length that would read as 0 keeps its own value. */
function readableMinutes(m: number): number {
  const rounded = Math.round(Number(m) * 10) / 10;
  return rounded > 0 ? rounded : m;
}

/**
 * The type after the organiser picks a pod (a form opened without ?podId=). A type they have not chosen follows the
 * pod; a chosen type stays when the pod holds it, and is changed, with a notice, when it does not.
 */
export function podChangeFormat(current: EventFormat, pod: EventPod | null, chosen: boolean): { format: EventFormat; notice: string | null } {
  if (!pod) return { format: current, notice: null };
  if (chosen && eventFormatsForPod(pod.podType, OFFER).includes(current)) return { format: current, notice: null };
  const next = startingFormat(pod);
  if (!chosen || next === current) return { format: next, notice: null };
  return { format: next, notice: `Changed to ${formatRule(next).label}: ${formatRule(current).label} isn't available in this pod.` };
}

/** The title to show: the new filled-in title while the title is still the one filled in last, else the member's. */
export function autoTitle(current: string, lastAuto: string, next: string): string {
  return current === lastAuto ? next : current;
}

/** Counts the server keeps whole (zod int). A round may last a minute and a half: it is kept as 90 seconds. */
const WHOLE = new Set(['numberOfRounds', 'maxParticipants', 'durationMinutes', 'cooldownMonths']);

/** What is wrong with one setting of this type, in the definition's words, or null. Another type's field is not checked. */
export function settingProblem(format: EventFormat, key: string, value: unknown): string | null {
  const field = formatRule(format).fields[key];
  if (!field) return null;
  // A place the event cannot do without, said as the server says it.
  if (field.required) {
    const missing = missingRequired(format, { [key]: value }).find((m) => m.field === key);
    if (missing) return missing.message;
  }
  const issue = checkEventInput(format, { [key]: value })[0];
  if (issue) return issue.message;
  if (WHOLE.has(key) && typeof value === 'number' && !Number.isInteger(value)) return `${field.label} must be a whole number.`;
  return null;
}

export function titleProblem(title: string): string | null {
  const t = (title ?? '').trim();
  if (!t) return TITLE_REQUIRED;
  return t.length > TITLE_MAX ? `Keep the title to ${TITLE_MAX} characters.` : null;
}

// ---- the forms' Zod schemas ----------------------------------------------------------------------

/** Each problem of an event form's values, at its field, in the rules' words above (the same words as the server's). */
function eventIssues(values: EventFormValues, ctx: z.RefinementCtx, o: { pod: boolean }): void {
  const say = (field: string, message: string | null) => {
    if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
  };
  if (o.pod) say('podId', values.podId ? null : POD_REQUIRED);
  say('title', titleProblem(values.title));
  const realZone = !!canonicalTimeZone(values.timezone);
  // A time read on a zone that is not one is the zone's problem, said once, at the zone.
  say('scheduledAt', values.scheduledAt && (instantOf(values) || !realZone) ? null : DATE_REQUIRED);
  say('timezone', realZone ? null : TIME_ZONE_REQUIRED);
  // Only the chosen type's settings are checked: settingProblem says nothing about another type's field.
  for (const key of SETTING_KEYS) {
    // The months are checked only under the cooldown rule, the one that uses them.
    if (key === 'cooldownMonths' && values.matchingPolicy !== 'cooldown') continue;
    say(key, settingProblem(values.format, key, values[key]));
  }
}

/** The form's values as they are: the refinements check them and nothing is stripped or changed. */
const eventFormValues = z.custom<EventFormValues>((v) => typeof v === 'object' && v !== null);

/** Schedule an Event's schema, handed to react-hook-form through formResolver (lib/form-resolver.ts). */
export const newEventSchema = eventFormValues.superRefine((v, ctx) => eventIssues(v, ctx, { pod: true }));

/** Edit Event's schema. The date is required here too: an emptied date used to save "successfully" and keep the old one. */
export const eventChangesSchema = eventFormValues.superRefine((v, ctx) => eventIssues(v, ctx, { pod: false }));

/**
 * The fields an event form draws for a type, the pod picker aside: a problem with any other goes beside the button.
 * Who should meet whom is drawn for everyone (the presets); only its other templates are an admin's.
 */
export function shownEventKeys(format: EventFormat, _isAdmin: boolean): string[] {
  return ['format', 'title', 'description', 'scheduledAt', 'timezone', ...fieldsFor(format)];
}

export interface NewEventBody {
  podId: string;
  title: string;
  description?: string;
  scheduledAt: string | null;
  /** The event's zone: the server stores it and writes every time of the event on its clock. */
  timezone: string;
  format: EventFormat;
  config: Record<string, unknown>;
}

export interface EventChangesBody {
  title: string;
  description: string;
  scheduledAt?: string;
  timezone: string;
  format: EventFormat;
  config: Record<string, unknown>;
}

/**
 * The chosen type's settings, as the API takes them (the round length in minutes, a place trimmed). The template is
 * sent when it is a preset (anyone may choose one) or by an admin, and an empty one never: the engine stores it in a
 * uuid column, where an empty string fails. The months of the cooldown rule go only with that rule.
 */
function settingsFor(values: EventFormValues, isAdmin: boolean): Record<string, unknown> {
  const all = values as unknown as Record<string, unknown>;
  const config: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(formatRule(values.format).fields)) {
    if (field.adminOnly && !isAdmin && !(key === 'matchingTemplateId' && isPresetId(all[key]))) continue;
    // A setting that applies only under another one's value (the cooldown rule's months) is sent only then.
    if (field.when && all[field.when.key] !== field.when.equals) continue;
    const raw = all[key];
    const value = typeof raw === 'string' ? raw.trim() : raw;
    if (value === undefined || value === null || value === '') continue;
    config[key] = value;
  }
  return config;
}

/**
 * The instant the form's time names, read on the EVENT's clock, never the browser's: an organiser in Karachi who sets
 * 14:00 on a Copenhagen event sends 13:00Z. null with no time, or for a time or a zone that is not one (the schema
 * says so at the field first).
 */
function instantOf(values: Pick<EventFormValues, 'scheduledAt' | 'timezone'>): string | null {
  return values.scheduledAt ? zonedWallTimeToUtc(values.scheduledAt, values.timezone) : null;
}

/** POST /sessions: the type at the top level, so the server checks it against the pod and the type's limits. */
export function eventBody(values: EventFormValues, o: { isAdmin: boolean }): NewEventBody {
  const description = values.description.trim();
  return {
    podId: values.podId,
    title: values.title.trim(),
    ...(description ? { description } : {}),
    scheduledAt: instantOf(values),
    timezone: values.timezone,
    format: values.format,
    config: settingsFor(values, o.isAdmin),
  };
}

/**
 * PUT /sessions/:id. The type and the zone are sent every time; an event with no date keeps none rather than getting an
 * empty one. A new zone with the same wall clock is a new instant (14:00 Copenhagen is not 14:00 London), so the
 * server tells the event's people it has moved.
 */
export function eventChanges(values: EventFormValues, o: { isAdmin: boolean }): EventChangesBody {
  const scheduledAt = instantOf(values);
  return {
    title: values.title.trim(),
    description: values.description.trim(),
    ...(scheduledAt ? { scheduledAt } : {}),
    timezone: values.timezone,
    format: values.format,
    config: settingsFor(values, o.isAdmin),
  };
}

// ---- a refusal from the server -------------------------------------------------------------------

/** What a form says when the server refuses without naming a field, by the form it is. */
export interface EventProblemCopy {
  fallback: string;
  forbidden: string;
  notFound: string;
  /** An edit of an event that has started (400 SESSION_ALREADY_STARTED). */
  started?: string;
}

/** Each field's problem, at the field; and anything that belongs to no field, beside the button. */
export interface FormProblems {
  fields: Record<string, string>;
  form: string | null;
}

interface Refusal { response?: { status?: number; data?: { error?: { code?: unknown; message?: unknown; details?: unknown } } } }

const firstText = (messages: unknown): string => (Array.isArray(messages) && typeof messages[0] === 'string' ? messages[0] : '');

/** A sentence of the server's fit to show: short, no ids, and about events (the older routes say "session"). */
function shown(text: unknown): string | null {
  const sentence = memberSentence(text);
  return sentence && !/\bsessions?\b/i.test(sentence) ? sentence : null;
}

/** The words for a request field the route's validation refused. Never zod's own text. */
const REQUEST_FIELD_WORDS: Record<string, (said: string) => string> = {
  title: (said) => (/at most|too long/i.test(said) ? `Keep the title to ${TITLE_MAX} characters.` : TITLE_REQUIRED),
  description: () => 'Keep the description to 2,000 characters.',
  scheduledAt: () => DATE_REQUIRED,
  timezone: () => TIME_ZONE_REQUIRED,
  podId: () => POD_REQUIRED,
  format: () => 'Choose an event type.',
};

/** A stored key a refusal may name, as the field the form shows: the round length is set in minutes, kept in seconds. */
const FIELD_FOR_STORED: Record<string, string> = { roundDurationSeconds: 'roundMinutes' };

/** The definition's words for a setting the route's validation refused (zod says "Expected integer, received float"). */
function settingWords(format: EventFormat, key: string, said: string): string | null {
  const field = formatRule(format).fields[key];
  if (!field) return null;
  if (WHOLE.has(key) && /integer/i.test(said)) return `${field.label} must be a whole number.`;
  if (field.min !== undefined && field.max !== undefined) {
    return `${field.label} must be between ${field.min} and ${field.max}${field.unit ? ` ${field.unit}` : ''}.`;
  }
  if (field.options) return `Choose one of the ${field.label.toLowerCase()} options.`;
  return `Check the ${field.label.toLowerCase()}.`;
}

/**
 * A 400 VALIDATION_ERROR comes in two shapes. The route's own check (zod) names request paths ("title",
 * "config.numberOfRounds") in zod's words, so each gets this form's words. The service's check against the type's
 * limits names the form's fields ("roundMinutes") in the definition's words, which are shown as the server said them.
 */
function validationProblems(details: Record<string, unknown>, format: EventFormat): FormProblems {
  const fields: Record<string, string> = {};
  let unplaced = false;
  const place = (key: string, words: string | null) => {
    if (!words) unplaced = true;
    else if (!(key in fields)) fields[key] = words;
  };
  for (const [path, messages] of Object.entries(details)) {
    const said = firstText(messages);
    if (path in REQUEST_FIELD_WORDS) {
      place(path, REQUEST_FIELD_WORDS[path](said));
    } else if (path.startsWith('config.')) {
      const stored = path.slice('config.'.length);
      const key = FIELD_FOR_STORED[stored] ?? stored;
      place(key, settingWords(format, key, said));
    } else {
      const key = FIELD_FOR_STORED[path] ?? path;
      place(key, formatRule(format).fields[key] ? shown(said) ?? settingWords(format, key, said) : null);
    }
  }
  return { fields, form: unplaced || Object.keys(fields).length === 0 ? CHECK_SETTINGS : null };
}

/** Where a refused event form says what went wrong: at each field it names, else one sentence beside the button. */
export function eventProblems(err: unknown, format: EventFormat, copy: EventProblemCopy): FormProblems {
  const response = (err as Refusal | null | undefined)?.response;
  if (!response) return { fields: {}, form: errorMessage(err, copy.fallback) };
  const error = response.data?.error;
  const details = error?.details && typeof error.details === 'object' ? (error.details as Record<string, unknown>) : {};
  switch (response.status) {
    case 400:
      if (error?.code === 'EVENT_FORMAT_NOT_ALLOWED') {
        return { fields: { format: shown(firstText(details.format)) ?? shown(error.message) ?? 'Choose another event type for this pod.' }, form: null };
      }
      if (error?.code === 'VALIDATION_ERROR') return validationProblems(details, format);
      if (error?.code === 'SESSION_ALREADY_STARTED') return { fields: {}, form: copy.started ?? copy.fallback };
      return { fields: {}, form: shown(error?.message) ?? copy.fallback };
    case 403:
      return { fields: {}, form: copy.forbidden };
    case 404:
      return { fields: {}, form: copy.notFound };
    case 409:
      return { fields: {}, form: shown(error?.message) ?? copy.fallback };
    case 429:
      return { fields: {}, form: errorMessage(err, copy.fallback) };
    default:
      return { fields: {}, form: copy.fallback };
  }
}

// ---- the summary beside the button ---------------------------------------------------------------

const FORM_FIELD_LABELS: Record<string, string> = {
  podId: 'Pod', format: 'Event type', title: 'Title', description: 'Description', scheduledAt: 'Date and time',
  timezone: 'Time zone',
};
/** The fields above a type's own settings, in the order the forms draw them. */
const LEADING_FIELDS = ['podId', 'format', 'title', 'description', 'scheduledAt', 'timezone'];

export function fieldLabel(key: string, format: EventFormat): string {
  return FORM_FIELD_LABELS[key] ?? formatRule(format).fields[key]?.label ?? key;
}

export interface ProblemSummary {
  lead: string;
  items: { key: string; label: string }[];
}

/** "Fix 1 thing: Title": the fields with a problem, in the order the form shows them. */
export function problemSummary(keys: string[], format: EventFormat): ProblemSummary | null {
  if (keys.length === 0) return null;
  const order = [...LEADING_FIELDS, ...fieldsFor(format)];
  const rank = (key: string) => (order.includes(key) ? order.indexOf(key) : order.length);
  const sorted = [...new Set(keys)].sort((a, b) => rank(a) - rank(b));
  return {
    lead: sorted.length === 1 ? 'Fix 1 thing:' : `Fix ${sorted.length} things:`,
    items: sorted.map((key) => ({ key, label: fieldLabel(key, format) })),
  };
}

// ---- what the event page says about an event -----------------------------------------------------

const minutes = (n: unknown) => `${Number(n)} min`;

/**
 * A round length for reading, from minutes: to one decimal at most ("1.7" for 100 seconds), or in seconds under a
 * minute ("30"). Only what is shown is rounded; the stored seconds stay as they are.
 */
function roundLength(value: unknown, minuteUnit: string, secondUnit: string): string {
  const m = Number(value);
  if (m > 0 && m < 1) return `${Math.round(m * 60)}${secondUnit}`;
  return `${readableMinutes(m)}${minuteUnit}`;
}

export interface EventFact {
  key: string;
  value: string;
  caption: string;
}

/** The figures under an event's title, by its type: rounds and their length, or the meeting's length; and capacity. The place has its own line. */
export function eventFacts(format: EventFormat, config: object | null | undefined): EventFact[] {
  const v = valuesFromConfig(format, config);
  const facts: EventFact[] = [];
  if (liveKindOf(format) === 'rounds') {
    facts.push({ key: 'numberOfRounds', value: String(v.numberOfRounds), caption: 'rounds' });
    facts.push({ key: 'roundMinutes', value: roundLength(v.roundMinutes, 'm', 's'), caption: 'per round' });
  } else if (v.durationMinutes !== undefined) {
    facts.push({ key: 'durationMinutes', value: minutes(v.durationMinutes), caption: 'length' });
  }
  if (v.maxParticipants !== undefined) facts.push({ key: 'maxParticipants', value: String(v.maxParticipants), caption: 'max capacity' });
  return facts;
}

/**
 * "Video meeting · 60 min · up to 25", "Speed networking · Founders and investors · 5 rounds × 8 min · up to 500",
 * "In person · 60 min · up to 25 · The Ivy, London". `presetName` is the name of the event's preset, when it has one.
 */
export function eventFactsLine(format: EventFormat, config: object | null | undefined, presetName?: string | null): string {
  const v = valuesFromConfig(format, config);
  const parts = [formatRule(format).label];
  if (liveKindOf(format) === 'rounds' && presetName) parts.push(presetName);
  if (liveKindOf(format) === 'rounds') {
    const rounds = Number(v.numberOfRounds);
    parts.push(`${rounds} ${rounds === 1 ? 'round' : 'rounds'} × ${roundLength(v.roundMinutes, ' min', ' s')}`);
  } else if (v.durationMinutes !== undefined) {
    parts.push(minutes(v.durationMinutes));
  }
  if (v.maxParticipants !== undefined) parts.push(`up to ${v.maxParticipants}`);
  const place = eventPlace(format, config);
  if (place) parts.push(place);
  return parts.join(' · ');
}

/** Where an in-person event happens, as stored; null for any other event. */
export function eventPlace(format: EventFormat, config: object | null | undefined): string | null {
  if (liveKindOf(format) !== 'none') return null;
  const place = (config as { location?: unknown } | null | undefined)?.location;
  return typeof place === 'string' && place.trim() ? place.trim() : null;
}

/** A maps search for a place, for its "Open in maps" link. */
export function mapsUrl(place: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`;
}

/** The preset an event's config names, from the presets list, or null. */
export function presetNameOf(config: object | null | undefined, presets: { id: string; name: string }[] | undefined): string | null {
  const id = (config as { matchingTemplateId?: unknown } | null | undefined)?.matchingTemplateId;
  return presets?.find((p) => p.id === id)?.name ?? null;
}

/** The lengths a meeting may be set to: the presets inside the type's limits, and its own length if it is not one. */
const LENGTH_PRESETS = [15, 30, 45, 60, 90, 120, 180, 240, 300, 360, 480];

export function lengthOptions(format: EventFormat, current?: number): { value: number; label: string }[] {
  const field = formatRule(format).fields.durationMinutes;
  const min = field?.min ?? LENGTH_PRESETS[0];
  const max = field?.max ?? LENGTH_PRESETS[LENGTH_PRESETS.length - 1];
  const values = LENGTH_PRESETS.filter((n) => n >= min && n <= max);
  if (typeof current === 'number' && Number.isFinite(current) && !values.includes(current)) values.push(current);
  return values.sort((a, b) => a - b).map((value) => ({ value, label: minutes(value) }));
}
