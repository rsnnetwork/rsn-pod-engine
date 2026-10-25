// ─── Onboarding version 2: the brief's screens as words and rules ───────────
//
// Shradha's onboarding brief, 19 Oct 2026, screens 1 to 7 (screen 8 is For
// You). Everything a screen decides lives here as plain functions: which step a
// URL may show, whether a question can be left, what confirm sends, which value
// a profile field shows. So the screens cannot drift apart, and a test can run
// the rules (server/src/__tests__/client/onboarding-v2-flow.test.ts).
//
// The option labels, question titles and helper lines come from the shared
// catalogue, the same one the server validates against. The brief's other
// words are below, verbatim.

import {
  ONBOARDING_V2_MEET, ONBOARDING_V2_FIND, ONBOARDING_V2_OFFER, ONBOARDING_V2_SELF,
  ONBOARDING_V2_COPY, ONBOARDING_V2_LIMITS, ONBOARDING_V2_OTHER_KEYS, ONBOARDING_V2_STEPS, shortLabelFor,
  type OnboardingOption, type OnboardingV2Answers, type OnboardingV2ConfirmRequest,
  type OnboardingV2LinkedinStatus, type OnboardingV2ProfileInput, type OnboardingV2State, type OnboardingV2Step,
} from '@rsn/shared';
import { CONNECTION_LOST } from '../reason/errors';

// ── The brief's words ────────────────────────────────────────────────────────

/** Screen 1. */
export const WELCOME = {
  title: "Welcome to REASON. We're glad you're here.",
  lead: 'Every good connection starts with a reason.',
  lines: [
    'On REASON, you connect with people you want to meet, who also want to meet you, for a specific reason.',
    'Answer quick questions and we will suggest the potential mutuals for you.',
  ],
  button: "Let's go",
} as const;

/** Screen 2. The member is already signed in, so these choose how the profile is filled in. */
export const SIGNUP = {
  title: "Let's get you started",
  linkedin: 'Continue with LinkedIn',
  linkedinLine: "We'll use your LinkedIn profile to fill in your details for you.",
  email: 'Continue with email',
} as const;

/** Screen 7. */
export const PROFILE = {
  title: "Here's how others will see you",
  subtitle: "Change anything that isn't right.",
  keepPhoto: 'Keep this photo',
  newPhoto: 'Upload a new one',
  answers: 'Your answers',
  edit: 'Edit',
  change: 'Change',
  onlyYou: 'Only you see this',
  addLinkedinLine: 'Add your LinkedIn profile so people can learn more about you. You can do this later.',
  addLinkedin: 'Add LinkedIn',
  later: 'Later',
  finish: 'Show me my matches',
} as const;

/** Screen 6, when LinkedIn's stated role points at some answers and they have not chosen yet. */
export const SELF_GUESS_LINE = "We picked these from your LinkedIn. Change them if they're wrong.";

/** The note on each tile LinkedIn picked. */
export const FROM_LINKEDIN = 'From LinkedIn';

// ── The four questions (screens 3 to 6) ──────────────────────────────────────

export type QuestionStepKey = 'q1' | 'q2' | 'q3' | 'q4';
type KeysField = 'lookingToMeet' | 'hopingToFind' | 'canOffer' | 'selfKinds';
type OwnWordsField = 'meetOther' | 'findOther' | 'offerOther' | 'selfOther';

export interface Question {
  step: QuestionStepKey;
  /** "1 of 4" */
  number: number;
  field: KeysField;
  ownWordsField: OwnWordsField;
  /** "Something else. I'd like to say it in my own words.": choosing it requires words. */
  ownWordsKey: string;
  title: string;
  hint: string;
  options: readonly OnboardingOption[];
  /** "Something else" ticked with no words: the server's own sentence for it. */
  ownWordsMissing: string;
  /** Only the member sees these answers (screen 7 marks them). */
  onlyYou: boolean;
}

const L = ONBOARDING_V2_LIMITS;
const C = ONBOARDING_V2_COPY;

