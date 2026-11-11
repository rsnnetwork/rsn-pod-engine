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
// Presence and reports (11 Nov 2026). REPORT_SUBJECT_KINDS, REPORT_REASONS and REPORT_REPEAT_HOURS are VALUES, so
// they get their own named exports too (see OPENINGS below).
export * from './types/safety';
import { REPORT_SUBJECT_KINDS as _REPORT_SUBJECT_KINDS, REPORT_REASONS as _REPORT_REASONS, REPORT_REPEAT_HOURS as _REPORT_REPEAT_HOURS } from './types/safety';
export const REPORT_SUBJECT_KINDS = _REPORT_SUBJECT_KINDS;
export const REPORT_REASONS = _REPORT_REASONS;
export const REPORT_REPEAT_HOURS = _REPORT_REPEAT_HOURS;
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
  ENTITY_SERVICE_CATEGORIES as _ENTITY_SERVICE_CATEGORIES, ENTITY_SERVICE_LABELS as _ENTITY_SERVICE_LABELS,
} from './types/entity';
export const COMPANY_ROLES = _COMPANY_ROLES;
export const ENTITY_KINDS = _ENTITY_KINDS;
export const ENTITY_KIND_LABELS = _ENTITY_KIND_LABELS;
export const ENTITY_LIMITS = _ENTITY_LIMITS;
export const ENTITY_ROLES = _ENTITY_ROLES;
export const ENTITY_ROLE_LABELS = _ENTITY_ROLE_LABELS;
export const ENTITY_SERVICE_CATEGORIES = _ENTITY_SERVICE_CATEGORIES;
export const ENTITY_SERVICE_LABELS = _ENTITY_SERVICE_LABELS;
// An organiser's export of their circle or pod (Shirley pilot S7): VALUES the export sheet renders, named exports as above.
export * from './types/space-export';
import {
  SPACE_EXPORT_COPY as _SPACE_EXPORT_COPY, SPACE_EXPORT_SECTIONS as _SPACE_EXPORT_SECTIONS, SPACE_KINDS as _SPACE_KINDS,
} from './types/space-export';
export const SPACE_EXPORT_COPY = _SPACE_EXPORT_COPY;
export const SPACE_EXPORT_SECTIONS = _SPACE_EXPORT_SECTIONS;
export const SPACE_KINDS = _SPACE_KINDS;
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
// Part 2 Task 4 (10 Nov 2026): who gets a place on an event (sessions.admission_mode), a real VALUE the forms list.
import { ADMISSION_MODES as _ADMISSION_MODES } from './types/session';
export const ADMISSION_MODES = _ADMISSION_MODES;
// The RSN Call link (Part 2 foundation, Task 6): the one path constant, the call code's alphabet and its readers, and the
// name rule of the details step. Real VALUES the server's emails and the client's router read, so each has its own named
// export, same as OPENINGS above.
export * from './events/call-link';
export * from './types/call-link';
import {
  CALL_LINK_BASE_PATH as _CALL_LINK_BASE_PATH, CALL_CODE_ALPHABET as _CALL_CODE_ALPHABET,
  CALL_CODE_LENGTH as _CALL_CODE_LENGTH, CALL_DISPLAY_NAME_MAX as _CALL_DISPLAY_NAME_MAX,
  callLinkPath as _callLinkPath, normaliseCallCode as _normaliseCallCode, cleanCallDisplayName as _cleanCallDisplayName,
} from './events/call-link';
export const CALL_LINK_BASE_PATH = _CALL_LINK_BASE_PATH;
export const CALL_CODE_ALPHABET = _CALL_CODE_ALPHABET;
export const CALL_CODE_LENGTH = _CALL_CODE_LENGTH;
export const CALL_DISPLAY_NAME_MAX = _CALL_DISPLAY_NAME_MAX;
export const callLinkPath = _callLinkPath;
export const normaliseCallCode = _normaliseCallCode;
export const cleanCallDisplayName = _cleanCallDisplayName;
// The event link (Stefan, 11 Nov 2026): /events/<name>-<n>[-<tail>]. Real VALUES the server and the client's router and
// forms read, so each has its own named export.
export * from './events/event-link';
import {
  EVENT_LINK_BASE_PATH as _EVENT_LINK_BASE_PATH, EVENT_LINK_DEFAULT_NAME as _EVENT_LINK_DEFAULT_NAME,
  EVENT_LINK_NAME_MIN as _EVENT_LINK_NAME_MIN, EVENT_LINK_NAME_MAX as _EVENT_LINK_NAME_MAX,
  EVENT_LINK_TAIL_ALPHABET as _EVENT_LINK_TAIL_ALPHABET, EVENT_LINK_TAIL_FIRST as _EVENT_LINK_TAIL_FIRST,
  EVENT_LINK_TAIL_LENGTH as _EVENT_LINK_TAIL_LENGTH, EVENT_LINK_RESERVED_NAMES as _EVENT_LINK_RESERVED_NAMES,
  EVENT_LINK_NAME_RULE as _EVENT_LINK_NAME_RULE, EVENT_LINK_SLUG_MAX as _EVENT_LINK_SLUG_MAX,
  normaliseEventLinkName as _normaliseEventLinkName, eventLinkNameProblem as _eventLinkNameProblem,
  isEventLinkName as _isEventLinkName, eventLinkSlug as _eventLinkSlug,
  eventLinkPath as _eventLinkPath, isEventLinkTail as _isEventLinkTail, parseEventLinkSlug as _parseEventLinkSlug,
} from './events/event-link';
export const EVENT_LINK_BASE_PATH = _EVENT_LINK_BASE_PATH;
export const EVENT_LINK_DEFAULT_NAME = _EVENT_LINK_DEFAULT_NAME;
export const EVENT_LINK_NAME_MIN = _EVENT_LINK_NAME_MIN;
export const EVENT_LINK_NAME_MAX = _EVENT_LINK_NAME_MAX;
export const EVENT_LINK_TAIL_ALPHABET = _EVENT_LINK_TAIL_ALPHABET;
export const EVENT_LINK_TAIL_FIRST = _EVENT_LINK_TAIL_FIRST;
export const EVENT_LINK_TAIL_LENGTH = _EVENT_LINK_TAIL_LENGTH;
export const EVENT_LINK_RESERVED_NAMES = _EVENT_LINK_RESERVED_NAMES;
export const EVENT_LINK_NAME_RULE = _EVENT_LINK_NAME_RULE;
export const EVENT_LINK_SLUG_MAX = _EVENT_LINK_SLUG_MAX;
export const normaliseEventLinkName = _normaliseEventLinkName;
export const eventLinkNameProblem = _eventLinkNameProblem;
export const isEventLinkName = _isEventLinkName;
export const eventLinkSlug = _eventLinkSlug;
export const eventLinkPath = _eventLinkPath;
export const isEventLinkTail = _isEventLinkTail;
export const parseEventLinkSlug = _parseEventLinkSlug;
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
  allowedLifecycleActions as _allowedLifecycleActions, eventAllowedActions as _eventAllowedActions,
} from './events/lifecycle';
export const EVENT_PUBLICATIONS = _EVENT_PUBLICATIONS;
export const EVENT_LIVE_STATUSES = _EVENT_LIVE_STATUSES;
export const EVENT_CANCEL_REASON_MAX = _EVENT_CANCEL_REASON_MAX;
export const EVENT_LIFECYCLE_ACTIONS = _EVENT_LIFECYCLE_ACTIONS;
export const isEventPublication = _isEventPublication;
export const eventLifecycleOf = _eventLifecycleOf;
export const allowedLifecycleActions = _allowedLifecycleActions;
export const eventAllowedActions = _eventAllowedActions;
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
// Matching groups and round rules, the one room checker and the rounds' estimated starts (10 Nov 2026 spec, Part 2
// Task 5): VALUES the engine, the matching board and the organiser's screens call, so each has its own statically
// analysable named export, same as OPENINGS above.
export * from './events/group-rules';
export * from './events/room-check';
export * from './events/round-times';
import {
  GROUP_LIMITS as _GROUP_LIMITS, DEFAULT_GROUP_QUESTION as _DEFAULT_GROUP_QUESTION, GROUP_PRESETS as _GROUP_PRESETS,
  isGroupKey as _isGroupKey, groupPairKey as _groupPairKey, ruleForRound as _ruleForRound,
  groupsAllowed as _groupsAllowed, validateGroupRules as _validateGroupRules,
  explainRoundCapacity as _explainRoundCapacity, roundRuleSentence as _roundRuleSentence,
  GROUP_OVERRIDE_BY as _GROUP_OVERRIDE_BY,
} from './events/group-rules';
import { checkRoom as _checkRoom, checkRound as _checkRound } from './events/room-check';
import { estimatedRoundStarts as _estimatedRoundStarts } from './events/round-times';
export const GROUP_LIMITS = _GROUP_LIMITS;
export const DEFAULT_GROUP_QUESTION = _DEFAULT_GROUP_QUESTION;
export const GROUP_PRESETS = _GROUP_PRESETS;
export const GROUP_OVERRIDE_BY = _GROUP_OVERRIDE_BY;
export const isGroupKey = _isGroupKey;
export const groupPairKey = _groupPairKey;
export const ruleForRound = _ruleForRound;
export const groupsAllowed = _groupsAllowed;
export const validateGroupRules = _validateGroupRules;
export const explainRoundCapacity = _explainRoundCapacity;
export const roundRuleSentence = _roundRuleSentence;
export const checkRoom = _checkRoom;
export const checkRound = _checkRound;
export const estimatedRoundStarts = _estimatedRoundStarts;
// The matching board's draft (10 Nov 2026 spec, Part 2 Task 8): its types, and the one VALUE the board's screen
// reads (the alternative that leaves a person in the basket), exported by name as OPENINGS above.
export * from './types/schedule';
// The organisers' event report (10 Nov 2026 spec, Part 3 Task 4; K4): its types, and the one VALUE the server and
// the report screen share (the fewest ratings a rating figure may rest on), exported by name as OPENINGS above.
export * from './types/event-report';
import { RATING_FIGURE_MIN as _RATING_FIGURE_MIN } from './types/event-report';
export const RATING_FIGURE_MIN = _RATING_FIGURE_MIN;
import { BOARD_BASKET_ROOM as _BOARD_BASKET_ROOM } from './types/schedule';
export const BOARD_BASKET_ROOM = _BOARD_BASKET_ROOM;
// Confirm it's you again before a sensitive change (10 Nov 2026 spec, Part 3 Task 2): the kinds of change, the proof's
// life, the refusal's words and the admin-role test are VALUES the server and the client both use, so each has its own
// statically analysable named export, same as OPENINGS above.
export * from './identity/reauth';
import {
  REAUTH_SCOPES as _REAUTH_SCOPES, REAUTH_GRANT_MINUTES as _REAUTH_GRANT_MINUTES,
  REAUTH_REQUIRED_MESSAGE as _REAUTH_REQUIRED_MESSAGE, isReauthScope as _isReauthScope, isAdminRole as _isAdminRole,
  touchesAdminRole as _touchesAdminRole,
} from './identity/reauth';
export const REAUTH_SCOPES = _REAUTH_SCOPES;
export const REAUTH_GRANT_MINUTES = _REAUTH_GRANT_MINUTES;
export const REAUTH_REQUIRED_MESSAGE = _REAUTH_REQUIRED_MESSAGE;
export const isReauthScope = _isReauthScope;
export const isAdminRole = _isAdminRole;
export const touchesAdminRole = _touchesAdminRole;

