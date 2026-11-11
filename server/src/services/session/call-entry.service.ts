// ─── The RSN Call link: entering an event (Part 2 foundation, Task 6, 11 Nov 2026; spec 02, 04, 11) ───────
//
// Open the link → give an email → type the 6-digit code sent to it → give only what the event still needs → enter.
//
//   sendCallEntryCode   every address gets a code by email, and every answer is the same 200 (fix round 1, 11 Nov
//                       2026: the link never tells anyone whether an address has an RSN account, nor whether it is on
//                       the event's list). The send leaves the request path, so the timing is the same too.
//   verifyCallEntry     spends the code (or the email's button) under the sign-in code's rules (spendSignInCode: 15
//                       minutes, five tries). Only then, before anything is spent or made, it decides admission for an
//                       address with no account: open and approval events take it; an invitation-only event a listed
//                       address, a redeemable admission code or a personal invite; an event with no admission mode a
//                       public event or a personal invite. Refused, the person hears it in the event's own words (and
//                       may send the same code again with an admission code); nothing is spent and no account is made.
//                       Otherwise it signs in: the account as it is, or a new event guest of this event.
//   readCallEntry       where a signed-in person stands on the event, changing nothing.
//   enterCall           gives what was missing and takes the place (registerParticipant, the one way a place is given:
//                       every admission, capacity, removal and guest rule holds), or sends the request an approval event
//                       asks for. Calling it again changes nothing. Part 3 Task 3: a full event puts the person on its
//                       waiting list (registerOrWaitlist; step 'waitlisted' with their position), and the first in line
//                       is given the next place that frees.
//
// Open items this file closes (handed over by Tasks 3 and 4):
//   - A guest cannot call POST /sessions/:id/admission/redeem (not on the guest allowlist). Their admission code is
//     redeemed here instead, inside the entry (enterCall), so the allowlist stays as narrow as it is.
//   - guestMayRegister gains the fact `arrivedThroughCallLink`, which only enterCall sets, for the event whose link
//     the guest is on. It widens nothing else: canRegister still decides the place.
//   - Nothing here touches a pod or a circle, and circle.service never writes a circle membership for an event guest
//     whatever path asks (a join, an invite, an approval).
//   - A guest made by the link is named 'Guest' (users.display_name is NOT NULL); the details step replaces it.

import {
  ErrorCodes, callLinkPath, cleanCallDisplayName, eventZone,
  type AccountKind, type CallEntryState, type CallEventSummary, type EventLifecycle, type UserRole,
} from '@rsn/shared';
import { query, transaction } from '../../db';
import config from '../../config';
import logger from '../../config/logger';
import { AppError, ValidationError } from '../../middleware/errors';
import { fanoutProfileChange, fanoutSessionEntities } from '../../realtime/fanout';
import { E } from '../../realtime/entities';
import * as identity from '../identity/identity.service';
import { clientOriginConfig, firstAllowedClientBaseUrl } from '../identity/client-origin';
import { isEmailTypeEnabled, sendCallEntryCodeEmail } from '../email/email.service';
import {
  admissionModeOf, callLinkNotFound, ensureCallCode, eventForViewer, findCallEvent,
  lifecycleOfCallEvent, visibilityOf, type CallEventRow,
} from './call-link.service';
import {
  EVENT_ADMISSION_REQUIRED_SENTENCE, canRegister, lineLooksStalled, needsApproval, readEventAccessFacts, runsEvent,
  type EventAccessFacts,
} from './event-access';
import {
  ADMISSION_CODE_USED_SENTENCE, fanoutAdmissionChanged, hashAdmissionCode, normaliseAdmissionCode, redeemAdmissionCode,
} from './event-admission.service';
import { fanoutEventGroups, getEventGroupRules, setParticipantGroups } from './event-groups.service';
import { requestToJoin } from './event-requests.service';
import { leaveWaitlist, registerOrWaitlist } from './event-waitlist.service';
import { lineStalled } from './session.service';
import { eventImageColumns, eventImageUrlOf } from './event-image-url';
import { sendRegistrationEmail } from './registration-email';

export const CALL_EVENT_ENDED_SENTENCE = 'This event has ended.';
export const CALL_EVENT_CANCELLED_SENTENCE = 'This event was cancelled.';
/** A new address (or a guest) on an event with no admission mode that is not public and has not invited them. */
export const CALL_LINK_MEMBERS_SENTENCE =
  'This event is for REASON members and the people its organiser invites. Ask the organiser for an invitation.';