export const QUESTIONS: readonly Question[] = [
  {
    step: 'q1', number: 1, field: 'lookingToMeet', ownWordsField: 'meetOther', ownWordsKey: ONBOARDING_V2_OTHER_KEYS.meet,
    title: C.meet.title, hint: C.meet.hint, options: ONBOARDING_V2_MEET,
    ownWordsMissing: 'Tell us who you would like to meet.', onlyYou: true,
  },
  {
    step: 'q2', number: 2, field: 'hopingToFind', ownWordsField: 'findOther', ownWordsKey: ONBOARDING_V2_OTHER_KEYS.find,
    title: C.find.title, hint: C.find.hint, options: ONBOARDING_V2_FIND,
    ownWordsMissing: 'Tell us what you are hoping to find.', onlyYou: true,
  },
  {
    step: 'q3', number: 3, field: 'canOffer', ownWordsField: 'offerOther', ownWordsKey: ONBOARDING_V2_OTHER_KEYS.offer,
    title: C.offer.title, hint: C.offer.hint, options: ONBOARDING_V2_OFFER,
    ownWordsMissing: 'Tell us what you can offer.', onlyYou: false,
  },
  {
    step: 'q4', number: 4, field: 'selfKinds', ownWordsField: 'selfOther', ownWordsKey: ONBOARDING_V2_OTHER_KEYS.self,
    title: C.self.title, hint: C.self.hint, options: ONBOARDING_V2_SELF,
    ownWordsMissing: 'Tell us how you would describe yourself.', onlyYou: false,
  },
];

/** The "Something else" box of every question. */
export const OWN_WORDS_MAX = L.otherMaxLen;

/** Screen 4's optional box, with the brief's example as its placeholder. */
export const SPECIFIC = {
  label: C.findSpecific.label,
  placeholder: C.findSpecific.example,
  max: L.findSpecificMaxLen,
} as const;

export function questionFor(step: string | null | undefined): Question | undefined {
  return QUESTIONS.find(x => x.step === step);
}

const tidy = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim();
  return t ? t : null;
};

const keysOf = (q: Question, a: OnboardingV2Answers): readonly string[] => a[q.field];

/** Why a question cannot be left yet, or null when it can. Every question takes all the answers that apply. */
export function questionProblem(q: Question, a: OnboardingV2Answers): 'empty' | 'own-words' | null {
  const keys = keysOf(q, a);
  if (!keys.length) return 'empty';
  if (keys.includes(q.ownWordsKey) && !tidy(a[q.ownWordsField])) return 'own-words';
  return null;
}

/** The server's sentence for a question left with nothing ticked. */
export const ANSWER_NEEDED = 'Select at least one answer.';

/** Why a question cannot be left, as the member is told it: the server's own sentences. */
export function problemMessage(q: Question, problem: 'empty' | 'own-words'): string {
  return problem === 'empty' ? ANSWER_NEEDED : q.ownWordsMissing;
}

/** The first question still open, in order, leaving out `skip`; null when every answer is there. */
export function firstIncomplete(a: OnboardingV2Answers, skip?: QuestionStepKey): QuestionStepKey | null {
  return QUESTIONS.find(x => x.step !== skip && questionProblem(x, a) !== null)?.step ?? null;
}

// ── Steps ────────────────────────────────────────────────────────────────────

const ORDER: readonly OnboardingV2Step[] = ONBOARDING_V2_STEPS;
const isStep = (s: unknown): s is OnboardingV2Step => typeof s === 'string' && (ORDER as readonly string[]).includes(s);

/**
 * The screen to show: the one asked for (or, with none, where the draft left
 * off). An address that arrives cold (typed, bookmarked, opened from an email)
 * never skips a question still unanswered: a deep link to the profile with an
 * empty Q2 lands on Q2. A step the flow's own buttons opened is shown as asked,
 * so Back from an [Edit] always returns to the profile; nothing is lost by it,
 * because the last button checks every answer before it sends anything.
 */
