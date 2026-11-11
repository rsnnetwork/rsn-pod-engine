// ─── Event formats and pod types: the one definition (26 Oct 2026) ───────────────────────────────
//
// What a pod type is, how its events run by default, which event formats it may hold, what an organiser
// sets for each format (with defaults and limits) and how the live engine runs it. Every create and edit
// screen reads these tables and the server enforces them, so a pod type, its orchestration and its events
// can no longer drift apart (25 Oct walkthrough: a Reason pod's "Video Meeting" ran as speed networking).
//
// Each row is one row of Shradha's definition sheet (workspace/audits/2026-10-26-feedback-25oct/
// 03-pods-events-config.md §8). Amending a row is the whole change; event-definitions.test.ts fails if an
// edit leaves the tables inconsistent (a default outside its allowed list, an unoffered format as a default,
// a field without a default or limits).
//
// A format marked `available: false` is defined but not offered: no form shows it and the server refuses
// it, until its live behaviour exists and its row is switched on. A format with `offeredTo` is offered only to
// a caller that asks for it (IN_PERSON_ENABLED_CLIENTS): production's form reads `available` alone, so it keeps
// offering what it can draw, while the forms that have the format's fields, and the server, offer it too.

import { PodType, OrchestrationMode, CommunicationMode } from '../types/pod';

export type EventFormat = 'speed_networking' | 'video_meeting' | 'voice_meeting' | 'webinar' | 'physical_event';

/** How the live engine runs an event: timed rounds, one room for everyone, or no video room at all. */
export type LiveKind = 'rounds' | 'meeting' | 'none';

/** Every format, in the order a picker lists them. */
export const EVENT_FORMAT_KEYS: readonly EventFormat[] = [
  'speed_networking', 'video_meeting', 'voice_meeting', 'webinar', 'physical_event',
];

/**
 * The formats a caller can draw beyond those every form offers. Production's event form passes nothing, so it
 * never offers In person (it has no place field and its Go Live opens a video room).
 */
export interface FormatOffer {
  inPerson?: boolean;
}

/** What the event forms that draw a place field ask for, and what the server accepts (30 Oct 2026). */
export const IN_PERSON_ENABLED_CLIENTS: FormatOffer = { inPerson: true };

/** One setting an organiser makes for an event of a format. */
export interface EventFieldRule {
  /** The field's name on a form, and the start of its error message ("Capacity must be…"). */
  label: string;
  /** A free-text field (a place); otherwise a choice (options) or a number (min and max). */
  kind?: 'text';
  /** The event cannot be stored without it; `missing` is the sentence when it is empty. */
  required?: boolean;
  missing?: string;
  /** A text field's longest value, after trimming. */
  maxLength?: number;
  /**
   * The setting applies only while another one has this value (the months of the `cooldown` rule): its default is
   * stored only then, so an event on another rule is stored exactly as before.
   */
  when?: { key: string; equals: string };
  default?: unknown;
  min?: number;
  max?: number;
  /** Ends a range message: "between 2 and 100 people". */
  unit?: string;
  /** The values a choice field may take. */
  options?: readonly string[];
  /** Shown to platform admins only; such a field may have no default (leaving it empty is the default). */
  adminOnly?: boolean;
  /**
   * Where the value is kept in the event's stored config when that differs from the field: the round length
   * is set in minutes and kept as whole seconds (`roundDurationSeconds`, which the round engine reads).
   */
  stored?: { key: string; scale: number };
}

export interface EventFormatRule {
  label: string;
  /** One line under the label on a format picker. */
  summary: string;
  live: LiveKind;
  /** Offered on every form (production's included) and accepted by the server. */
  available: boolean;
  /** Offered and accepted for a caller that asks for this (a FormatOffer key) while `available` stays false. */
  offeredTo?: keyof FormatOffer;
  /** What the recap shows: ratings and connections, or who attended. */
  recap: 'ratings' | 'attendance';
  /** Whether a host may open breakout rooms during the event. */
  breakouts: boolean;
  /** The matching engine the event uses, if it matches people at all. */
  matchingEngineId: string | null;
  fields: Record<string, EventFieldRule>;
}