const REMOVED_SENTENCE = 'You have been removed from this event by the host';
const ACCOUNT_CLOSED_SENTENCE = 'Your account cannot join events right now.';
const CODES_OFF_SENTENCE = 'We cannot send codes for this event just now. Please try again later.';
/** An address with no account, proved, at an invitation-only event it has no tie to. */
export const CALL_INVITATION_ONLY_SENTENCE =
  'This event is invitation only. Enter your admission code, or ask the organiser to invite this email address.';

/** The participant statuses that hold a place (left and no-show come back through a registration). */
const PLACE_STATUSES: readonly string[] = ['registered', 'checked_in', 'in_lobby', 'in_round'];

const NOTHING_MISSING = { displayName: false, group: false, admissionCode: false } as const;

const iso = (d: Date | string | null): string | null => (d ? new Date(d).toISOString() : null);

/** 409 for an event that takes nobody any more, or null. */
function closedEventRefusal(lifecycle: EventLifecycle): AppError | null {
  if (lifecycle === 'cancelled') return new AppError(409, ErrorCodes.EVENT_CANCELLED, CALL_EVENT_CANCELLED_SENTENCE);
  if (lifecycle === 'completed' || lifecycle === 'archived') {
    return new AppError(409, ErrorCodes.EVENT_ENDED, CALL_EVENT_ENDED_SENTENCE);
  }
  return null;
}

/** The event a code leads to for someone not signed in: never a draft (the same 404 as an unknown code). */
async function publishedCallEvent(code: string): Promise<CallEventRow> {
  const event = await findCallEvent(code);
  if (!event || event.publication === 'draft') throw callLinkNotFound();
  return event;
}

// ─── Who may come in by email ────────────────────────────────────────────────

/**
 * A personal invite to the event for this address: made for it (invitee_email), single use, and accepted or still
 * pending and not expired. A shared or multi-use invite link never admits by itself (Task 4's restricted rule).
 */
async function personallyInvited(sessionId: string, email: string): Promise<boolean> {
  const r = await query(
    `SELECT 1 FROM invites i
      WHERE i.session_id = $1 AND lower(i.invitee_email) = $2 AND i.max_uses = 1
        AND (i.status = 'accepted' OR (i.status = 'pending' AND (i.expires_at IS NULL OR i.expires_at > NOW())))
      LIMIT 1`,
    [sessionId, email],
  );
  return r.rows.length > 0;
}

/** The address is on the event's allowed list and not revoked. */
async function emailListed(sessionId: string, email: string): Promise<boolean> {
  const r = await query(
    `SELECT 1 FROM event_admission_entries WHERE session_id = $1 AND email = $2 AND revoked_at IS NULL`,
    [sessionId, email],
  );
  return r.rows.length > 0;
}

/**
 * Where an admission code of the event stands (checked, not spent): `redeemable` (unclaimed, not revoked, not past its
 * expiry), `used` (one of the event's codes that someone already redeemed, not revoked), or `invalid` for everything else
 * (a typo, another event's code, a revoked or an expired one), which all read the same.
 */
async function admissionCodeStanding(sessionId: string, raw: string): Promise<'redeemable' | 'used' | 'invalid'> {
  const normalised = normaliseAdmissionCode(raw);
  if (!normalised) return 'invalid';
  const r = await query<{ used: boolean; live: boolean }>(
    `SELECT redeemed_at IS NOT NULL AS used, (expires_at IS NULL OR expires_at > NOW()) AS live
       FROM event_admission_codes
      WHERE session_id = $1 AND code_hash = $2 AND revoked_at IS NULL`,
    [sessionId, hashAdmissionCode(sessionId, normalised)],
  );
  const code = r.rows[0];
  if (!code) return 'invalid';
  if (code.used) return 'used';
  return code.live ? 'redeemable' : 'invalid';
}

/**
 * Whether the event takes a new person who arrives by its link (an address with no account once it has proved its code,
 * an event guest at entry), or the refusal: open and approval events do; an invitation-only event only for a listed
 * address, a redeemable admission code or a personal invite; an event with no admission mode only when it is public, or
 * for a personal invite. Never asked before the address is proved (no account-existence answer to anyone else).
 */