export function stepToShow(
  requested: string | null | undefined, saved: OnboardingV2Step, a: OnboardingV2Answers, openedByFlow = false,
): OnboardingV2Step {
  if (openedByFlow && isStep(requested)) return requested;
  const wanted = isStep(requested) ? requested : saved;
  const furthest = firstIncomplete(a) ?? 'profile';
  return ORDER.indexOf(wanted) > ORDER.indexOf(furthest) ? furthest : wanted;
}

export function stepAfter(step: OnboardingV2Step): OnboardingV2Step {
  return ORDER[Math.min(ORDER.indexOf(step) + 1, ORDER.length - 1)];
}

export function stepBefore(step: OnboardingV2Step): OnboardingV2Step {
  return ORDER[Math.max(ORDER.indexOf(step) - 1, 0)];
}

/** What `/onboarding?edit=` names: one question or the profile. */
export type EditTarget = QuestionStepKey | 'profile';

export function parseEdit(v: string | null | undefined): EditTarget | null {
  return v === 'q1' || v === 'q2' || v === 'q3' || v === 'q4' || v === 'profile' ? v : null;
}

/**
 * Edit mode, a question's main button: save when every other answer is there
 * (always, for someone who finished version 2), else go to the one still
 * missing (a member whose version 1 answers left a question empty).
 */
export function editAction(a: OnboardingV2Answers, current: QuestionStepKey): { kind: 'save' } | { kind: 'next'; step: QuestionStepKey } {
  const missing = firstIncomplete(a, current);
  return missing ? { kind: 'next', step: missing } : { kind: 'save' };
}

/**
 * After the first confirm: the page they were sent here from (the gate's ?redirect=, for a member who followed a
 * link before finishing), only when it is a page of this app. Anything else, onboarding itself included, is For You.
 */