export interface PodTypeRule {
  label: string;
  summary: string;
  /** How this pod's events run by default, and the modes an organiser may pick. */
  orchestration: { default: OrchestrationMode; allowed: OrchestrationMode[] };
  /** The event format its events default to, and every format it may hold (offered or not yet). */
  events: { default: EventFormat; allowed: EventFormat[] };
  /** Derived from the type; the forms no longer ask for it. */
  communication: CommunicationMode;
  /** A recommended size, shown as a hint and never enforced. */
  sizeHint: number | null;
}

const TIMER_OPTIONS = ['always_visible', 'hidden', 'last_10s', 'last_30s', 'last_60s', 'last_120s'] as const;
const MATCHING_POLICY_OPTIONS = ['platform_wide', 'within_event', 'none', 'cooldown'] as const;

export const EVENT_FORMATS: Record<EventFormat, EventFormatRule> = {
  // Timed one-to-one rounds. The engine's other settings (rating window, transitions, no-show timeout…)
  // keep the values in DEFAULT_SESSION_CONFIG; these are the ones an organiser sets.
  speed_networking: {
    label: 'Speed networking',
    summary: 'Timed one-to-one rounds with automatic matching',
    live: 'rounds',
    available: true,
    recap: 'ratings',
    breakouts: true,
    matchingEngineId: 'speed_networking_v1',
    fields: {
      numberOfRounds: { label: 'Number of rounds', default: 5, min: 1, max: 20 },
      roundMinutes: {
        label: 'Round length', default: 8, min: 1, max: 60, unit: 'minutes',
        stored: { key: 'roundDurationSeconds', scale: 60 },
      },
      timerVisibility: { label: 'Timer', default: 'last_10s', options: TIMER_OPTIONS },
      matchingPolicy: { label: 'Matching rule', default: 'within_event', options: MATCHING_POLICY_OPTIONS },
      cooldownMonths: {
        label: 'Months apart', default: 12, min: 1, max: 60, unit: 'months',
        when: { key: 'matchingPolicy', equals: 'cooldown' },
      },
      // Who should meet whom. Organisers choose one of REASON's presets (MATCHING_PRESET_IDS, 30 Oct 2026); any other
      // template stays a platform admin's pick (26 Oct 2026), so the field keeps its admin-only mark for that list.
      matchingTemplateId: { label: 'Matching template', adminOnly: true },
      maxParticipants: { label: 'Capacity', default: 500, min: 2, max: 10000, unit: 'people' },
    },
  },
  // Everyone in the main room until the director ends it: no plan, no rounds, no ratings, no breakouts.
  video_meeting: {
    label: 'Video meeting',
    summary: 'Everyone together in one video room until the host ends it',
    live: 'meeting',
    available: true,
    recap: 'attendance',
    breakouts: false,
    matchingEngineId: null,
    fields: {
      durationMinutes: { label: 'Length', default: 60, min: 15, max: 240, unit: 'minutes' },
      maxParticipants: { label: 'Capacity', default: 25, min: 2, max: 100, unit: 'people' },
    },
  },
  // Not offered yet: the same room with cameras off by default, once Shradha defines it.
  voice_meeting: {
    label: 'Voice meeting',
    summary: 'Audio-only call',
    live: 'meeting',
    available: false,
    recap: 'attendance',
    breakouts: false,
    matchingEngineId: null,
    fields: {
      durationMinutes: { label: 'Length', default: 60, min: 15, max: 240, unit: 'minutes' },
      maxParticipants: { label: 'Capacity', default: 25, min: 2, max: 100, unit: 'people' },
    },
  },
  // Not offered yet: the host presents, attendees join muted and ask in chat.
  webinar: {
    label: 'Webinar',
    summary: 'One host presents; attendees muted; questions in chat',
    live: 'meeting',
    available: false,
    recap: 'attendance',
    breakouts: false,
    matchingEngineId: null,
    fields: {
      durationMinutes: { label: 'Length', default: 60, min: 15, max: 240, unit: 'minutes' },
      maxParticipants: { label: 'Capacity', default: 500, min: 2, max: 10000, unit: 'people' },
    },
  },
  // A meetup at a place, with no video room (30 Oct 2026, L18). It ends itself at its start plus its length. Offered
  // only to the forms that draw its place (offeredTo), so production's form, which has no place field, never shows it.
  physical_event: {
    label: 'In person',
    summary: 'A meetup at a place; no video room',
    live: 'none',
    available: false,
    offeredTo: 'inPerson',
    recap: 'attendance',
    breakouts: false,
    matchingEngineId: null,
    fields: {
      location: {
        label: 'Where', kind: 'text', required: true, maxLength: 300,
        missing: 'Say where the event happens: an address or a venue.',
      },
      durationMinutes: { label: 'Length', default: 60, min: 15, max: 480, unit: 'minutes' },
      maxParticipants: { label: 'Capacity', default: 25, min: 2, max: 10000, unit: 'people' },
    },
  },
};