// An event's time in the event's own zone (10 Nov 2026 spec, Part 3 Task 1; K1): VALUES the server writes every bell
// and email with and the client writes every event time with, so each has its own statically analysable named export,
// same as OPENINGS above.
export * from './events/event-time';
import {
  FALLBACK_TIME_ZONE as _FALLBACK_TIME_ZONE, canonicalTimeZone as _canonicalTimeZone, eventZone as _eventZone,
  formatEventTime as _formatEventTime, relativeEventTime as _relativeEventTime,
  zonedWallTimeToUtc as _zonedWallTimeToUtc, utcToZonedWallTime as _utcToZonedWallTime, timeZoneLabel as _timeZoneLabel,
} from './events/event-time';
export const FALLBACK_TIME_ZONE = _FALLBACK_TIME_ZONE;
export const canonicalTimeZone = _canonicalTimeZone;
export const eventZone = _eventZone;
export const formatEventTime = _formatEventTime;
export const relativeEventTime = _relativeEventTime;
export const zonedWallTimeToUtc = _zonedWallTimeToUtc;
export const utcToZonedWallTime = _utcToZonedWallTime;
export const timeZoneLabel = _timeZoneLabel;

// Extra matching questions for an event (10 Nov 2026 spec, Part 3 Task 5; K5): the limits, the weight, the ruling, the
// affinity the engine scores with and the checks the server and the forms run. VALUES, so each has its own statically
// analysable named export, same as OPENINGS above.
export * from './events/matching-questions';
import {
  MAX_EVENT_QUESTIONS as _MAX_EVENT_QUESTIONS, MIN_QUESTION_OPTIONS as _MIN_QUESTION_OPTIONS,
  MAX_QUESTION_OPTIONS as _MAX_QUESTION_OPTIONS, EVENT_QUESTION_WEIGHT as _EVENT_QUESTION_WEIGHT,
  QUESTION_LIMITS as _QUESTION_LIMITS, MATCHING_QUESTIONS_RULING as _MATCHING_QUESTIONS_RULING,
  MATCHING_QUESTIONS_CARD_LINE as _MATCHING_QUESTIONS_CARD_LINE, isQuestionKey as _isQuestionKey,
  questionAffinity as _questionAffinity, validateEventQuestions as _validateEventQuestions,
  cleanEventAnswers as _cleanEventAnswers, missingRequiredQuestions as _missingRequiredQuestions,
  unansweredQuestions as _unansweredQuestions, prepareAnswers as _prepareAnswers, preparedAffinity as _preparedAffinity,
} from './events/matching-questions';
export const MAX_EVENT_QUESTIONS = _MAX_EVENT_QUESTIONS;
export const MIN_QUESTION_OPTIONS = _MIN_QUESTION_OPTIONS;
export const MAX_QUESTION_OPTIONS = _MAX_QUESTION_OPTIONS;
export const EVENT_QUESTION_WEIGHT = _EVENT_QUESTION_WEIGHT;
export const QUESTION_LIMITS = _QUESTION_LIMITS;
export const MATCHING_QUESTIONS_RULING = _MATCHING_QUESTIONS_RULING;
export const MATCHING_QUESTIONS_CARD_LINE = _MATCHING_QUESTIONS_CARD_LINE;
export const isQuestionKey = _isQuestionKey;
export const questionAffinity = _questionAffinity;
export const validateEventQuestions = _validateEventQuestions;
export const cleanEventAnswers = _cleanEventAnswers;
export const missingRequiredQuestions = _missingRequiredQuestions;
export const unansweredQuestions = _unansweredQuestions;
export const prepareAnswers = _prepareAnswers;
export const preparedAffinity = _preparedAffinity;
// The call link's "does the event still need something" (Part 3 Task 5 adds the questions): a VALUE the client calls.
import { somethingMissing as _somethingMissing } from './types/call-link';
export const somethingMissing = _somethingMissing;