export function safeRedirect(param: string | null | undefined): string {
  const path = param ?? '';
  // One leading slash, not two and not a backslash (both leave the site), and no spaces or control characters.
  if (!/^\/(?![/\\])/.test(path) || /[\\\s\u0000-\u001F\u007F]/.test(path)) return '/';
  // In any case: the router matches paths without regard to case, so /Onboarding opens onboarding too.
  return /^\/onboarding(?:[/?#]|$)/i.test(path) ? '/' : path;
}

/**
 * In the history entry of a page the flow opens itself (the page after the first confirm, or edit mode's fallback):
 * the tour, which opens over it, leaves the member there instead of taking them to For You. A refresh keeps it.
 */
export const LANDED = { landed: true } as const;

/** Whether a history entry's state is LANDED. */
export function isLanded(state: unknown): boolean {
  return typeof state === 'object' && state !== null && (state as { landed?: unknown }).landed === true;
}

/**
 * Whether confirming opens the tour: confirm makes it due whenever the member has never seen it (an existing member's
 * first edit included), and it opens over the page they land on.
 */
export function tourOpensAfterConfirm(tour: OnboardingV2State['tour']): boolean {
  return tour.seenAt === null;
}

/** Per member: edit mode has just sent them back through their history, where no state can be carried. */
export const returnedKey = (memberId: string): string => `rsn_onb_v2_returned_${memberId}`;

/** How the member chose on screen 2. Only a LinkedIn choice lets LinkedIn suggest anything. */
export type SignupChoice = 'linkedin' | 'email';

/** Remembered for the visit, per member, so two people on one browser never share it. */
export const signupChoiceKey = (memberId: string): string => `rsn_onb_v2_via_${memberId}`;

export const parseSignupChoice = (value: string | null | undefined): SignupChoice | null =>
  (value === 'linkedin' || value === 'email' ? value : null);

/**
 * The choice to act on: this tab's own first (it is the freshest thing the member did here, and the state may not have
 * caught up with it yet), then whichever the server recorded last, which is how another tab or device knows.
 */
export function signupChoiceOf(inThisTab: SignupChoice | null, onServer: SignupChoice | null | undefined): SignupChoice | null {
  return inThisTab ?? onServer ?? null;
}

/** Where edit mode returns to when the page was opened straight onto it, with nothing in the app before it. */
export function editFallback(target: EditTarget): string {
  return target === 'profile' ? '/profile' : '/';
}

// ── Ticking ──────────────────────────────────────────────────────────────────

/** Tick or untick: every answer on a question can be ticked together, in the order they were ticked. */
export function toggleKey(selected: readonly string[], key: string): string[] {
  return selected.includes(key) ? selected.filter(k => k !== key) : [...selected, key];
}

/** A question's ticks, on that question's own field. */
export function withKeys(a: OnboardingV2Answers, q: Question, keys: string[]): OnboardingV2Answers {
  // The keys are q.options' own keys, so they are q.field's key type: the options list is the one place where the
  // catalogue's literal key types are widened to string, and this is where they come back.
  return { ...a, [q.field]: keys } as OnboardingV2Answers;
}

/** A question's "Something else" words, on that question's own field. */
export function withOwnWords(a: OnboardingV2Answers, q: Question, text: string): OnboardingV2Answers {
  return { ...a, [q.ownWordsField]: text };
}

/**
 * Q4, from every answer LinkedIn's stated role supports: used only when they have not answered it and have not touched
 * it. Only answers this screen shows are used, once each, so nothing is ticked that the member cannot see.
 */
export function guessedSelf(a: OnboardingV2Answers, guesses: readonly string[] | null | undefined, touched: boolean): string[] | null {
  if (touched || a.selfKinds.length) return null;
  const shown: readonly string[] = ONBOARDING_V2_SELF.map(o => o.key);
  const picked = [...new Set((guesses ?? []).filter(k => shown.includes(k)))];
  return picked.length ? picked : null;
}

/** What LinkedIn picked, while that is exactly what is ticked (in any order): those tiles carry the note. Else none. */
export function guessedStill(selected: readonly string[], picked: readonly string[]): readonly string[] {
  return picked.length > 0 && selected.length === picked.length && picked.every(k => selected.includes(k)) ? picked : [];
}

// ── What goes to the server ──────────────────────────────────────────────────

/** A box's words belong to its option: null when the option is not ticked, or the box is blank. */
const ownWords = (keys: readonly string[], key: string, text: string | null): string | null =>
  keys.includes(key) ? tidy(text) : null;

/** POST /onboarding/v2/confirm: the whole set, every time, so confirming never depends on a draft save having landed. */
export function confirmBody(a: OnboardingV2Answers, profile?: OnboardingV2ProfileInput): OnboardingV2ConfirmRequest {
  const O = ONBOARDING_V2_OTHER_KEYS;
  return {
    lookingToMeet: [...a.lookingToMeet],
    meetOther: ownWords(a.lookingToMeet, O.meet, a.meetOther),
    hopingToFind: [...a.hopingToFind],
    findOther: ownWords(a.hopingToFind, O.find, a.findOther),
    findSpecific: tidy(a.findSpecific),
    canOffer: [...a.canOffer],
    offerOther: ownWords(a.canOffer, O.offer, a.offerOther),
    selfKinds: [...a.selfKinds],
    selfOther: ownWords(a.selfKinds, O.self, a.selfOther),
    ...(profile ? { profile } : {}),
  };
}

export interface ProfileFields {
  displayName: string;
  jobTitle: string;
  company: string;
  industry: string;
}

/** The longest each screen 7 field may be: the server's limits. */
export const PROFILE_MAX: Record<keyof ProfileFields, number> = {
  displayName: L.displayNameMaxLen,
  jobTitle: L.jobTitleMaxLen,
  company: L.companyMaxLen,
  industry: L.industryMaxLen,
};

/** What the profile already holds for the fields screen 7 may leave empty. */
export type StoredProfile = Partial<Record<'jobTitle' | 'company' | 'industry', string | null>>;

const MAY_BE_EMPTY = ['jobTitle', 'company', 'industry'] as const;

/**
 * The profile half of confirm, on the server's contract: a role, company or industry that is missing (or null) is
 * kept, and "" clears it. So what they typed is sent; a field they emptied that the profile holds is sent as "", and
 * the server clears it; a field never filled and left empty is not sent at all. The name is never cleared: a blank
 * one is "not given" (null), and the screen does not send one.
 */
export function profileInput(
  fields: ProfileFields, stored: StoredProfile, timezone: string | null, useLinkedinPhoto: boolean,
): OnboardingV2ProfileInput {
  const input: OnboardingV2ProfileInput = { displayName: tidy(fields.displayName), timezone };
  for (const key of MAY_BE_EMPTY) {
    const typed = tidy(fields[key]);
    if (typed) input[key] = typed;
    else if (tidy(stored[key])) input[key] = '';
  }
  if (useLinkedinPhoto) input.useLinkedinPhoto = true;
  return input;
}

export type DraftPatch = Partial<OnboardingV2Answers> & { step: OnboardingV2Step };

/** PUT /onboarding/v2/answers as a question is left: its answers, its words, and where they are going. */
export function draftPatch(q: Question, a: OnboardingV2Answers, step: OnboardingV2Step): DraftPatch {
  const O = ONBOARDING_V2_OTHER_KEYS;
  switch (q.step) {
    case 'q1': return { lookingToMeet: [...a.lookingToMeet], meetOther: ownWords(a.lookingToMeet, O.meet, a.meetOther), step };
    case 'q2': return {
      hopingToFind: [...a.hopingToFind], findOther: ownWords(a.hopingToFind, O.find, a.findOther),
      findSpecific: tidy(a.findSpecific), step,
    };
    case 'q3': return { canOffer: [...a.canOffer], offerOther: ownWords(a.canOffer, O.offer, a.offerOther), step };
    case 'q4': return { selfKinds: [...a.selfKinds], selfOther: ownWords(a.selfKinds, O.self, a.selfOther), step };
  }
}

// ── Screen 7 ─────────────────────────────────────────────────────────────────

/**
 * Which value a profile field shows. What they typed wins, even a blank. Then
 * what the profile already holds: nothing LinkedIn says is written over what a
 * member (or anyone) already set. Then LinkedIn's suggestion, marked as such.
 */
export function profileValue(
  edited: string | undefined, stored: string | null | undefined, suggested: string | null | undefined,
): { value: string; fromLinkedin: boolean } {
  if (edited !== undefined) return { value: edited, fromLinkedin: false };
  const own = tidy(stored);
  if (own) return { value: own, fromLinkedin: false };
  const fromLinkedin = tidy(suggested);
  return fromLinkedin ? { value: fromLinkedin, fromLinkedin: true } : { value: '', fromLinkedin: false };
}

/** "Your answers": the short labels of what they ticked, their own words in place of "Something else". */
export function answerSummary(q: Question, a: OnboardingV2Answers): string {
  const words = tidy(a[q.ownWordsField]);
  return keysOf(q, a)
    .map(k => (k === q.ownWordsKey && words ? `“${words}”` : shortLabelFor(q.options, k)))
    .join(' · ');
}

/** A calm line for each LinkedIn outcome that leaves something to type. Nothing when it all came through. */
export function linkedinNote(status: OnboardingV2LinkedinStatus): string | null {
  switch (status) {
    case 'searching': return "We're still reading your LinkedIn profile. Your details will appear here when it's done, or you can type them now.";
    case 'partial': return 'We found some of your details on LinkedIn. Please add the rest.';
    case 'not_found': return "We couldn't find your details on LinkedIn. Please type them in.";
    case 'failed': return "We couldn't read your LinkedIn profile just now. Please type your details in.";
    default: return null;
  }
}

// ── The LinkedIn link ────────────────────────────────────────────────────────

/** The server's own sentences (routes/onboarding-v2.ts, linkedin-v2.ts). */
export const LINKEDIN_EMPTY = 'Enter your LinkedIn profile link.';
export const LINKEDIN_EXAMPLE = 'Enter your LinkedIn profile link, for example linkedin.com/in/your-name';

/** The stored address as a member would type it: no https://www. in front, so it fits a phone. */
export function linkedinForInput(url: string | null | undefined): string {
  return (url ?? '').trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
}

/**
 * Answered at once, without spending a request from the member's ten: an empty
 * box, or something that is plainly not a profile link. Any form of
 * linkedin.com/in/<name> goes to the server, which has the last word.
 */
export function linkedinInputProblem(input: string): string | null {
  const v = input.trim();
  if (!v) return LINKEDIN_EMPTY;
  return /\s/.test(v) || !/linkedin\.com\/in\/[^/?#]+/i.test(v) ? LINKEDIN_EXAMPLE : null;
}

// ── The time zone ────────────────────────────────────────────────────────────

/** Shown like "Asia/Kathmandu", with spaces where a name has underscores ("America/New York"). */
export const zoneLabel = (zone: string): string => zone.replace(/_/g, ' ');

const squash = (s: string) => s.toLowerCase().replace(/[\s_/-]+/g, ' ').trim();

/** The searchable list: any part of the name, in any case, spaces, slashes and underscores alike. */
export function searchZones(zones: readonly string[], query: string): string[] {
  const wanted = squash(query);
  return wanted ? zones.filter(z => squash(z).includes(wanted)) : [...zones];
}

/** Shaped like a zone name, as the server checks it: an offset such as "+05:45" is not a zone. */
const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/** A zone a clock can show: the runtime's own check, the same one the server makes before it stores it. */
export function isRealZone(zone: string | null | undefined): zone is string {
  if (!zone || zone.length > ONBOARDING_V2_LIMITS.timezoneMaxLen || !ZONE_SHAPE.test(zone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Browsers (through ICU) still detect and list a few zones by the names they had
 * before they were renamed: someone in Kathmandu is told "Asia/Katmandu", and
 * searching the list for "Kolkata" finds nothing under "Asia/Calcutta". Both
 * names work everywhere a zone is used, so people are shown today's.
 */
const RENAMED: Readonly<Record<string, string>> = {
  'Africa/Asmera': 'Africa/Asmara',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Catamarca': 'America/Argentina/Catamarca',
  'America/Coral_Harbour': 'America/Atikokan',
  'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Godthab': 'America/Nuuk',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Jujuy': 'America/Argentina/Jujuy',
  'America/Louisville': 'America/Kentucky/Louisville',
  'America/Mendoza': 'America/Argentina/Mendoza',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Europe/Kiev': 'Europe/Kyiv',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Truk': 'Pacific/Chuuk',
};

/** Today's name for a zone, when the runtime accepts it; otherwise the name as given. */
export function currentZoneName(zone: string): string {
  const now = RENAMED[zone];
  return now && isRealZone(now) ? now : zone;
}

/** The browser's own zone, detected rather than asked: screen 7 shows it with [Change]. */
export function browserTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isRealZone(zone) ? currentZoneName(zone) : null;
  } catch {
    return null;
  }
}

/**
 * Every zone the runtime knows, for the [Change] list, by today's names, with
 * the current one in it. A runtime without the list (Safari before 15.4)
 * offers UTC beside the current one.
 */
export function zoneList(current: string | null | undefined): string[] {
  // Intl.supportedValuesOf is ES2022; the client's lib is ES2020, so it is read as optional.
  const intl = Intl as unknown as { supportedValuesOf?: (key: 'timeZone') => string[] };
  let listed: string[] = [];
  try {
    listed = intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    listed = [];
  }
  const zones = new Set((listed.length ? listed : ['UTC']).map(currentZoneName));
  if (isRealZone(current)) zones.add(currentZoneName(current));
  return [...zones].sort();
}

// ── When a request fails ─────────────────────────────────────────────────────

const SLOW_DOWN = 'Slow down a moment, then try again.';

interface FailedRequest {
  isAxiosError?: unknown;
  request?: unknown;
  code?: unknown;
  response?: { status?: number; data?: { error?: { message?: unknown; details?: unknown } } };
}

/** A sentence the server wrote for members: short, and never the generic "Validation failed". */
function sentence(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  return t && t.length <= 200 && t !== 'Validation failed' ? t : null;
}

/**
 * Validation details are { "field.path": [messages] }: the first field with a message, and that message.
 * `_root` is an unknown field, a bug in this client in Zod's own words, and is never shown.
 */
function firstDetail(details: unknown): { path: string; message: unknown } | null {
  if (!details || typeof details !== 'object') return null;
  for (const [path, messages] of Object.entries(details)) {
    if (path !== '_root' && Array.isArray(messages) && messages.length) return { path, message: messages[0] };
  }
  return null;
}

function refusalOf(err: unknown): { status?: number; error?: { message?: unknown; details?: unknown } } | undefined {
  const failed = (typeof err === 'object' && err !== null ? err : {}) as FailedRequest;
  return failed.response ? { status: failed.response.status, error: failed.response.data?.error } : undefined;
}

/**
 * One sentence for a failed onboarding request. 429 and 400 carry sentences the
 * server wrote for members ("Please wait a few minutes before trying another
 * LinkedIn link.", "Select at least one answer."); anything else is the
 * caller's own words, so no code, id or library message reaches a member.
 */
export function onboardingError(err: unknown, fallback: string): string {
  const failed = (typeof err === 'object' && err !== null ? err : {}) as FailedRequest;
  const response = failed.response;
  if (!response) {
    const noAnswer = failed.isAxiosError === true || failed.request != null
      || (typeof failed.code === 'string' && ['ERR_NETWORK', 'ECONNABORTED', 'ETIMEDOUT'].includes(failed.code));
    return noAnswer ? CONNECTION_LOST : fallback;
  }
  const error = response.data?.error;
  if (response.status === 429) return sentence(error?.message) ?? SLOW_DOWN;
  if (response.status === 400) {
    if (error?.details != null) return sentence(firstDetail(error.details)?.message) ?? fallback;
    return sentence(error?.message) ?? fallback;
  }
  return fallback;
}

/** Which question a field of the confirm body belongs to. */
const QUESTION_OF: Readonly<Record<string, QuestionStepKey>> = {
  lookingToMeet: 'q1', meetOther: 'q1',
  hopingToFind: 'q2', findOther: 'q2', findSpecific: 'q2',
  canOffer: 'q3', offerOther: 'q3',
  selfKinds: 'q4', selfOther: 'q4',
};
const OWN_WORDS_FIELDS = new Set(['meetOther', 'findOther', 'offerOther', 'selfOther']);
const PROFILE_FIELDS = new Set(['displayName', 'jobTitle', 'company', 'industry', 'timezone']);

export interface ConfirmProblem {
  /** Said as the server said it when it is a sentence for members; otherwise the caller's own. */
  message: string;
  /** The question it is about, shown there. */
  question: QuestionStepKey | null;
  /** About that question's "Something else" words rather than its ticks. */
  ownWords: boolean;
  /** The screen 7 field it is about, shown under it. */
  field: keyof ProfileFields | 'timezone' | null;
}

/** A refusal from confirm, placed on the thing it is about; with nothing to point at, on the screen as a whole. */
export function confirmProblem(err: unknown, fallback: string): ConfirmProblem {
  const message = onboardingError(err, fallback);
  const refusal = refusalOf(err);
  const path = refusal?.status === 400 ? firstDetail(refusal.error?.details)?.path ?? '' : '';
  const [head, sub] = path.split('.');
  const field = head === 'profile' && PROFILE_FIELDS.has(sub) ? (sub as keyof ProfileFields | 'timezone') : null;
  return { message, question: QUESTION_OF[head] ?? null, ownWords: OWN_WORDS_FIELDS.has(head), field };
}
