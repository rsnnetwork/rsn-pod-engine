// ─── Rules over the event definition (26 Oct 2026) ───────────────────────────────────────────────
//
// Pure functions over definitions.ts, with no I/O, used by every pod and event form and by the server, so a
// pod type's orchestration, the formats it may hold, a format's fields, defaults and limits, an event's
// length and how an old row's format is read are each decided in one place.

import { PodType, OrchestrationMode, CommunicationMode } from '../types/pod';
import { DEFAULT_SESSION_CONFIG } from '../types/session';
import {
  EventFormat, LiveKind, EventFormatRule, EventFieldRule, PodTypeRule,
  EVENT_FORMATS, EVENT_FORMAT_KEYS, POD_TYPES, ORCHESTRATION_MODES,
} from './definitions';

/** One thing wrong with an event's settings, said at the field. */
export interface EventInputIssue {
  field: string;
  message: string;
}

/** The pod-type settings a type change decides. */
export interface PodTypeChoice {
  podType: PodType;
  orchestrationMode: OrchestrationMode;
  communicationMode: CommunicationMode;
}

type Settings = Record<string, unknown>;

export function isEventFormat(value: unknown): value is EventFormat {
  return typeof value === 'string' && (EVENT_FORMAT_KEYS as readonly string[]).includes(value);
}

/**
 * A format's row. A value that is not a format (data written before formats existed) reads as speed
 * networking, the only way the engine ran events before.
 */
export function formatRule(f: EventFormat): EventFormatRule {
  return isEventFormat(f) ? EVENT_FORMATS[f] : EVENT_FORMATS.speed_networking;
}

export function liveKindOf(f: EventFormat): LiveKind {
  return formatRule(f).live;
}

/** A pod type's row. A value that is not a pod type reads as a speed-networking pod. */
export function podTypeRule(t: PodType): PodTypeRule {
  return Object.prototype.hasOwnProperty.call(POD_TYPES, t) ? POD_TYPES[t] : POD_TYPES[PodType.SPEED_NETWORKING];
}

/**
 * How a pod's events run: its stored mode when its type allows it, else the type's default. An old pod saved
 * with a mode its type no longer allows (a Reason pod on timed rounds) reads correctly without a mass update.
 */
export function effectiveOrchestration(pod: { podType: PodType; orchestrationMode?: OrchestrationMode | null }): OrchestrationMode {
  const { orchestration } = podTypeRule(pod.podType);
  const stored = pod.orchestrationMode;
  return stored && orchestration.allowed.includes(stored) ? stored : orchestration.default;
}

/** The formats an organiser may choose for an event in a pod of this type: allowed and offered, default first. */
export function eventFormatsForPod(t: PodType): EventFormat[] {
  return podTypeRule(t).events.allowed.filter((f) => formatRule(f).available);
}

/** "Video meeting", "Video meeting or Speed networking", "A, B or C". */
function orList(labels: string[]): string {
  return labels.length <= 1 ? labels.join('') : `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
}

/**
 * Why an event in a pod of this type cannot be of this format, as a sentence, or null when it can:
 * "Webinar isn't offered yet." / "Speed networking isn't available in Chat pods. Choose Video meeting."
 */
export function formatRefusal(t: PodType, f: EventFormat): string | null {
  const offered = eventFormatsForPod(t);
  if (offered.includes(f)) return null;
  const label = formatRule(f).label;
  if (!formatRule(f).available) return `${label} isn't offered yet.`;
  const choose = offered.length > 0 ? ` Choose ${orList(offered.map((o) => formatRule(o).label))}.` : '';
  return `${label} isn't available in ${podTypeNoun(podTypeRule(t))}.${choose}`;
}

export function defaultEventFormat(t: PodType): EventFormat {
  const { events } = podTypeRule(t);
  if (formatRule(events.default).available) return events.default;
  return eventFormatsForPod(t)[0] ?? 'speed_networking';
}

export function fieldsFor(f: EventFormat): string[] {
  return Object.keys(formatRule(f).fields);
}

/** Each field's default; an admin-only pick without one is left out (leaving it empty is its default). */
export function defaultsFor(f: EventFormat): Settings {
  const out: Settings = {};
  for (const [key, field] of Object.entries(formatRule(f).fields)) {
    if (field.default !== undefined) out[key] = field.default;
  }
  return out;
}