async function newcomerRefusal(event: CallEventRow, email: string, admissionCode?: string): Promise<AppError | null> {
  const mode = admissionModeOf(event);
  if (mode === 'open' || mode === 'approval') return null;
  if (await personallyInvited(event.id, email)) return null;
  if (mode === 'restricted') {
    if (await emailListed(event.id, email)) return null;
    if (admissionCode) {
      const standing = await admissionCodeStanding(event.id, admissionCode);
      if (standing === 'redeemable') return null;
      // Asked only after the address is proved, so naming a spent code tells nothing about who has an account. A wrong,
      // unknown or expired code keeps the event's own refusal below.
      if (standing === 'used') return new AppError(409, ErrorCodes.ADMISSION_CODE_USED, ADMISSION_CODE_USED_SENTENCE);
    }
    return new AppError(403, ErrorCodes.EVENT_ADMISSION_REQUIRED, CALL_INVITATION_ONLY_SENTENCE, { admissionCode: true });
  }
  if (visibilityOf(event) === 'public') return null;
  return new AppError(403, ErrorCodes.EVENT_PRIVATE, CALL_LINK_MEMBERS_SENTENCE, { admissionCode: false });
}

// ─── Sending and checking the code ───────────────────────────────────────────

/**
 * Email a 6-digit entry code (and a button that enters by itself) for the event behind `code`, to any address: the answer
 * is the same `{ sent: true }` for every one, whether or not it has an account, is on the event's list, or is closed.
 * Only the event decides anything here (unknown 404, over 409, the admin switch 503), and before the address is read.
 * The send leaves the request path, so a slow or failing provider never tells one address from another (a failure is
 * logged). In development the code comes back in the answer too (never in production).
 * The email's button opens the site the person asked from (the page's `clientUrl`, else the request's Origin), when it
 * is one of our sites by sign-in's exact list (client-origin.ts): the preview opens the preview. Else the main app.
 */
export async function sendCallEntryCode(
  code: string,
  email: string,
  opts: { clientUrl?: string; origin?: string } = {},
): Promise<{ sent: true; devCode?: string }> {
  const event = await publishedCallEvent(code);
  const closed = closedEventRefusal(lifecycleOfCallEvent(event));
  if (closed) throw closed;
  if (!(await isEmailTypeEnabled('event_entry_code'))) {
    throw new AppError(503, ErrorCodes.SERVICE_UNAVAILABLE, CODES_OFF_SENTENCE);
  }

  const address = email.trim().toLowerCase();
  const { token, code: entryCode } = await identity.issueEventEntryLink(address, event.id);
  const base = firstAllowedClientBaseUrl([opts.clientUrl, opts.origin], clientOriginConfig());
  const link = `${base}${callLinkPath(event.call_code)}?${new URLSearchParams({ entry: token }).toString()}`;
  const message = { eventTitle: event.title, code: entryCode, link };

  if (config.isDev && !config.resendApiKey) return { sent: true, devCode: entryCode };
  void sendCallEntryCodeEmail(address, message).catch((err) =>
    logger.warn({ err, sessionId: event.id }, 'Event entry code email failed'));
  return config.isDev ? { sent: true, devCode: entryCode } : { sent: true };
}

/**
 * Prove the address with the 6-digit code (or the email's button) for this event, and sign in: an existing account as
 * it is, a new address as an event guest of this event. A code from another event's email, a sign-in code, a spent,
 * expired or locked code: refused as spendSignInCode refuses, the same for every address. Once the code is proved right,
 * an address with no account that the event does not take is refused (403 in the event's words, `details.admissionCode`
 * saying whether an admission code would help) before the code is spent or any account is made; `admissionCode` is then
 * checked, not spent (enterCall redeems it).
 */
export async function verifyCallEntry(
  code: string,
  input: ({ email: string; code: string } | { token: string }) & { admissionCode?: string },
): Promise<Awaited<ReturnType<typeof identity.signInForEventEntry>>> {
  const event = await publishedCallEvent(code);
  const closed = closedEventRefusal(lifecycleOfCallEvent(event));
  if (closed) throw closed;
  const admit = async (provedEmail: string) => {
    if (await identity.getUserByEmail(provedEmail)) return;
    const refusal = await newcomerRefusal(event, provedEmail, input.admissionCode);
    if (refusal) throw refusal;
  };
  const email = 'token' in input
    ? await identity.verifyEventEntryToken(input.token, event.id, admit)
    : await identity.verifyEventEntryCode(input.email, event.id, input.code, admit);
  return identity.signInForEventEntry(email, event.id);
}

