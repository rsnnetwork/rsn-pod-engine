// ─── The RSN Call link: entering an event (Part 2 foundation, Task 6, 11 Nov 2026; spec 02, 04, 11) ───────
//
// Open the link → give an email → type the 6-digit code sent to it → give only what the event still needs → enter.
//
//   sendCallEntryCode   an existing account always gets a code (unless it is closed). A new address gets one only when
//                       the event may take a new person by email: an open or approval event, a public event with no
//                       admission mode, an invitation-only event for a listed address, a redeemable admission code or a
//                       personal invite, any other event for a personal invite. Else 403 in the event's own words.
//   verifyCallEntry     spends the code (or the email's button) under the sign-in code's rules (spendSignInCode: 15
//                       minutes, five tries) and signs in: the account as it is, or a new event guest of this event.
//   readCallEntry       where a signed-in person stands on the event, changing nothing.
//   enterCall           gives what was missing and takes the place (registerParticipant, the one way a place is given:
//                       every admission, capacity, removal and guest rule holds), or sends the request an approval event
//                       asks for. Calling it again changes nothing.
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
  ErrorCodes, callLinkPath, cleanCallDisplayName,
  type AccountKind, type CallEntryState, type CallEventSummary, type EventLifecycle, type UserRole,
} from '@rsn/shared';
import { query, transaction } from '../../db';
import config from '../../config';
import logger from '../../config/logger';
import { AppError, ValidationError } from '../../middleware/errors';
import { fanoutProfileChange, fanoutSessionEntities } from '../../realtime/fanout';
import { E } from '../../realtime/entities';
import * as identity from '../identity/identity.service';
import { assertCanSignIn } from '../identity/account-access';
import { clientOriginConfig, resolveClientBaseUrl } from '../identity/client-origin';
import { isEmailTypeEnabled, sendCallEntryCodeEmail } from '../email/email.service';
import {
  admissionModeOf, callLinkNotFound, ensureCallCode, eventForViewer, findCallEvent,
  lifecycleOfCallEvent, visibilityOf, type CallEventRow,
} from './call-link.service';
import {
  EVENT_ADMISSION_REQUIRED_SENTENCE, canRegister, needsApproval, readEventAccessFacts, runsEvent,
  type EventAccessFacts,
} from './event-access';
import {
  fanoutAdmissionChanged, hashAdmissionCode, normaliseAdmissionCode, redeemAdmissionCode,
} from './event-admission.service';
import { fanoutEventGroups, getEventGroupRules, setParticipantGroups } from './event-groups.service';
import { requestToJoin } from './event-requests.service';
import { registerParticipant } from './session.service';
import { sendRegistrationEmail } from './registration-email';

export const CALL_EVENT_ENDED_SENTENCE = 'This event has ended.';
export const CALL_EVENT_CANCELLED_SENTENCE = 'This event was cancelled.';
/** A new address (or a guest) on an event with no admission mode that is not public and has not invited them. */
export const CALL_LINK_MEMBERS_SENTENCE =
  'This event is for REASON members and the people its organiser invites. Ask the organiser for an invitation.';
const REMOVED_SENTENCE = 'You have been removed from this event by the host';
const ACCOUNT_CLOSED_SENTENCE = 'Your account cannot join events right now.';
const CODES_OFF_SENTENCE = 'We cannot send codes for this event just now. Please try again later.';

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

/** An admission code of the event that could still be redeemed (checked, not spent). */
async function admissionCodeRedeemable(sessionId: string, raw: string): Promise<boolean> {
  const normalised = normaliseAdmissionCode(raw);
  if (!normalised) return false;
  const r = await query(
    `SELECT 1 FROM event_admission_codes
      WHERE session_id = $1 AND code_hash = $2
        AND redeemed_at IS NULL AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`,
    [sessionId, hashAdmissionCode(sessionId, normalised)],
  );
  return r.rows.length > 0;
}

/**
 * Whether the event takes a new person who arrives by its link (a new address at send time, an event guest at entry),
 * or the refusal: open and approval events do; an invitation-only event only for a listed address, a redeemable
 * admission code or a personal invite; an event with no admission mode only when it is public, or for a personal invite.
 */
async function newcomerRefusal(event: CallEventRow, email: string, admissionCode?: string): Promise<AppError | null> {
  const mode = admissionModeOf(event);
  if (mode === 'open' || mode === 'approval') return null;
  if (await personallyInvited(event.id, email)) return null;
  if (mode === 'restricted') {
    if (await emailListed(event.id, email)) return null;
    if (admissionCode && await admissionCodeRedeemable(event.id, admissionCode)) return null;
    return new AppError(403, ErrorCodes.EVENT_ADMISSION_REQUIRED, EVENT_ADMISSION_REQUIRED_SENTENCE);
  }
  if (visibilityOf(event) === 'public') return null;
  return new AppError(403, ErrorCodes.EVENT_PRIVATE, CALL_LINK_MEMBERS_SENTENCE);
}

// ─── Sending and checking the code ───────────────────────────────────────────

/**
 * Email a 6-digit entry code (and a button that enters by itself) for the event behind `code`. An existing account is
 * refused only when it is closed or suspended; a new address only when the event may not take it (newcomerRefusal),
 * and then no link row is written. In development the code comes back in the answer too (never in production).
 */