/** The title a new event's form starts with: "Video meeting · Test". */
export function defaultTitle(f: EventFormat, podName: string): string {
  const label = formatRule(f).label;
  const pod = (podName ?? '').trim();
  return pod ? `${label} · ${pod}` : label;
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/** What is wrong with one field's value, as a sentence, or null when it is fine. */
function fieldIssue(field: EventFieldRule, value: unknown): string | null {
  if (field.options) {
    return field.options.includes(value as string) ? null : `Choose one of the ${field.label.toLowerCase()} options.`;
  }
  if (field.min === undefined || field.max === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${field.label} must be a number.`;
  if (value >= field.min && value <= field.max) return null;
  return `${field.label} must be between ${field.min} and ${field.max}${field.unit ? ` ${field.unit}` : ''}.`;
}

/**
 * The problems with an event's settings, as the forms hold them (round length in minutes), one per field.
 * An empty field is not a problem: it takes its default. Fields the format does not have are ignored.
 */
export function checkEventInput(f: EventFormat, input: object | null | undefined): EventInputIssue[] {
  const values = (input ?? {}) as Settings;
  const issues: EventInputIssue[] = [];
  for (const [key, field] of Object.entries(formatRule(f).fields)) {
    if (isBlank(values[key])) continue;
    const message = fieldIssue(field, values[key]);
    if (message) issues.push({ field: key, message });
  }
  return issues;
}

/** A field's value as it is stored: the form's value (scaled), else the stored one, else the default. */
function storedValue(field: EventFieldRule, key: string, source: Settings): unknown {
  const scale = field.stored?.scale ?? 1;
  const fromForm = source[key];
  if (!isBlank(fromForm)) {
    return field.stored && typeof fromForm === 'number' ? Math.round(fromForm * scale) : fromForm;
  }
  if (field.stored && !isBlank(source[field.stored.key])) return source[field.stored.key];
  if (field.default === undefined) return undefined;
  return field.stored && typeof field.default === 'number' ? Math.round(field.default * scale) : field.default;
}

/**
 * The config an event of this format is stored with, from everything known of its settings (stored keys,
 * or fields as the forms hold them, such as the round length in minutes). It always names its format
 * (`eventType`), so a copy made by production's old form keeps it.
 *
 * A rounds event keeps every engine setting it was given and takes DEFAULT_SESSION_CONFIG for the rest,
 * exactly what an event has always been stored with. Any other format keeps only its own fields: a video
 * meeting carries no round settings.
 */
export function normaliseConfig(f: EventFormat, config: object | null | undefined): Settings {
  const rule = formatRule(f);
  const source = (config ?? {}) as Settings;
  const out: Settings = rule.live === 'rounds' ? { ...DEFAULT_SESSION_CONFIG, ...source } : {};
  for (const [key, field] of Object.entries(rule.fields)) {
    const value = storedValue(field, key, source);
    if (field.stored) delete out[key];
    if (value !== undefined) out[field.stored?.key ?? key] = value;
  }
  out.eventType = f;
  return out;
}

/** What an edit form shows for an event of this format: each field from the stored config (the round length back in minutes), its default when unset. */
export function valuesFromConfig(f: EventFormat, config: object | null | undefined): Settings {
  const source = (config ?? {}) as Settings;
  const out: Settings = {};
  for (const [key, field] of Object.entries(formatRule(f).fields)) {
    const stored = source[field.stored?.key ?? key];
    let value: unknown;
    if (!isBlank(stored)) value = field.stored && typeof stored === 'number' ? stored / field.stored.scale : stored;
    else if (!isBlank(source[key])) value = source[key];
    else value = field.default;
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** A number setting with the old `value || fallback` reading: missing, zero or not a number takes the fallback. */
function setting(cfg: Settings, key: string, fallback: number): number {
  return Number(cfg[key]) || fallback;
}

/**
 * How long an event lasts, in whole minutes: the one formula behind the LiveKit token lifetime, the calendar
 * entry and every invite email. A rounds event is rounds × (round + rating) + (rounds − 1) transitions +
 * closing lobby, as the invite and registration emails have always computed it; a meeting is its length.
 */
export function eventDurationMinutes(f: EventFormat, config: object | null | undefined): number {
  const cfg = (config ?? {}) as Settings;
  if (liveKindOf(f) === 'rounds') {
    const rounds = setting(cfg, 'numberOfRounds', 5);
    const totalSeconds =
      rounds * setting(cfg, 'roundDurationSeconds', 480)
      + rounds * setting(cfg, 'ratingWindowSeconds', 30)
      + Math.max(0, rounds - 1) * setting(cfg, 'transitionDurationSeconds', 30)
      + setting(cfg, 'closingLobbyDurationSeconds', 120);
    return Math.ceil(totalSeconds / 60);
  }
  const length = cfg.durationMinutes;
  if (typeof length === 'number' && Number.isFinite(length) && length > 0) return Math.ceil(length);
  const fallback = formatRule(f).fields.durationMinutes?.default;
  return typeof fallback === 'number' ? fallback : 60;
}

/** "Reason pods", "Chat pods", "Speed Networking pods". */
function podTypeNoun(rule: PodTypeRule): string {
  return rule.label.endsWith(' Pod') ? `${rule.label.slice(0, -' Pod'.length)} pods` : `${rule.label} pods`;
}

/**
 * The pod form's values after its type changes. Untouched settings follow the new type's defaults; a setting
 * the member chose stays when the new type allows it, and is replaced, with a notice, when it does not.
 */
export function applyTypeChange<T extends object>(
  prev: T,
  nextType: PodType,
  touched: ReadonlySet<string>,
): { values: T & PodTypeChoice; notices: string[] } {
  const p = prev as Settings;
  const rule = podTypeRule(nextType);
  const notices: string[] = [];

  let orchestrationMode = rule.orchestration.default;
  const chosenMode = p.orchestrationMode as OrchestrationMode | undefined;
  if (touched.has('orchestrationMode') && chosenMode && ORCHESTRATION_MODES[chosenMode]) {
    if (rule.orchestration.allowed.includes(chosenMode)) {
      orchestrationMode = chosenMode;
    } else {
      notices.push(
        `Changed to ${ORCHESTRATION_MODES[orchestrationMode].label}: ${podTypeNoun(rule)} don't use ${ORCHESTRATION_MODES[chosenMode].phrase}.`,
      );
    }
  }

  const chosenCommunication = p.communicationMode as CommunicationMode | undefined;
  const communicationMode = touched.has('communicationMode') && chosenCommunication ? chosenCommunication : rule.communication;

  return { values: { ...prev, podType: nextType, orchestrationMode, communicationMode }, notices };
}