// ─── Where a signed-in person stands ─────────────────────────────────────────

interface PersonRow {
  email: string;
  display_name: string | null;
  first_name: string | null;
  account_kind: AccountKind;
}

async function readPerson(userId: string): Promise<PersonRow | null> {
  const r = await query<PersonRow>(
    `SELECT email, display_name, first_name, account_kind FROM users WHERE id = $1`,
    [userId],
  );
  return r.rows[0] ?? null;
}

/** The name the link made for a guest, or no name at all: the details step asks for one. */
function needsName(p: PersonRow): boolean {
  const name = (p.display_name ?? '').trim();
  if (name === '') return true;
  return p.account_kind === 'event_guest' && name === 'Guest' && (p.first_name ?? '').trim() === '';
}

/** The group an invitation carries for this person: their allowed-list entry's, if it is one of the event's groups. */
async function invitationGroupOf(sessionId: string, email: string, groupKeys: Set<string>): Promise<string | null> {
  const r = await query<{ group_key: string | null }>(
    `SELECT group_key FROM event_admission_entries
      WHERE session_id = $1 AND email = $2 AND revoked_at IS NULL AND group_key IS NOT NULL`,
    [sessionId, email.trim().toLowerCase()],
  );
  const key = r.rows[0]?.group_key ?? null;
  return key && groupKeys.has(key) ? key : null;
}

async function hasGroup(sessionId: string, userId: string): Promise<boolean> {
  const r = await query(`SELECT 1 FROM event_participant_groups WHERE session_id = $1 AND user_id = $2 LIMIT 1`, [sessionId, userId]);
  return r.rows.length > 0;
}

const refused = (base: CallEntryState, code: string, message: string): CallEntryState =>
  ({ ...base, step: 'refused', refusal: { code, message } });

/**
 * Where the person stands on this event (already resolved from its code), changing nothing. Order: the event's own
 * end; a draft they do not run (404); a closed account; a removal (terminal); their place; their request; what the
 * event still needs; whether they would request or register; else a refusal in the event's words.
 */
export async function readCallEntryForEvent(event: CallEventRow, userId: string, role: UserRole): Promise<CallEntryState> {
  const lifecycle = lifecycleOfCallEvent(event);
  const base: CallEntryState = {
    step: 'details', sessionId: null, livePath: null, missing: { ...NOTHING_MISSING }, refusal: null,
    startsAt: iso(event.scheduled_at), waitlistPosition: null,
  };
  if (lifecycle === 'cancelled') return { ...base, step: 'cancelled' };
  if (lifecycle === 'completed' || lifecycle === 'archived') return { ...base, step: 'ended' };

  const [facts, person] = await Promise.all([readEventAccessFacts(event.id, userId), readPerson(userId)]);
  if (!facts || !person) throw callLinkNotFound();
  if (facts.publication === 'draft' && !runsEvent(facts, role)) throw callLinkNotFound();
  if (!facts.accountActive) return refused(base, ErrorCodes.AUTH_FORBIDDEN, ACCOUNT_CLOSED_SENTENCE);
  if (facts.participantStatus === 'removed') return refused(base, 'REMOVED_FROM_EVENT', REMOVED_SENTENCE);

  const runs = runsEvent(facts, role);
  const holds = facts.participantStatus !== null && PLACE_STATUSES.includes(facts.participantStatus);
  if (holds || runs) {
    const live = lifecycle === 'live';
    return {
      ...base, sessionId: event.id,
      step: live ? 'enter' : 'wait_for_start',
      livePath: live ? `/session/${event.id}/live` : null,
    };
  }
  // Part 3 Task 3: on the full event's waiting list. Not an enterable step: entering again changes nothing.
  if (facts.waitlistPosition !== null) {
    // Fix round 1 (review I-1): a guest on the line cannot register past it, so their own read moves a stalled line on.
    if (lineLooksStalled(facts)) lineStalled(event.id);
    return { ...base, step: 'waitlisted', sessionId: event.id, waitlistPosition: facts.waitlistPosition };
  }
  if (facts.myRequest === 'pending') return { ...base, step: 'pending_approval', sessionId: event.id };
  if (facts.myRequest === 'declined') return { ...base, step: 'declined' };

  // An event guest comes in by the link only where a newcomer would (newcomerRefusal), or where they already belong.
  if (person.account_kind === 'event_guest' && facts.participantStatus === null && facts.myRequest !== 'approved'
      && !facts.entitled && !facts.isInvited) {
    const refusal = await newcomerRefusal(event, person.email);
    if (refusal && refusal.code !== ErrorCodes.EVENT_ADMISSION_REQUIRED) return refused(base, refusal.code, refusal.message);
  }

  const missing = await missingFor(event, facts, person, userId);
  if (missing.admissionCode) {
    return {
      ...base, missing,
      refusal: { code: ErrorCodes.EVENT_ADMISSION_REQUIRED, message: EVENT_ADMISSION_REQUIRED_SENTENCE },
    };
  }
  // A request carries no group: the organisers place an approved person (Task 5's ruling), so only the name is asked.
  if (needsApproval(facts, role)) {
    const asked = { ...missing, group: false };
    return { ...base, missing: asked, step: asked.displayName ? 'details' : 'request' };
  }
  const decision = canRegister(facts, role);
  if (!decision.ok) return refused({ ...base, missing }, decision.code, decision.message);
  return { ...base, missing };
}

