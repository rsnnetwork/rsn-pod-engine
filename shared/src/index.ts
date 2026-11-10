// ─── RSN Shared Types & Contracts ────────────────────────────────────────────

export * from './types/user';
export * from './types/auth';
export * from './types/pod';
export * from './types/session';
export * from './types/match';
export * from './types/invite';
export * from './types/circle';
export * from './types/subscription';
export * from './types/video';
export * from './types/events';
export * from './types/api';
// Group chats (26 Oct 2026). The two sizes are real VALUES the client shows ("12 of 50"), so each has its
// own statically analysable named export for Rollup's CJS interop, as OPENINGS below explains.
export * from './types/group-chat';
export * from './types/message-reply';
import { GROUP_CHAT_MAX_MEMBERS as _GROUP_CHAT_MAX_MEMBERS, GROUP_CHAT_MIN_MEMBERS as _GROUP_CHAT_MIN_MEMBERS } from './types/group-chat';
export const GROUP_CHAT_MAX_MEMBERS = _GROUP_CHAT_MAX_MEMBERS;
export const GROUP_CHAT_MIN_MEMBERS = _GROUP_CHAT_MIN_MEMBERS;
export * from './types/onboarding';
// Explicit named re-export alongside the `export *` above: bundlers that do
// static CJS/ESM interop (Rollup/Vite) can't see through the `__exportStar`
// runtime loop `export *` compiles to, so a real value export (OPENINGS —
// everything else here is type-only and erased, so this was never an issue
// before) needs its own statically analyzable named export to be importable
// as a value from client code. See client's onboarding truthful-state work.
// (Import-then-export, not `export {X} from`, so tsc emits a plain
// `exports.OPENINGS = ...` assignment instead of a live-binding getter —
// the getter form isn't picked up by Rollup's static CJS export detection.)
import { OPENINGS as ONBOARDING_OPENINGS } from './types/onboarding';
export const OPENINGS = ONBOARDING_OPENINGS;
export * from './onboarding/options';
// Same reason as OPENINGS above: these are real VALUES the client renders the
// whole tick-box flow from, so each needs its own statically analysable named
// export to survive Rollup's CJS interop (21 Sep 2026).
import {
  ONBOARDING_INTENTS as _INTENTS, ONBOARDING_MEET as _MEET, ONBOARDING_OFFERS as _OFFERS,
  ONBOARDING_INDUSTRIES as _INDUSTRIES, ONBOARDING_SELF_KINDS as _SELF, ONBOARDING_LIMITS as _LIMITS,
  ONBOARDING_STEPS as _STEPS, labelFor as _labelFor, shortLabelFor as _shortLabelFor,
} from './onboarding/options';
export const ONBOARDING_INTENTS = _INTENTS;
export const ONBOARDING_MEET = _MEET;
export const ONBOARDING_OFFERS = _OFFERS;
export const ONBOARDING_INDUSTRIES = _INDUSTRIES;
export const ONBOARDING_SELF_KINDS = _SELF;
export const ONBOARDING_LIMITS = _LIMITS;
export const ONBOARDING_STEPS = _STEPS;
export const labelFor = _labelFor;
export const shortLabelFor = _shortLabelFor;
// Onboarding v2 (Shradha's brief, 19 Oct 2026), beside version 1, which is
// untouched. Values get their own named exports for the same Rollup reason.
export * from './onboarding/options-v2';
import {
  ONBOARDING_V2_MEET as _V2_MEET, ONBOARDING_V2_FIND as _V2_FIND, ONBOARDING_V2_OFFER as _V2_OFFER,
  ONBOARDING_V2_SELF as _V2_SELF, ONBOARDING_V2_COPY as _V2_COPY, ONBOARDING_V2_OTHER_KEYS as _V2_OTHER_KEYS,
  ONBOARDING_V2_LIMITS as _V2_LIMITS, ONBOARDING_V2_STEPS as _V2_STEPS, onboardingDone as _onboardingDone,
} from './onboarding/options-v2';
export const ONBOARDING_V2_MEET = _V2_MEET;
export const ONBOARDING_V2_FIND = _V2_FIND;
export const ONBOARDING_V2_OFFER = _V2_OFFER;
export const ONBOARDING_V2_SELF = _V2_SELF;
export const ONBOARDING_V2_COPY = _V2_COPY;
export const ONBOARDING_V2_OTHER_KEYS = _V2_OTHER_KEYS;
export const ONBOARDING_V2_LIMITS = _V2_LIMITS;
export const ONBOARDING_V2_STEPS = _V2_STEPS;
export const onboardingDone = _onboardingDone;
// The made-up people the tour's pictures show (25 Oct 2026): a real VALUE both tours render, so it has its
// own named export for the same Rollup reason as OPENINGS above.
export * from './onboarding/example-people';
import { EXAMPLE_PEOPLE as _EXAMPLE_PEOPLE } from './onboarding/example-people';
export const EXAMPLE_PEOPLE = _EXAMPLE_PEOPLE;
export * from './types/post-event-message';
// A real VALUE the "message everyone" screen counts with, so it needs its own statically analysable
// named export for Rollup's CJS interop, same as OPENINGS above (26 Oct 2026).
import { POST_EVENT_MESSAGE_LIMITS as _POST_EVENT_MESSAGE_LIMITS } from './types/post-event-message';
export const POST_EVENT_MESSAGE_LIMITS = _POST_EVENT_MESSAGE_LIMITS;
export * from './types/wall';
export * from './types/event-chat';
export * from './identity/displayName';
// A member's own words, as a page shows them (21 Oct 2026): one rule for the brief another member reads and for your
// own profile. Real VALUES (functions) the client calls, so each has its own named export, same as OPENINGS above.
import { canBring as _canBring, clip as _clip, usableAnswer as _usableAnswer } from './people/text';
export const clip = _clip;
export const usableAnswer = _usableAnswer;
export const canBring = _canBring;
export * from './types/reason';
// Real VALUES the client renders (For You, the Human Profile), so each needs
// its own statically analysable named export, same as OPENINGS above.
import {
  MEET_NOTE_MAX as _MEET_NOTE_MAX, MEETING_FORMATS as _MEETING_FORMATS, OUTCOME_KEYS as _OUTCOME_KEYS,
  OUTCOME_LABELS as _OUTCOME_LABELS, PERSON_RESPONSES as _PERSON_RESPONSES,
  WORTH_CONTINUING as _WORTH_CONTINUING, primaryActionFor as _primaryActionFor,
} from './types/reason';
export const MEET_NOTE_MAX = _MEET_NOTE_MAX;
export const MEETING_FORMATS = _MEETING_FORMATS;
export const OUTCOME_KEYS = _OUTCOME_KEYS;
export const OUTCOME_LABELS = _OUTCOME_LABELS;
export const PERSON_RESPONSES = _PERSON_RESPONSES;
export const WORTH_CONTINUING = _WORTH_CONTINUING;
export const primaryActionFor = _primaryActionFor;
// A LinkedIn profile address in the one form REASON stores (21 Oct 2026): the request to join and onboarding
// v2 both read an address with it. Real VALUES, so each has its own named export, same as OPENINGS above.
import { LINKEDIN_PROFILE_HELP as _LINKEDIN_PROFILE_HELP, linkedinProfileUrl as _linkedinProfileUrl } from './linkedin/profile-url';
export const LINKEDIN_PROFILE_HELP = _LINKEDIN_PROFILE_HELP;
export const linkedinProfileUrl = _linkedinProfileUrl;
// The profile links beside LinkedIn (10 Nov 2026): VALUES the form and the server both run, so each has its own named export.
import {
  PROFILE_LINK_HELP as _PROFILE_LINK_HELP, PROFILE_LINK_MAX as _PROFILE_LINK_MAX,
  normaliseProfileUrl as _normaliseProfileUrl, parseProfileUrl as _parseProfileUrl,
} from './profile/links';
export type { ProfileLinkKind, ProfileLinkResult } from './profile/links';
export const PROFILE_LINK_HELP = _PROFILE_LINK_HELP;
export const PROFILE_LINK_MAX = _PROFILE_LINK_MAX;
export const normaliseProfileUrl = _normaliseProfileUrl;
export const parseProfileUrl = _parseProfileUrl;
export * from './types/entity';
// Real VALUES the client renders (the Entities pages), so each needs its own statically analysable
// named export, same as OPENINGS above.
import {
  COMPANY_ROLES as _COMPANY_ROLES, ENTITY_KINDS as _ENTITY_KINDS, ENTITY_KIND_LABELS as _ENTITY_KIND_LABELS,
  ENTITY_LIMITS as _ENTITY_LIMITS, ENTITY_ROLES as _ENTITY_ROLES, ENTITY_ROLE_LABELS as _ENTITY_ROLE_LABELS,
} from './types/entity';
export const COMPANY_ROLES = _COMPANY_ROLES;
export const ENTITY_KINDS = _ENTITY_KINDS;
export const ENTITY_KIND_LABELS = _ENTITY_KIND_LABELS;
export const ENTITY_LIMITS = _ENTITY_LIMITS;
export const ENTITY_ROLES = _ENTITY_ROLES;
export const ENTITY_ROLE_LABELS = _ENTITY_ROLE_LABELS;
// Event formats and pod types (26 Oct 2026): the one definition every pod and event form reads and the server
// enforces, with its rules. Real VALUES the client renders and calls, so each has its own named export, same
// as OPENINGS above.
export * from './events/definitions';
export * from './events/rules';
export * from './events/presets';
import {
  EVENT_FORMATS as _EVENT_FORMATS, EVENT_FORMAT_KEYS as _EVENT_FORMAT_KEYS, POD_TYPES as _POD_TYPES,
  ORCHESTRATION_MODES as _ORCHESTRATION_MODES, IN_PERSON_ENABLED_CLIENTS as _IN_PERSON_ENABLED_CLIENTS,
  EVENT_ACCESS as _EVENT_ACCESS, EVENT_VISIBILITY_KEYS as _EVENT_VISIBILITY_KEYS,
  defaultEventVisibility as _defaultEventVisibility, isEventVisibility as _isEventVisibility,
} from './events/definitions';
import { MATCHING_PRESET_IDS as _MATCHING_PRESET_IDS } from './events/presets';
import {
  formatRule as _formatRule, podTypeRule as _podTypeRule, isEventFormat as _isEventFormat, liveKindOf as _liveKindOf,
  effectiveOrchestration as _effectiveOrchestration, eventFormatsForPod as _eventFormatsForPod,
  defaultEventFormat as _defaultEventFormat, fieldsFor as _fieldsFor, defaultsFor as _defaultsFor,
  defaultTitle as _defaultTitle, checkEventInput as _checkEventInput, normaliseConfig as _normaliseConfig,
  valuesFromConfig as _valuesFromConfig, eventDurationMinutes as _eventDurationMinutes,
  applyTypeChange as _applyTypeChange, applyFormatChange as _applyFormatChange,
  resolveEventFormat as _resolveEventFormat, formatRefusal as _formatRefusal,
  formatOffered as _formatOffered, missingRequired as _missingRequired,
} from './events/rules';
export const IN_PERSON_ENABLED_CLIENTS = _IN_PERSON_ENABLED_CLIENTS;
export const MATCHING_PRESET_IDS = _MATCHING_PRESET_IDS;
export const formatOffered = _formatOffered;
export const missingRequired = _missingRequired;
export const EVENT_FORMATS = _EVENT_FORMATS;
export const EVENT_FORMAT_KEYS = _EVENT_FORMAT_KEYS;
export const POD_TYPES = _POD_TYPES;
export const ORCHESTRATION_MODES = _ORCHESTRATION_MODES;
// T11 (1 Nov 2026): who can join an event.
export const EVENT_ACCESS = _EVENT_ACCESS;
export const EVENT_VISIBILITY_KEYS = _EVENT_VISIBILITY_KEYS;
export const defaultEventVisibility = _defaultEventVisibility;
export const isEventVisibility = _isEventVisibility;
export const formatRule = _formatRule;
export const podTypeRule = _podTypeRule;
export const isEventFormat = _isEventFormat;
export const liveKindOf = _liveKindOf;
export const effectiveOrchestration = _effectiveOrchestration;
export const eventFormatsForPod = _eventFormatsForPod;
export const defaultEventFormat = _defaultEventFormat;
export const fieldsFor = _fieldsFor;
export const defaultsFor = _defaultsFor;
export const defaultTitle = _defaultTitle;
export const checkEventInput = _checkEventInput;
export const normaliseConfig = _normaliseConfig;
export const valuesFromConfig = _valuesFromConfig;
export const eventDurationMinutes = _eventDurationMinutes;
export const applyTypeChange = _applyTypeChange;
export const applyFormatChange = _applyFormatChange;
export const resolveEventFormat = _resolveEventFormat;
export const formatRefusal = _formatRefusal;
// An event's lifecycle (Part 2 foundation, Task 2): draft, published, registration open, live, completed, archived,
// cancelled, worked out beside sessions.status (D1). Real VALUES the client renders and calls, so each has its own named
// export, same as OPENINGS above.
export * from './events/lifecycle';
import {
  EVENT_PUBLICATIONS as _EVENT_PUBLICATIONS, EVENT_LIVE_STATUSES as _EVENT_LIVE_STATUSES,
  EVENT_CANCEL_REASON_MAX as _EVENT_CANCEL_REASON_MAX, EVENT_LIFECYCLE_ACTIONS as _EVENT_LIFECYCLE_ACTIONS,
  isEventPublication as _isEventPublication, eventLifecycleOf as _eventLifecycleOf,
  allowedLifecycleActions as _allowedLifecycleActions,
} from './events/lifecycle';
export const EVENT_PUBLICATIONS = _EVENT_PUBLICATIONS;
export const EVENT_LIVE_STATUSES = _EVENT_LIVE_STATUSES;
export const EVENT_CANCEL_REASON_MAX = _EVENT_CANCEL_REASON_MAX;
export const EVENT_LIFECYCLE_ACTIONS = _EVENT_LIFECYCLE_ACTIONS;
export const isEventPublication = _isEventPublication;
export const eventLifecycleOf = _eventLifecycleOf;
export const allowedLifecycleActions = _allowedLifecycleActions;
export * from './types/meeting';
// Real VALUES the client uses (the Events meetings and the meeting page redraw their phase as the clock
// moves), so each needs its own statically analysable named export, same as OPENINGS above.
import {
  MEETING_JOIN_EARLY_MIN as _MEETING_JOIN_EARLY_MIN, MEETING_GRACE_MIN as _MEETING_GRACE_MIN,
  meetingPhase as _meetingPhase,
} from './types/meeting';
export const MEETING_JOIN_EARLY_MIN = _MEETING_JOIN_EARLY_MIN;
export const MEETING_GRACE_MIN = _MEETING_GRACE_MIN;
export const meetingPhase = _meetingPhase;
export * from './types/meeting-feedback';
// Real VALUES the client renders (the feedback sheet after a meeting, the admin feedback page), so each needs its own
// statically analysable named export, same as OPENINGS above.
import {
  MEETING_PROBLEMS as _MEETING_PROBLEMS, MEETING_PROBLEM_LABELS as _MEETING_PROBLEM_LABELS,
  MEETING_FEEDBACK_SOURCES as _MEETING_FEEDBACK_SOURCES, MEETING_PROBLEM_TEXT_MAX as _MEETING_PROBLEM_TEXT_MAX,
} from './types/meeting-feedback';
export const MEETING_PROBLEMS = _MEETING_PROBLEMS;
export const MEETING_PROBLEM_LABELS = _MEETING_PROBLEM_LABELS;
export const MEETING_FEEDBACK_SOURCES = _MEETING_FEEDBACK_SOURCES;
export const MEETING_PROBLEM_TEXT_MAX = _MEETING_PROBLEM_TEXT_MAX;
export * from './picture/crop';
// The profile picture's crop (30 Oct review, T3a): VALUES the server cuts a picture with and the editor shows it with,
// so each needs its own statically analysable named export, same as the meeting values above.
import {
  PICTURE_SHAPES as _PICTURE_SHAPES, PICTURE_MAX_ZOOM as _PICTURE_MAX_ZOOM, PICTURE_CENTRED as _PICTURE_CENTRED,
  clampPictureCrop as _clampPictureCrop, pictureCropRect as _pictureCropRect, pictureOutputSize as _pictureOutputSize,
} from './picture/crop';
export const PICTURE_SHAPES = _PICTURE_SHAPES;
export const PICTURE_MAX_ZOOM = _PICTURE_MAX_ZOOM;
export const PICTURE_CENTRED = _PICTURE_CENTRED;
export const clampPictureCrop = _clampPictureCrop;
export const pictureCropRect = _pictureCropRect;
export const pictureOutputSize = _pictureOutputSize;
export * from './location/countries';
// "Where are you based?" (30 Oct review, 1.2): VALUES the onboarding screens, the profile form and the server judge
// a location with, and the matcher reads places with, so each needs its own statically analysable named export, same
// as the meeting values above.
import {
  COUNTRY_ALIASES as _COUNTRY_ALIASES, COUNTRY_NAMES as _COUNTRY_NAMES, COUNTRIES_IN_NO_REGION as _COUNTRIES_IN_NO_REGION,
  ENDONYMS as _ENDONYMS, fold as _fold, isCountryOnly as _isCountryOnly, isLocationComplete as _isLocationComplete,
} from './location/countries';
export const COUNTRY_ALIASES = _COUNTRY_ALIASES;
export const COUNTRY_NAMES = _COUNTRY_NAMES;
export const COUNTRIES_IN_NO_REGION = _COUNTRIES_IN_NO_REGION;
export const ENDONYMS = _ENDONYMS;
export const fold = _fold;
export const isCountryOnly = _isCountryOnly;
export const isLocationComplete = _isLocationComplete;