function replacedNotice(field: EventFieldRule, format: EventFormatRule): string {
  const value = `${String(field.default)}${field.unit ? ` ${field.unit}` : ''}`;
  const why = field.min !== undefined && field.max !== undefined
    ? `a ${format.label.toLowerCase()} allows ${field.min} to ${field.max}`
    : `that choice isn't available for a ${format.label.toLowerCase()}`;
  return `${field.label} changed to ${value}: ${why}.`;
}

function discardNotice(prevFormat: EventFormat, nextFormat: EventFormat, p: Settings): string {
  const next = formatRule(nextFormat).label;
  if (liveKindOf(prevFormat) === 'rounds') {
    const fields = formatRule(prevFormat).fields;
    const rounds = setting(p, 'numberOfRounds', Number(fields.numberOfRounds?.default) || 5);
    const minutes = setting(p, 'roundMinutes', Number(fields.roundMinutes?.default) || 8);
    return `Switching to ${next} removes the round settings (${rounds} ${rounds === 1 ? 'round' : 'rounds'} × ${minutes} min). Continue?`;
  }
  const length = p.durationMinutes;
  const detail = typeof length === 'number' ? ` (${length} min)` : '';
  return `Switching to ${next} removes the ${formatRule(prevFormat).label.toLowerCase()} settings${detail}. Continue?`;
}

/**
 * The event form's values after its format changes (`prev.format` is the format it had). Untouched settings
 * take the new format's defaults; a chosen setting the new format also has stays when it is within the new
 * limits and is replaced, with a notice, when it is not. Settings only the old format had stay in the values
 * (switching back restores them; only the new format's fields are sent), and when the organiser had set any
 * of them the switch must be confirmed first: `needsConfirm`, with the question as the last notice.
 */
export function applyFormatChange<T extends object>(
  prev: T,
  nextFormat: EventFormat,
  touched: ReadonlySet<string>,
): { values: T & Settings & { format: EventFormat }; notices: string[]; needsConfirm: boolean } {
  const p = prev as Settings;
  const prevFormat: EventFormat = isEventFormat(p.format) ? p.format : 'speed_networking';
  const next = formatRule(nextFormat);
  const values: Settings = { ...p, format: nextFormat };
  const notices: string[] = [];

  for (const [key, field] of Object.entries(next.fields)) {
    const chosen = touched.has(key) && !isBlank(p[key]);
    if (!chosen) {
      if (field.default !== undefined) values[key] = field.default;
      continue;
    }
    if (fieldIssue(field, p[key]) === null) continue;
    values[key] = field.default;
    notices.push(replacedNotice(field, next));
  }

  const discarded = Object.keys(formatRule(prevFormat).fields)
    .filter((key) => !(key in next.fields) && touched.has(key) && !isBlank(p[key]));
  const needsConfirm = prevFormat !== nextFormat && discarded.length > 0;
  if (needsConfirm) notices.push(discardNotice(prevFormat, nextFormat, p));

  return { values: values as T & Settings & { format: EventFormat }, notices, needsConfirm };
}

/**
 * The format an event runs as. The stored column when it names a format; else (a request or a row from before
 * the column) an offered format named by the legacy `config.eventType` that production's old form sends;
 * else speed networking. Anything unknown is speed networking.
 */
export function resolveEventFormat(
  s: { format?: unknown; config?: { eventType?: unknown } | null } | null | undefined,
): EventFormat {
  const column = s?.format;
  if (isEventFormat(column)) return column;
  const legacy = s?.config?.eventType;
  if (isEventFormat(legacy) && EVENT_FORMATS[legacy].available) return legacy;
  return 'speed_networking';
}