/** What the event still needs from this person before a place: a name, a group, an admission code. */
async function missingFor(
  event: CallEventRow, facts: EventAccessFacts, person: PersonRow, userId: string,
): Promise<CallEntryState['missing']> {
  const rules = await getEventGroupRules(event.id);
  let group = false;
  if (rules && !(await hasGroup(event.id, userId))) {
    const invited = await invitationGroupOf(event.id, person.email, new Set(rules.groups.map((g) => g.key)));
    group = invited === null;
  }
  return {
    displayName: needsName(person),
    group,
    admissionCode: admissionModeOf(event) === 'restricted' && !facts.entitled && !facts.isInvited,
  };
}

/** Where a signed-in person stands on the event behind `code`. */
export async function readCallEntry(code: string, userId: string, role: UserRole): Promise<CallEntryState> {
  const event = await eventForViewer(code, { userId, role });
  return readCallEntryForEvent(event, userId, role);
}

// ─── Entering ────────────────────────────────────────────────────────────────

/** The steps enterCall can move on from; every other step is already an answer, and entering again changes nothing. */
const ENTERABLE: readonly CallEntryState['step'][] = ['details', 'request'];

/**
 * Give what the event still needs, then take the place (or send the request an approval event asks for). Each piece is
 * written once: the name only while it is unset (the guest's 'Guest' included), an admission code redeemed for this
 * person (the same code again by them is not a second redemption), a group the invitation or the code carries before
 * the person's own choice. The place itself is given by registerParticipant, which holds every rule; a refusal there
 * comes back as `refused`. Calling it again returns the same state and changes nothing.
 */