/** The orchestration modes as people read them. `phrase` completes "Reason pods don't use …". */
export const ORCHESTRATION_MODES: Record<OrchestrationMode, { label: string; summary: string; phrase: string }> = {
  [OrchestrationMode.TIMED_ROUNDS]: {
    label: 'Timed rounds', summary: 'Timed one-to-one rounds with automatic matching', phrase: 'timed rounds',
  },
  [OrchestrationMode.FREE_FORM]: {
    label: 'Freeform', summary: 'Everyone together in one room', phrase: 'freeform',
  },
  [OrchestrationMode.MODERATED]: {
    label: 'Moderated', summary: 'The host leads and gives people the floor', phrase: 'moderation',
  },
};

export const POD_TYPES: Record<PodType, PodTypeRule> = {
  [PodType.REASON]: {
    label: 'Reason Pod',
    summary: 'A small group (5 to 12) that meets for depth around a shared purpose',
    orchestration: { default: OrchestrationMode.FREE_FORM, allowed: [OrchestrationMode.FREE_FORM, OrchestrationMode.MODERATED] },
    events: { default: 'video_meeting', allowed: ['video_meeting', 'speed_networking', 'physical_event'] },
    communication: CommunicationMode.VIDEO,
    sizeHint: 12,
  },
  [PodType.SPEED_NETWORKING]: {
    label: 'Speed Networking',
    summary: 'Timed one-to-one rounds',
    orchestration: { default: OrchestrationMode.TIMED_ROUNDS, allowed: [OrchestrationMode.TIMED_ROUNDS] },
    events: { default: 'speed_networking', allowed: ['speed_networking', 'video_meeting', 'physical_event'] },
    communication: CommunicationMode.VIDEO,
    sizeHint: null,
  },
  [PodType.CONVERSATIONAL]: {
    label: 'Conversational',
    summary: 'Small group open conversations',
    orchestration: { default: OrchestrationMode.FREE_FORM, allowed: [OrchestrationMode.FREE_FORM, OrchestrationMode.MODERATED] },
    events: { default: 'video_meeting', allowed: ['video_meeting', 'speed_networking', 'physical_event'] },
    communication: CommunicationMode.VIDEO,
    sizeHint: null,
  },
  // Webinars come first here once they are offered; until then its events are video meetings.
  [PodType.WEBINAR]: {
    label: 'Webinar',
    summary: 'One host presenting to many',
    orchestration: { default: OrchestrationMode.MODERATED, allowed: [OrchestrationMode.MODERATED] },
    events: { default: 'video_meeting', allowed: ['video_meeting', 'webinar'] },
    communication: CommunicationMode.VIDEO,
    sizeHint: null,
  },
  // In-person events come first here. A form that does not offer them (production's) starts on a video meeting.
  [PodType.PHYSICAL_EVENT]: {
    label: 'Physical Event',
    summary: 'In person, supported digitally',
    orchestration: { default: OrchestrationMode.FREE_FORM, allowed: [OrchestrationMode.FREE_FORM] },
    events: { default: 'physical_event', allowed: ['physical_event', 'video_meeting'] },
    communication: CommunicationMode.HYBRID,
    sizeHint: null,
  },
  [PodType.CHAT]: {
    label: 'Chat Pod',
    summary: 'Text-first community',
    orchestration: { default: OrchestrationMode.FREE_FORM, allowed: [OrchestrationMode.FREE_FORM] },
    events: { default: 'video_meeting', allowed: ['video_meeting'] },
    communication: CommunicationMode.TEXT,
    sizeHint: null,
  },
  [PodType.TWO_SIDED_NETWORKING]: {
    label: 'Two-Sided Networking',
    summary: 'Two groups meeting each other',
    orchestration: { default: OrchestrationMode.TIMED_ROUNDS, allowed: [OrchestrationMode.TIMED_ROUNDS, OrchestrationMode.FREE_FORM] },
    events: { default: 'speed_networking', allowed: ['speed_networking', 'video_meeting', 'physical_event'] },
    communication: CommunicationMode.VIDEO,
    sizeHint: null,
  },
  [PodType.ONE_SIDED_NETWORKING]: {
    label: 'One-Sided Networking',
    summary: 'One group meeting among themselves',
    orchestration: { default: OrchestrationMode.TIMED_ROUNDS, allowed: [OrchestrationMode.TIMED_ROUNDS, OrchestrationMode.FREE_FORM] },
    events: { default: 'speed_networking', allowed: ['speed_networking', 'video_meeting', 'physical_event'] },
    communication: CommunicationMode.VIDEO,
    sizeHint: null,
  },
};