export async function sendCallEntryCode(
  code: string,
  email: string,
  opts: { admissionCode?: string; clientUrl?: string } = {},
): Promise<{ sent: true; devCode?: string }> {
  const event = await publishedCallEvent(code);
  const closed = closedEventRefusal(lifecycleOfCallEvent(event));
  if (closed) throw closed;
  const address = email.trim().toLowerCase();
  const existing = await identity.getUserByEmail(address);
  assertCanSignIn(existing);
  if (!existing) {
    const refusal = await newcomerRefusal(event, address, opts.admissionCode);
    if (refusal) throw refusal;
  }
  if (!(await isEmailTypeEnabled('event_entry_code'))) {
    throw new AppError(503, ErrorCodes.SERVICE_UNAVAILABLE, CODES_OFF_SENTENCE);
  }

  const { token, code: entryCode } = await identity.issueEventEntryLink(address, event.id);
  const base = resolveClientBaseUrl(opts.clientUrl, clientOriginConfig());
  const link = `${base}${callLinkPath(event.call_code)}?${new URLSearchParams({ entry: token }).toString()}`;
  const message = { eventTitle: event.title, code: entryCode, link };

  if (config.isDev) {
    if (config.resendApiKey) {
      await sendCallEntryCodeEmail(address, message).catch((err) =>
        logger.warn({ err, sessionId: event.id }, 'Entry code email failed in dev mode; returning the code'));
    }
    return { sent: true, devCode: entryCode };
  }
  await sendCallEntryCodeEmail(address, message);
  logger.info({ sessionId: event.id, existing: !!existing }, 'Event entry code sent');
  return { sent: true };
}

/**
 * Prove the address with the 6-digit code (or the email's button) for this event, and sign in: an existing account as
 * it is, a new address as an event guest of this event. A code from another event's email, a sign-in code, a spent,
 * expired or locked code: refused as spendSignInCode refuses.
 */
export async function verifyCallEntry(
  code: string,
  input: { email: string; code: string } | { token: string },
): Promise<Awaited<ReturnType<typeof identity.signInForEventEntry>>> {
  const event = await publishedCallEvent(code);
  const closed = closedEventRefusal(lifecycleOfCallEvent(event));
  if (closed) throw closed;
  const email = 'token' in input
    ? await identity.verifyEventEntryToken(input.token, event.id)
    : await identity.verifyEventEntryCode(input.email, event.id, input.code);
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
    startsAt: iso(event.scheduled_at),
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
    if (input.admissionCode) {
      const r = await redeemAdmissionCode(event.id, userId, input.admissionCode, client);
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
    await requestToJoin(event.id, userId, role, null);
    return readCallEntryForEvent(event, userId, role);
  }
  // The person's own group goes in with the place (registerParticipant writes it in the same transaction).
  const groupAnswered = !now.missing.group || !!groupKeys;
  if (now.step !== 'details' || now.missing.displayName || now.missing.admissionCode || !groupAnswered) return now;

  try {
    const participant = await registerParticipant(event.id, userId, role, {
      ...(groupKeys ? { groupKeys } : {}), arrivedThroughCallLink: true,
    });
    void fanoutSessionEntities(podId, event.id, [E.userSessions(userId), E.sessionParticipants(event.id)]);
    if (groupKeys) void fanoutEventGroups(event.id);
    if (participant.isNewRegistration) void sendRegistrationEmail(event.id, userId);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    if (err.code === ErrorCodes.SESSION_ALREADY_REGISTERED) return readCallEntryForEvent(event, userId, role);
    if (err.code === ErrorCodes.EVENT_GROUP_REQUIRED) return { ...now, missing: { ...now.missing, group: true } };
    if (err.statusCode === 403 || err.statusCode === 409) return refused(now, err.code, err.message);
    throw err;
  }
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
}

/** The step a row of listMyCallEvents shows (no reads: the list's own columns decide it). */
function stepOfRow(row: MyCallEventRow, lifecycle: EventLifecycle): CallEventSummary['step'] {
  if (lifecycle === 'cancelled') return 'cancelled';
  if (lifecycle === 'completed' || lifecycle === 'archived') return 'ended';
  if (row.place === 'removed') return 'refused';
  if (row.place && PLACE_STATUSES.includes(row.place)) return lifecycle === 'live' ? 'enter' : 'wait_for_start';
  if (row.request === 'pending') return 'pending_approval';
  if (row.request === 'declined') return 'declined';
  return 'details';
}

export const MY_CALL_EVENTS_MAX = 50;

/**
 * The events a person holds a place in or has asked to join, each with its link's code: upcoming and live first (soonest
 * first), then the ones that are over (latest first), 50 at most. A draft only for the people who run it.
 */
export async function listMyCallEvents(userId: string): Promise<CallEventSummary[]> {
  const r = await query<MyCallEventRow>(
    `WITH mine AS (
       SELECT session_id FROM session_participants WHERE user_id = $1
       UNION
       SELECT session_id FROM event_join_requests WHERE user_id = $1 AND status IN ('pending', 'approved', 'declined')
     )
     SELECT s.id, s.call_code, s.title, s.scheduled_at, s.status::text AS status, s.publication, s.archived_at,
            s.registration_opens_at, sp.status::text AS place, r.status AS request
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
    out.push({ code, title: row.title, scheduledAt: iso(row.scheduled_at), lifecycle, step: stepOfRow(row, lifecycle) });
  }
  return out;
}