export async function enterCall(
  code: string,
  userId: string,
  role: UserRole,
  input: { displayName?: string; groupKeys?: string[]; admissionCode?: string },
  opts: { origin?: string } = {},
): Promise<CallEntryState> {
  const event = await eventForViewer(code, { userId, role });
  const before = await readCallEntryForEvent(event, userId, role);
  if (!ENTERABLE.includes(before.step)) return before;

  // What was given is kept even when something else is still missing (a name typed before the group is chosen).
  let name: string | null = null;
  if (before.missing.displayName && input.displayName !== undefined) {
    name = cleanCallDisplayName(input.displayName);
    if (!name) throw new ValidationError('Enter your name (up to 60 characters).');
  }
  const groupKeys = input.groupKeys && input.groupKeys.length > 0 ? input.groupKeys : undefined;

  const person = await readPerson(userId);
  if (!person) throw callLinkNotFound();
  // Fix round 2 (D3: on an approval event, code holders come in directly). A single-use admission code is spent only
  // when it is what lets the person in, and only at the call that gives the place (their name is known by then):
  //   - an invitation-only event they hold no other tie to (missing.admissionCode), or
  //   - an event that would otherwise put them in the approval queue (needsApproval), whichever step shows it (details
  //     for a newcomer still giving a name, request for someone who has one).
  // Anywhere else it is left unspent.
  const facts = await readEventAccessFacts(event.id, userId);
  const wouldRequest = !!facts && needsApproval(facts, role);
  const nameKnown = !before.missing.displayName || !!name;
  const spendCode = !!input.admissionCode && nameKnown && (before.missing.admissionCode || wouldRequest);
  const rules = await getEventGroupRules(event.id);
  const eventGroupKeys = new Set(rules?.groups.map((g) => g.key) ?? []);

  const written = await transaction(async (client) => {
    let renamed = false;
    if (name) {
      const r = await client.query(
        `UPDATE users SET display_name = $2, first_name = CASE WHEN btrim(first_name) = '' THEN $3 ELSE first_name END,
                          updated_at = NOW()
          WHERE id = $1
            AND (btrim(display_name) = '' OR (account_kind = 'event_guest' AND display_name = 'Guest' AND btrim(first_name) = ''))`,
        [userId, name, name.split(' ')[0]],
      );
      renamed = (r.rowCount ?? 0) > 0;
    }
    let codeGroup: string | null = null;
    let redeemed = false;
    if (spendCode) {
      const r = await redeemAdmissionCode(event.id, userId, input.admissionCode!, client);
      codeGroup = r.groupKey;
      redeemed = true;
    }
    // The group an invitation carries (the allowed-list entry first, then the code), as the organisers set it.
    let grouped = false;
    if (rules) {
      const already = await client.query(
        `SELECT 1 FROM event_participant_groups WHERE session_id = $1 AND user_id = $2 LIMIT 1`, [event.id, userId],
      );
      const invitation = await invitationGroupOf(event.id, person.email, eventGroupKeys)
        ?? (codeGroup && eventGroupKeys.has(codeGroup) ? codeGroup : null);
      if (!already.rows[0] && invitation) {
        await setParticipantGroups(event.id, null, userId, [invitation], 'invitation', client);
        grouped = true;
      }
    }
    return { renamed, redeemed, grouped };
  });

  const podId = await podOf(event.id);
  if (written.renamed) void fanoutProfileChange(userId);
  if (written.redeemed) void fanoutAdmissionChanged(event.id, { everyone: true, podId, people: [userId] });
  if (written.grouped) void fanoutEventGroups(event.id);

  const now = await readCallEntryForEvent(event, userId, role);
  if (now.step === 'request') {
    await requestToJoin(event.id, userId, role, null, { arrivedThroughCallLink: true });
    return readCallEntryForEvent(event, userId, role);
  }
  // The person's own group goes in with the place (registerParticipant writes it in the same transaction).
  const groupAnswered = !now.missing.group || !!groupKeys;
  if (now.step !== 'details' || now.missing.displayName || now.missing.admissionCode || !groupAnswered) return now;

  try {
    // A full event puts them on its waiting list (the line tells its own screens); a place is told as before.
    const placed = await registerOrWaitlist(event.id, userId, role, {
      ...(groupKeys ? { groupKeys } : {}), arrivedThroughCallLink: true, joinedVia: 'call_link',
    });
    if (placed.kind === 'registered') {
      void fanoutSessionEntities(podId, event.id, [E.userSessions(userId), E.sessionParticipants(event.id)]);
      if (groupKeys) void fanoutEventGroups(event.id);
      // The "you're registered" email opens the site they entered from, when it is one of ours (else the main app).
      if (placed.isNewRegistration) {
        void sendRegistrationEmail(event.id, userId, firstAllowedClientBaseUrl([opts.origin], clientOriginConfig()));
      }
    }
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    if (err.code === ErrorCodes.SESSION_ALREADY_REGISTERED) return readCallEntryForEvent(event, userId, role);
    if (err.code === ErrorCodes.EVENT_GROUP_REQUIRED) return { ...now, missing: { ...now.missing, group: true } };
    if (err.statusCode === 403 || err.statusCode === 409) return refused(now, err.code, err.message);
    throw err;
  }
  return readCallEntryForEvent(event, userId, role);
}

/**
 * Part 3 Task 3: take oneself off the waiting list of the event behind `code` (the call link's "Leave the waiting list";
 * a guest has no other way to it). Answers where they stand afterwards; someone not on the line is answered as they are.
 */
export async function leaveCallWaitlist(code: string, userId: string, role: UserRole): Promise<CallEntryState> {
  const event = await eventForViewer(code, { userId, role });
  await leaveWaitlist(event.id, userId);
  return readCallEntryForEvent(event, userId, role);
}