// ─── Who can join an event (T11, 1 Nov 2026; L17) ────────────────────────────────────────────────
//
// An event's own access, stored in sessions.visibility. NULL (every event made before, and every event
// production's form makes) follows its pod exactly as before. The server decides seeing, registering and the
// request flow from this value (server/src/services/session/event-access.ts); the forms and the event page
// read these words.

export type EventVisibility = 'public' | 'public_with_approval' | 'private';

/** The three in the order the event form offers them (Stefan's order: Public with approval, Public, Private). */
export const EVENT_VISIBILITY_KEYS: readonly EventVisibility[] = ['public_with_approval', 'public', 'private'] as const;

/** What a person can do on an event page: register, ask the host for a place, or nothing (a private event). */
export type EventAccessMode = 'register' | 'request' | 'private';

/** Where a person's request to join an event stands. */
export type EventJoinRequestStatus = 'pending' | 'approved' | 'declined' | 'withdrawn';

export interface EventAccessRule {
  /** The option's name on the form. */
  label: string;
  /** The line under it. */
  summary: string;
  /** The small chip on an Events list row. */
  chip: string;
}

export const EVENT_ACCESS: Record<EventVisibility, EventAccessRule> = {
  public_with_approval: {
    label: 'Public with approval',
    summary: 'Anyone on REASON can see it and request to join; you approve each person',
    chip: 'Request to join',
  },
  public: {
    label: 'Public',
    summary: 'Anyone on REASON can see it and join',
    chip: 'Open',
  },
  private: {
    label: 'Private',
    summary: "Only the pod's members and people you invite",
    chip: 'Private',
  },
};

/**
 * What a new event in a pod starts with: the pod's own audience. Only a Public open pod's events start public. Shirley
 * pilot S2 (11 Nov 2026): an event in a Public with approval pod starts Private (its members and the people invited),
 * because "with approval" is about joining the pod: its events were listed to the whole platform by default, which a
 * cohort pod never meant. The organiser may still choose otherwise on the form.
 */
export function defaultEventVisibility(podVisibility: string | null | undefined): EventVisibility {
  if (podVisibility === 'public') return 'public';
  return 'private';
}

export function isEventVisibility(v: unknown): v is EventVisibility {
  return typeof v === 'string' && (EVENT_VISIBILITY_KEYS as readonly string[]).includes(v);
}