async function podOf(sessionId: string): Promise<string | null> {
  const r = await query<{ pod_id: string | null }>(`SELECT pod_id FROM sessions WHERE id = $1`, [sessionId]);
  return r.rows[0]?.pod_id ?? null;
}

// ─── A person's events by link ───────────────────────────────────────────────

interface MyCallEventRow {
  id: string;
  call_code: string | null;
  title: string;
  scheduled_at: Date | null;
  status: string;
  publication: string | null;
  archived_at: Date | null;
  registration_opens_at: Date | null;
  place: string | null;
  request: string | null;
  /** Part 3 Task 3: they are waiting on the event's waiting list. */
  waiting?: boolean | null;
  timezone: string | null;
  has_image: boolean | null;
  image_updated_at: Date | null;
}

/** The step a row of listMyCallEvents shows (no reads: the list's own columns decide it). */
function stepOfRow(row: MyCallEventRow, lifecycle: EventLifecycle): CallEventSummary['step'] {
  if (lifecycle === 'cancelled') return 'cancelled';
  if (lifecycle === 'completed' || lifecycle === 'archived') return 'ended';
  if (row.place === 'removed') return 'refused';
  if (row.place && PLACE_STATUSES.includes(row.place)) return lifecycle === 'live' ? 'enter' : 'wait_for_start';
  if (row.waiting) return 'waitlisted';
  if (row.request === 'pending') return 'pending_approval';
  if (row.request === 'declined') return 'declined';
  return 'details';
}

export const MY_CALL_EVENTS_MAX = 50;

/**
 * The events a person holds a place in, has asked to join or (Part 3 Task 3) is waiting for, each with its link's code:
 * upcoming and live first (soonest first), then the ones that are over (latest first), 50 at most. A draft only for the
 * people who run it.
 */
export async function listMyCallEvents(userId: string): Promise<CallEventSummary[]> {
  const r = await query<MyCallEventRow>(
    `WITH mine AS (
       SELECT session_id FROM session_participants WHERE user_id = $1
       UNION
       SELECT session_id FROM event_join_requests WHERE user_id = $1 AND status IN ('pending', 'approved', 'declined')
       UNION
       SELECT session_id FROM event_waitlist WHERE user_id = $1 AND status = 'waiting'
     )
     SELECT s.id, s.call_code, s.title, s.scheduled_at, s.status::text AS status, s.publication, s.archived_at,
            s.registration_opens_at, sp.status::text AS place, r.status AS request,
            EXISTS (SELECT 1 FROM event_waitlist w WHERE w.session_id = s.id AND w.user_id = $1 AND w.status = 'waiting') AS waiting,
            s.timezone, ${eventImageColumns('s')}
       FROM mine
       JOIN sessions s ON s.id = mine.session_id
       LEFT JOIN session_participants sp ON sp.session_id = s.id AND sp.user_id = $1
       LEFT JOIN event_join_requests r ON r.session_id = s.id AND r.user_id = $1
      WHERE s.publication = 'published' OR s.host_user_id = $1
         OR EXISTS (SELECT 1 FROM session_cohosts c WHERE c.session_id = s.id AND c.user_id = $1)
      ORDER BY (s.status IN ('completed', 'cancelled') OR s.archived_at IS NOT NULL) ASC,
               CASE WHEN s.status IN ('completed', 'cancelled') OR s.archived_at IS NOT NULL THEN NULL ELSE s.scheduled_at END ASC NULLS LAST,
               s.scheduled_at DESC NULLS LAST
      LIMIT $2`,
    [userId, MY_CALL_EVENTS_MAX],
  );
  const out: CallEventSummary[] = [];
  for (const row of r.rows) {
    const code = row.call_code ?? await ensureCallCode(row.id);
    const lifecycle = lifecycleOfCallEvent({
      ...row, call_code: code, description: null, config: null, event_format: null, visibility: null,
      admission_mode: null, host_user_id: '', host_name: null, host_avatar: null,
    });
    out.push({
      code, title: row.title, scheduledAt: iso(row.scheduled_at), timezone: eventZone(row.timezone),
      imageUrl: eventImageUrlOf(row.id, row), lifecycle, step: stepOfRow(row, lifecycle),
    });
  }
  return out;
}
