// ─── Who can see, join and enter an event: the one rule (T11, 1 Nov 2026; L17) ───────────────────────────
//
// An event's own access lives in sessions.visibility:
//   public                 every signed-in active member sees it and registers.
//   public_with_approval   everyone sees it. Its audience and its invitees register directly; everyone else
//                          requests a place, and the host approves each one (event_join_requests).
//   private                only its audience, its invitees and its participants see it and register. It is not
//                          listed to anyone else, and the event page says "This event is private".
//   NULL                   the event follows its pod exactly as before, T2's D1, D2 and D3 fixes included
//                          (session-access.ts keeps those rules; every NULL path below is theirs).
// Hosts, co-hosts and admins always see and manage. Invitees never wait for approval (an invite is the host's
// say-so). A removed participant stays removed (registerParticipant's own row checks). A removed, suspended or
// banned account sees nothing and joins nothing.
//
// "The event's audience" is one fragment, eventAudienceSql: the pod's active members, and for an event for a whole
// circle (T13, sessions.circle_id) the circle's active members too. Every rule here follows it.
// A closed circle (T14, L22, circles.join_policy) hides its events from people outside it, whatever the event's own
// visibility: outsideClosedCircleSql names them, and every rule below (and the list predicates) leaves them out unless
// they hold another tie to the event (host, co-host, invitee, a place, the pod's own members). Admins see everything.

import {
  ADMISSION_MODES, ErrorCodes, UserRole, hasRoleAtLeast, isEventVisibility,
  type AdmissionMode, type AdmittedVia, type EffectiveAdmission,
  type EventAccessMode, type EventJoinRequestStatus, type EventPublication, type EventVisibility,
} from '@rsn/shared';
import { query } from '../../db';
import { AppError } from '../../middleware/errors';
import { activeMemberSql } from '../users/active-member';
import { meetingTime } from '../meetings/meeting-time';
import { eventRoomAdmission, visibleEventSql, APPROVAL_POD_EVENT_REFUSAL, type EventRoomAdmission } from './session-access';

export { defaultEventVisibility } from '@rsn/shared';

/** A SQL placeholder such as `$2`, and a plain lower-case alias: the only things the fragments below accept. */
const PLACEHOLDER = /^\$[1-9][0-9]*$/;
const ALIAS = /^[a-z_][a-z0-9_]*$/;

function checked(sessionAlias: string, userParam: string): void {
  if (!ALIAS.test(sessionAlias) || !PLACEHOLDER.test(userParam)) {
    throw new AppError(500, ErrorCodes.INTERNAL_ERROR, 'An event access fragment was given something that is not an alias and a placeholder');
  }
}

// ─── SQL fragments ───────────────────────────────────────────────────────────

/**
 * Part 2 Task 2 (D1): the event aliased `sessionAlias` belongs in the default lists of the person in `viewerParam`:
 * it is not archived, and it is published or they run it (its host or a co-host). A draft is nobody else's to see;
 * an archived event is listed only when asked for (archivedEventsSql). Admins see every event and are left to the
 * caller. Every member-facing list ANDs this in (visibleEventsSql and publicEventsSql already carry it).
 */
export function eventListedForSql(sessionAlias: string, viewerParam: string): string {
  checked(sessionAlias, viewerParam);
  const s = sessionAlias;
  const u = viewerParam;
  return `(${s}.archived_at IS NULL AND (${s}.publication = 'published'
    OR ${s}.host_user_id = ${u}
    OR EXISTS (SELECT 1 FROM session_cohosts el_c WHERE el_c.session_id = ${s}.id AND el_c.user_id = ${u})))`;
}

/**
 * Part 2 Task 2: the person in `userParam` is an admin of the pod the event aliased `sessionAlias` lives in: its creator
 * or one of its active directors (the pod admin of canActAsHost). A boolean SQL expression.
 */
export function podAdminSql(sessionAlias: string, userParam: string): string {
  checked(sessionAlias, userParam);
  const s = sessionAlias;
  const u = userParam;
  return `EXISTS (SELECT 1 FROM pods pa WHERE pa.id = ${s}.pod_id AND (pa.created_by = ${u} OR EXISTS (
            SELECT 1 FROM pod_members pam WHERE pam.pod_id = pa.id AND pam.user_id = ${u}
               AND pam.role = 'director' AND pam.status = 'active')))`;
}

/**
 * Part 2 Task 2: how many places the event aliased `sessionAlias` has given to anyone but its host and co-hosts (a
 * participant row that is not removed). An integer SQL expression: unpublishing is refused once it is above 0.
 */
export function placesHeldSql(sessionAlias: string): string {
  checked(sessionAlias, '$1');
  const s = sessionAlias;
  return `(SELECT COUNT(*)::int FROM session_participants ph
            WHERE ph.session_id = ${s}.id AND ph.status <> 'removed' AND ph.user_id IS DISTINCT FROM ${s}.host_user_id
              AND NOT EXISTS (SELECT 1 FROM session_cohosts phc WHERE phc.session_id = ${s}.id AND phc.user_id = ph.user_id))`;
}

/**
 * Part 2 Task 2: the archived events the person in `viewerParam` may list on asking for them (Events, "archived"): the
 * ones they ran (host or co-host) or held a place in (a participant row that is not removed). Admins are left to the
 * caller.
 */
export function archivedEventsSql(sessionAlias: string, viewerParam: string): string {
  checked(sessionAlias, viewerParam);
  const s = sessionAlias;
  const u = viewerParam;
  return `(${s}.archived_at IS NOT NULL AND (${s}.host_user_id = ${u}
    OR EXISTS (SELECT 1 FROM session_cohosts ae_c WHERE ae_c.session_id = ${s}.id AND ae_c.user_id = ${u})
    OR EXISTS (SELECT 1 FROM session_participants ae_p WHERE ae_p.session_id = ${s}.id AND ae_p.user_id = ${u} AND ae_p.status <> 'removed')))`;
}

/**
 * The event's audience: the people it is for, who see a private event and never wait for approval. The pod's
 * active members, and (T13, L20) for an event for a whole circle the circle's members whose account is active:
 * they see it and register without joining the pod, and someone who joins the circle later is in at once.
 * Leaving the circle keeps a place already taken (that is a participant row, not the audience). The circle arm
 * needs an explicit visibility: a NULL event follows its pod alone, exactly as before, and every circle event is
 * made with one (createSession / updateSession).
 */
export function eventAudienceSql(sessionAlias: string, userParam: string): string {
  checked(sessionAlias, userParam);
  const s = sessionAlias;
  const u = userParam;
  return `(EXISTS (SELECT 1 FROM pod_members ea_m
                    WHERE ea_m.pod_id = ${s}.pod_id AND ea_m.user_id = ${u} AND ea_m.status = 'active')
           OR (${s}.circle_id IS NOT NULL AND ${s}.visibility IS NOT NULL AND EXISTS (
                SELECT 1 FROM circle_members ea_cm JOIN users ea_cu ON ea_cu.id = ea_cm.user_id
                 WHERE ea_cm.circle_id = ${s}.circle_id AND ea_cm.user_id = ${u} AND ${activeMemberSql('ea_cu')})))`;
}

/**
 * T14 (L22): the person in `userParam` is outside the closed circle that the event aliased `sessionAlias` is for: the
 * event names a circle (sessions.circle_id) whose join_policy is closed, and they are neither in it (a
 * circle_members row) nor its creator. Whether they hold another tie to the event is the rules' to add.
 */
export function outsideClosedCircleSql(sessionAlias: string, userParam: string): string {
  checked(sessionAlias, userParam);
  const s = sessionAlias;
  const u = userParam;
  return `(${s}.circle_id IS NOT NULL AND EXISTS (SELECT 1 FROM circles cc_c WHERE cc_c.id = ${s}.circle_id AND cc_c.join_policy = 'closed'
            AND cc_c.created_by <> ${u}
            AND NOT EXISTS (SELECT 1 FROM circle_members cc_m WHERE cc_m.circle_id = ${s}.circle_id AND cc_m.user_id = ${u})))`;
}

/**
 * T14 (L22), for lists: the event is hidden from this person because it is for a closed circle they are outside, and
 * they hold no other tie to it (its host, a co-host, a place that is not removed, an active member of its pod, an
 * invitee). The list predicate is ANDed with NOT this, so canSeeEvent and the lists give one answer.
 */
export function closedCircleOutsiderSql(sessionAlias: string, userParam: string): string {
  checked(sessionAlias, userParam);
  const s = sessionAlias;
  const u = userParam;
  return `(${outsideClosedCircleSql(s, u)}
    AND ${s}.host_user_id IS DISTINCT FROM ${u}
    AND NOT EXISTS (SELECT 1 FROM session_cohosts cc_h WHERE cc_h.session_id = ${s}.id AND cc_h.user_id = ${u})
    AND NOT EXISTS (SELECT 1 FROM session_participants cc_p WHERE cc_p.session_id = ${s}.id AND cc_p.user_id = ${u} AND cc_p.status <> 'removed')
    AND NOT EXISTS (SELECT 1 FROM pod_members cc_pm WHERE cc_pm.pod_id = ${s}.pod_id AND cc_pm.user_id = ${u} AND cc_pm.status = 'active')
    AND NOT ${eventInviteeSql(s, u)})`;
}

/**
 * Someone invited to the event: an invite to it for their address or accepted by them, accepted or pending and
 * not expired (a withdrawn, declined or expired invite is no invite). T2's D2 rule reads invites the same way.
 */
export function eventInviteeSql(sessionAlias: string, userParam: string): string {
  checked(sessionAlias, userParam);
  return `EXISTS (
    SELECT 1 FROM invites ei_i
     WHERE ei_i.session_id = ${sessionAlias}.id
       AND (ei_i.accepted_by_user_id = ${userParam}
            OR lower(ei_i.invitee_email) = (SELECT lower(ei_u.email) FROM users ei_u WHERE ei_u.id = ${userParam}))
       AND (ei_i.status = 'accepted'
            OR (ei_i.status = 'pending' AND (ei_i.expires_at IS NULL OR ei_i.expires_at > NOW())))
  )`;
}

// ─── Admission per event (Part 2, Task 4, 10 Nov 2026; D3) ───────────────────
// sessions.admission_mode decides who gets a place, beside who sees the event (visibility). NULL keeps every rule in
// this file exactly as it was. An entitlement is a tie the organisers gave this one person: an allowed email that is
// not revoked, a code they redeemed that is not revoked, or a personal invite (personalInviteSql). Fix round 1 (spec 04,
// "the link alone does not grant permission"): a shared or multi-use invite link is never an entitlement, and both
// address arms compare the account's verified email.

/** The person's verified address is on the event's allowed list, and not revoked. */
export function admissionListedSql(sessionAlias: string, userParam: string): string {
  checked(sessionAlias, userParam);
  return `EXISTS (
    SELECT 1 FROM event_admission_entries ad_e JOIN users ad_u ON ad_u.id = ${userParam}
     WHERE ad_e.session_id = ${sessionAlias}.id AND ad_e.email = lower(btrim(ad_u.email)) AND ad_e.revoked_at IS NULL
       AND ad_u.email_verified = TRUE
  )`;
}

/**
 * A personal invite to the event for this account: it names an address, that address is the account's verified email
 * (compared as the allowed list compares), it is single-use, and it stands (accepted, or pending and not expired). A
 * shared or multi-use invite link (no address, or max_uses above 1) never is one, whoever accepted it first.
 */
export function personalInviteSql(sessionAlias: string, userParam: string): string {
  checked(sessionAlias, userParam);
  return `EXISTS (
    SELECT 1 FROM invites ad_i JOIN users ad_iu ON ad_iu.id = ${userParam}
     WHERE ad_i.session_id = ${sessionAlias}.id
       AND ad_i.invitee_email IS NOT NULL AND lower(btrim(ad_i.invitee_email)) = lower(btrim(ad_iu.email))
       AND ad_iu.email_verified = TRUE
       AND ad_i.max_uses <= 1
       AND (ad_i.status = 'accepted' OR (ad_i.status = 'pending' AND (ad_i.expires_at IS NULL OR ad_i.expires_at > NOW())))
  )`;
}

/** The person redeemed one of the event's admission codes, and the organisers have not revoked it. */
export function admissionCodeHeldSql(sessionAlias: string, userParam: string): string {
  checked(sessionAlias, userParam);
  return `EXISTS (
    SELECT 1 FROM event_admission_codes ad_c
     WHERE ad_c.session_id = ${sessionAlias}.id AND ad_c.redeemed_by = ${userParam} AND ad_c.revoked_at IS NULL
  )`;
}

/**
 * The person holds an entitlement to the event: an allowed email, a redeemed code, or a personal invite. What an
 * invitation-only event admits (besides the people who run it), at registration and on every live-room join.
 */
export function restrictedEntitlementSql(sessionAlias: string, userParam: string): string {
  checked(sessionAlias, userParam);
  return `(${admissionListedSql(sessionAlias, userParam)}
    OR ${admissionCodeHeldSql(sessionAlias, userParam)}
    OR ${personalInviteSql(sessionAlias, userParam)})`;
}

/**
 * The list predicate: "the person in `userParam` may see the event aliased `sessionAlias`" (Events list, For
 * You's next event, a circle page). A NULL event keeps T2's legacy predicate verbatim; an explicit one follows
 * canSeeEvent. Admins see every event and are left to the caller.
 */
export function visibleEventsSql(sessionAlias: string, userParam: string): string {
  checked(sessionAlias, userParam);
  const s = sessionAlias;
  const u = userParam;
  return `(
    (${s}.visibility IS NULL AND ${visibleEventSql(s, u)})
    OR (${s}.visibility IS NOT NULL AND (
      ${s}.visibility IN ('public', 'public_with_approval')
      OR ${s}.host_user_id = ${u}
      OR EXISTS (SELECT 1 FROM session_cohosts ve2_c WHERE ve2_c.session_id = ${s}.id AND ve2_c.user_id = ${u})
      OR EXISTS (SELECT 1 FROM session_participants ve2_sp WHERE ve2_sp.session_id = ${s}.id AND ve2_sp.user_id = ${u} AND ve2_sp.status <> 'removed')
      OR ${eventAudienceSql(s, u)}
      OR ${eventInviteeSql(s, u)}
    ))
  ) AND NOT ${closedCircleOutsiderSql(s, u)}
  AND ${eventListedForSql(s, u)}`;
}

/**
 * The events listed when nobody is asking: a public pod's NULL events, and every public or approval event. Never a
 * draft and never an archived event (Part 2 Task 2): nobody is asking, so nobody runs them.
 */
export function publicEventsSql(sessionAlias: string): string {
  checked(sessionAlias, '$1');
  const s = sessionAlias;
  return `(
    (${s}.visibility IS NULL AND ${s}.pod_id IN (SELECT pe_p.id FROM pods pe_p WHERE pe_p.visibility = 'public'))
    OR ${s}.visibility IN ('public', 'public_with_approval')
  ) AND NOT (${s}.circle_id IS NOT NULL AND EXISTS (SELECT 1 FROM circles pc_c WHERE pc_c.id = ${s}.circle_id AND pc_c.join_policy = 'closed'))
  AND ${s}.archived_at IS NULL AND ${s}.publication = 'published'`;
}

// ─── The facts, in one read ──────────────────────────────────────────────────

export interface EventAccessFacts {
  visibility: EventVisibility | null;
  podId: string | null;
  podVisibility: string | null;
  isHost: boolean;
  isCohost: boolean;
  /** An active director or host of the event's pod: they see and answer requests. */
  isPodOrganiser: boolean;
  inAudience: boolean;
  isInvited: boolean;
  /** Their participant row's status, or null when they hold none. */
  participantStatus: string | null;
  /** False for a removed, suspended or banned account (and for an account that does not exist). */
  accountActive: boolean;
  myRequest: EventJoinRequestStatus | null;
  /** T14 (L22): the event is for a closed circle this person is outside (outsideClosedCircleSql). */
  outsideClosedCircle: boolean;
  /** Part 2 Task 2 (D1): a draft is seen only by the people who run it. */
  publication: EventPublication;
  /** Part 2 Task 2: it has been archived (out of the default lists; its page stays as it was). */
  archived: boolean;
  /** Part 2 Task 2: registration opens then (null: as soon as it is published). */
  registrationOpensAt: Date | null;
  /** The person's own time zone (users.timezone), so "Registration opens ..." reads in their hours; null reads UTC. */
  viewerTimezone: string | null;
  /** The person is an admin of the event's pod: its creator or an active director (canActAsHost's pod admin). */
  isPodAdmin: boolean;
  /** Places held by anyone but the event's host and co-hosts (a participant row that is not removed). */
  placesHeld: number;
  /** Part 2 Task 4: sessions.admission_mode; null keeps every rule as it was. */
  admissionMode: AdmissionMode | null;
  /** Part 2 Task 4: an allowed email, a redeemed code or a personal invite (restrictedEntitlementSql). */
  entitled: boolean;
  /** Which of the three, in that order; null when not entitled. */
  entitledVia: 'allow_list' | 'code' | 'invite' | null;
}

interface FactsRow {
  visibility: string | null;
  pod_id: string | null;
  pod_visibility: string | null;
  is_host: boolean;
  is_cohost: boolean;
  is_pod_organiser: boolean;
  in_audience: boolean;
  is_invited: boolean;
  participant_status: string | null;
  account_active: boolean;
  my_request: EventJoinRequestStatus | null;
  outside_closed_circle: boolean;
  publication?: string | null;
  archived?: boolean | null;
  registration_opens_at?: Date | string | null;
  viewer_timezone?: string | null;
  is_pod_admin?: boolean | null;
  places_held?: number | string | null;
  admission_mode?: string | null;
  admission_listed?: boolean | null;
  admission_code_held?: boolean | null;
  admission_personal_invite?: boolean | null;
}

type Reader = (text: string, params: unknown[]) => Promise<{ rows: FactsRow[] }>;

/** Everything the rules below need about one person and one event, or null when the event does not exist. */
export async function readEventAccessFacts(
  sessionId: string,
  userId: string,
  read: Reader = (text, params) => query<FactsRow>(text, params),
): Promise<EventAccessFacts | null> {
  const result = await read(
    `SELECT s.visibility, s.pod_id, p.visibility::text AS pod_visibility,
            s.host_user_id = $2 AS is_host,
            EXISTS (SELECT 1 FROM session_cohosts c WHERE c.session_id = s.id AND c.user_id = $2) AS is_cohost,
            EXISTS (SELECT 1 FROM pod_members om WHERE om.pod_id = s.pod_id AND om.user_id = $2
                      AND om.role IN ('director', 'host') AND om.status = 'active') AS is_pod_organiser,
            ${eventAudienceSql('s', '$2')} AS in_audience,
            ${eventInviteeSql('s', '$2')} AS is_invited,
            (SELECT sp.status::text FROM session_participants sp WHERE sp.session_id = s.id AND sp.user_id = $2) AS participant_status,
            COALESCE((SELECT ${activeMemberSql('u')} FROM users u WHERE u.id = $2), FALSE) AS account_active,
            (SELECT r.status FROM event_join_requests r WHERE r.session_id = s.id AND r.user_id = $2) AS my_request,
            ${outsideClosedCircleSql('s', '$2')} AS outside_closed_circle,
            s.publication, (s.archived_at IS NOT NULL) AS archived, s.registration_opens_at,
            (SELECT tz.timezone FROM users tz WHERE tz.id = $2) AS viewer_timezone,
            ${podAdminSql('s', '$2')} AS is_pod_admin,
            ${placesHeldSql('s')} AS places_held,
            s.admission_mode,
            (s.admission_mode IS NOT NULL AND ${admissionListedSql('s', '$2')}) AS admission_listed,
            (s.admission_mode IS NOT NULL AND ${admissionCodeHeldSql('s', '$2')}) AS admission_code_held,
            (s.admission_mode IS NOT NULL AND ${personalInviteSql('s', '$2')}) AS admission_personal_invite
       FROM sessions s
       LEFT JOIN pods p ON p.id = s.pod_id
      WHERE s.id = $1`,
    [sessionId, userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const admissionMode = isAdmissionMode(row.admission_mode) ? row.admission_mode : null;
  const entitledVia = !admissionMode ? null
    : row.admission_listed ? 'allow_list' : row.admission_code_held ? 'code' : row.admission_personal_invite ? 'invite' : null;
  return {
    visibility: isEventVisibility(row.visibility) ? row.visibility : null,
    podId: row.pod_id,
    podVisibility: row.pod_visibility,
    isHost: !!row.is_host,
    isCohost: !!row.is_cohost,
    isPodOrganiser: !!row.is_pod_organiser,
    inAudience: !!row.in_audience,
    isInvited: !!row.is_invited,
    participantStatus: row.participant_status,
    accountActive: !!row.account_active,
    myRequest: row.my_request,
    outsideClosedCircle: !!row.outside_closed_circle,
    // A row without these (a test's, or one read before migration 135) reads as today's event: published.
    publication: row.publication === 'draft' ? 'draft' : 'published',
    archived: !!row.archived,
    registrationOpensAt: row.registration_opens_at ? new Date(row.registration_opens_at) : null,
    viewerTimezone: row.viewer_timezone ?? null,
    isPodAdmin: !!row.is_pod_admin,
    placesHeld: Number(row.places_held ?? 0) || 0,
    admissionMode,
    entitled: entitledVia !== null,
    entitledVia,
  };
}

function isAdmissionMode(value: unknown): value is AdmissionMode {
  return typeof value === 'string' && (ADMISSION_MODES as readonly string[]).includes(value);
}

// ─── The rules ───────────────────────────────────────────────────────────────

function isAdminRole(role: string | undefined): boolean {
  return !!role && hasRoleAtLeast(role as UserRole, UserRole.ADMIN);
}

const holdsPlace = (f: EventAccessFacts) => f.participantStatus !== null && f.participantStatus !== 'removed';

/**
 * T14 (L22): the event is for a closed circle this person is outside, and nothing else ties them to it (they do not
 * run it, are not its pod's audience, not invited, hold no place). Such a person is shown and offered nothing, at
 * every visibility. Admins run every event, so never land here.
 */
function hiddenByClosedCircle(f: EventAccessFacts, role: string | undefined, viaInvite = false): boolean {
  return f.outsideClosedCircle && !runsEvent(f, role) && !f.inAudience && !f.isInvited && !viaInvite && !holdsPlace(f);
}

/** Host, co-host or admin: always sees and manages the event. */
export function runsEvent(f: EventAccessFacts, role: string | undefined): boolean {
  return f.isHost || f.isCohost || isAdminRole(role);
}

/** Who answers the event's requests: the people who run it and the pod's active directors and hosts. */
export function managesRequests(f: EventAccessFacts, role: string | undefined): boolean {
  return runsEvent(f, role) || f.isPodOrganiser;
}

/** Whether the person may see the event (its page, and the lists). A draft only to the people who run it (D1). */
export function canSeeEvent(f: EventAccessFacts, role: string | undefined): boolean {
  if (!f.accountActive) return false;
  if (runsEvent(f, role)) return true;
  if (f.publication === 'draft') return false;
  if (hiddenByClosedCircle(f, role)) return false;
  if (f.visibility === null) {
    // Today's rule (canViewSession): a place that is not removed, an active pod member, or a public pod.
    return holdsPlace(f) || f.inAudience || f.podVisibility === 'public';
  }
  if (f.visibility === 'public' || f.visibility === 'public_with_approval') return true;
  // Part 2 Task 4 fix round 1: someone an event with an admission mode has entitled (an allowed email, a redeemed code,
  // a personal invite) opens its page, or a private invitation-only event could never be registered for. Lists are
  // unchanged: such an event stays unlisted to them.
  return f.inAudience || f.isInvited || holdsPlace(f) || (f.admissionMode !== null && f.entitled);
}

/**
 * Whether the person must request a place and wait for the host: an approval event, and they are not its
 * audience, not invited, hold no place yet (someone already let in is never asked again, as T2's D2) and have no
 * approved request (fix round 1: someone approved who then unregistered registers again, never asks again).
 * Never for a NULL event: an approval pod's NULL event refuses outsiders in words instead (T2's D2).
 */
export function needsApproval(f: EventAccessFacts, role: string | undefined): boolean {
  if (f.admissionMode) return admissionNeedsApproval(f, role);
  if (f.visibility !== 'public_with_approval') return false;
  if (!f.accountActive || runsEvent(f, role) || hiddenByClosedCircle(f, role)) return false;
  return !f.inAudience && !f.isInvited && f.participantStatus === null && f.myRequest !== 'approved';
}

export type RegisterDecision =
  | { ok: true; addToPod: boolean }
  | { ok: false; status: 403 | 409; code: string; message: string };

export const EVENT_PRIVATE_SENTENCE = 'This event is private. It is for its pod\'s members and the people the host invites.';
export const EVENT_NEEDS_APPROVAL_SENTENCE = 'This event asks the host to approve each place. Request to join from the event page.';
const ACCOUNT_CLOSED_SENTENCE = 'Your account cannot join events right now.';
const PRIVATE_POD_SENTENCE = 'You must be a pod member to register for events in a private pod';
export const CLOSED_CIRCLE_EVENT_SENTENCE = 'This event is for the members of a closed circle. Ask to join the circle to take part.';
export const EVENT_ADMISSION_REQUIRED_SENTENCE =
  'This event is for invited guests. Enter the email you were invited with, or an admission code.';

/**
 * Part 2 Task 2: the refusal for someone who would take a place before the event's registration opens, or null. The
 * people who run it are never held back, nor is anyone the host invited (an invite is the host's say-so). The time
 * reads in the person's own zone and names it.
 */
export function registrationNotOpenRefusal(
  f: EventAccessFacts,
  role: string | undefined,
  options: { viaInvite?: boolean } = {},
  now: Date = new Date(),
): RegisterDecision | null {
  if (!f.registrationOpensAt || f.registrationOpensAt.getTime() <= now.getTime()) return null;
  if (runsEvent(f, role) || f.isInvited || options.viaInvite) return null;
  const t = meetingTime(f.registrationOpensAt, f.viewerTimezone);
  return {
    ok: false, status: 409, code: ErrorCodes.REGISTRATION_NOT_OPEN,
    message: `Registration for this event opens ${t.long} (${t.zone}).`,
  };
}

/**
 * Whether the person may take a place now (the event's open/closed state, capacity and their own row are
 * registerParticipant's, after this). `viaInvite`: the invite-accept path. `approvedRequest`: the host approved
 * their request. A NULL event answers today's rules (registerParticipant runs them in SQL; the matrix test holds
 * the two to the same answers). Someone who may take a place is still held back until registration opens (Part 2
 * Task 2, registrationNotOpenRefusal).
 */
export function canRegister(
  f: EventAccessFacts,
  role: string | undefined,
  options: { viaInvite?: boolean; approvedRequest?: boolean } = {},
): RegisterDecision {
  const decision = registerDecisionIgnoringOpening(f, role, options);
  if (!decision.ok) return decision;
  return registrationNotOpenRefusal(f, role, options) ?? decision;
}

function registerDecisionIgnoringOpening(
  f: EventAccessFacts,
  role: string | undefined,
  options: { viaInvite?: boolean; approvedRequest?: boolean },
): RegisterDecision {
  if (!f.accountActive) return { ok: false, status: 403, code: ErrorCodes.AUTH_FORBIDDEN, message: ACCOUNT_CLOSED_SENTENCE };
  if (isAdminRole(role)) return { ok: true, addToPod: false };
  if (hiddenByClosedCircle(f, role, !!options.viaInvite)) {
    return { ok: false, status: 403, code: ErrorCodes.EVENT_PRIVATE, message: CLOSED_CIRCLE_EVENT_SENTENCE };
  }
  const invited = f.isInvited || !!options.viaInvite;
  if (f.admissionMode) return admissionDecision(f, role, invited, !!options.approvedRequest);
  if (f.visibility === null) {
    // Today's registerParticipant: membership means an active pod member (the host of a private pod who is not
    // a member is refused, as before).
    if (f.inAudience) return { ok: true, addToPod: false };
    if (f.podVisibility === 'public') return { ok: true, addToPod: true };
    if (f.podVisibility === 'invite_only' || f.podVisibility === 'private') {
      return { ok: false, status: 403, code: ErrorCodes.AUTH_FORBIDDEN, message: PRIVATE_POD_SENTENCE };
    }
    if (f.podVisibility === 'public_with_approval') {
      const outsider = !f.isHost && !f.isCohost && !invited && f.participantStatus === null;
      if (outsider) return { ok: false, status: 403, code: ErrorCodes.AUTH_FORBIDDEN, message: APPROVAL_POD_EVENT_REFUSAL };
    }
    return { ok: true, addToPod: false };
  }
  if (runsEvent(f, role) || f.inAudience || invited || holdsPlace(f) || f.participantStatus === 'removed') {
    // A removed row goes on to registerParticipant's own check, which keeps it removed.
    return { ok: true, addToPod: false };
  }
  if (f.visibility === 'private') {
    return { ok: false, status: 403, code: ErrorCodes.EVENT_PRIVATE, message: EVENT_PRIVATE_SENTENCE };
  }
  // An approved request stays an approval: someone approved who unregistered registers again (fix round 1).
  if (f.visibility === 'public_with_approval' && !options.approvedRequest && f.myRequest !== 'approved') {
    return { ok: false, status: 403, code: ErrorCodes.EVENT_NEEDS_APPROVAL, message: EVENT_NEEDS_APPROVAL_SENTENCE };
  }
  return { ok: true, addToPod: false };
}

/**
 * What the event page offers the person: Register, Request to join, or the private notice. Someone who may register
 * once registration opens is offered Register (the register answers when it opens until then).
 */
export function eventAccessMode(f: EventAccessFacts, role: string | undefined): EventAccessMode {
  if (needsApproval(f, role)) return 'request';
  return registerDecisionIgnoringOpening(f, role, {}).ok ? 'register' : 'private';
}

/**
 * Whether opening the event page registers the person. L17, for every event, NULL included (controller ruling,
 * fix round 1): only its audience (the pod's active members) and its invitees, and its host and co-hosts, who are
 * already in. Everyone else who may register presses Register; who MAY register is canRegister's, unchanged.
 * Someone the host removed is never told it (final fix wave, 2 Nov): a kick is final, and the page's own register
 * (registersOnOpening in routes/sessions.ts) already refuses them, so the two say the same.
 */
export function autoRegisters(f: EventAccessFacts, _role: string | undefined): boolean {
  if (f.participantStatus === 'removed') return false;
  // Part 2 Task 4: an invitation-only event registers on opening only the people it was given to (and its runners);
  // its pod's audience is not admitted by membership alone.
  if (f.admissionMode === 'restricted') return f.accountActive && (f.entitled || f.isHost || f.isCohost);
  return f.accountActive && (f.inAudience || f.isInvited || f.isHost || f.isCohost);
}

/**
 * Who enters the event's live room: the one rule that already decides it (eventRoomAdmission: host, co-host,
 * admin, or a place that is not removed; a removed place is terminal). Visibility never lets anyone in: a place
 * is only ever given by registerParticipant, which holds every rule above. A closed account is refused.
 * Any earlier check (an in-person event has no room) runs before this one and is not this function's.
 */
export async function canEnterRoom(
  sessionId: string,
  userId: string,
  role: string | undefined,
): Promise<EventRoomAdmission> {
  return eventRoomAdmission(sessionId, userId, role);
}

/** The additive `access` block on GET /sessions/:id. */
export interface EventAccessSummary {
  visibility: EventVisibility | null;
  mode: EventAccessMode;
  myRequest: EventJoinRequestStatus | null;
  /** Opening the page registers them (the audience and invitees only). */
  autoRegister: boolean;
  /** They see and answer the event's requests. */
  canManageRequests: boolean;
  /** Part 2 Task 4: what decides a place (effectiveAdmission). */
  admission: EffectiveAdmission;
}

export function summariseEventAccess(f: EventAccessFacts, role: string | undefined): EventAccessSummary {
  return {
    visibility: f.visibility,
    mode: eventAccessMode(f, role),
    myRequest: f.myRequest,
    autoRegister: autoRegisters(f, role),
    canManageRequests: f.visibility !== null && managesRequests(f, role),
    admission: effectiveAdmission(f),
  };
}

// ─── Admission per event: the rules (Part 2, Task 4, 10 Nov 2026; D3) ────────

/** What decides a place: the event's own mode, else T11's member rules (its own visibility), else its pod's. */
export function effectiveAdmission(f: EventAccessFacts): EffectiveAdmission {
  if (f.admissionMode) return f.admissionMode;
  return f.visibility === null ? 'pod_rules' : 'members_only';
}

/**
 * canRegister for an event with an admission mode, after the account, admin and closed-circle checks. A removed row
 * goes on to registerParticipant's own check, which keeps it removed (a kick is final in every mode).
 *   open        any active account.
 *   approval    the people who run it, its audience, invitees, entitled people, someone already holding a place, an
 *               approved request; everyone else requests (EVENT_NEEDS_APPROVAL).
 *   restricted  the people who run it and entitled people (a personal invite counts, a shared invite link never:
 *               fix round 1, spec 04); nobody by pod or circle membership, nor by a place already held (the live room
 *               re-checks the same rule).
 */
function admissionDecision(f: EventAccessFacts, role: string | undefined, invited: boolean, approvedRequest: boolean): RegisterDecision {
  const ok: RegisterDecision = { ok: true, addToPod: false };
  if (f.participantStatus === 'removed' || runsEvent(f, role)) return ok;
  if (f.admissionMode === 'open') return ok;
  if (f.admissionMode === 'approval') {
    const direct = f.inAudience || invited || f.entitled || holdsPlace(f) || approvedRequest || f.myRequest === 'approved';
    return direct ? ok : { ok: false, status: 403, code: ErrorCodes.EVENT_NEEDS_APPROVAL, message: EVENT_NEEDS_APPROVAL_SENTENCE };
  }
  if (f.entitled) return ok;
  return { ok: false, status: 403, code: ErrorCodes.EVENT_ADMISSION_REQUIRED, message: EVENT_ADMISSION_REQUIRED_SENTENCE };
}

/** needsApproval for an event with an admission mode: only `approval`, and only for someone with no direct tie. */
function admissionNeedsApproval(f: EventAccessFacts, role: string | undefined): boolean {
  if (f.admissionMode !== 'approval') return false;
  if (!f.accountActive || runsEvent(f, role) || hiddenByClosedCircle(f, role)) return false;
  return !f.inAudience && !f.isInvited && !f.entitled && f.participantStatus === null && f.myRequest !== 'approved';
}

/**
 * What gave the place canRegister has just allowed, for session_participants.admitted_via; null on an event with no
 * admission mode (nothing is recorded there, as before). The strongest tie wins: running the event, an invite, the
 * allowed list, a code, the audience, an approval, the open door.
 */
export function admittedViaOf(
  f: EventAccessFacts,
  role: string | undefined,
  options: { viaInvite?: boolean; approvedRequest?: boolean } = {},
): AdmittedVia | null {
  if (!f.admissionMode) return null;
  if (runsEvent(f, role)) return 'admin';
  // An invitation-only event admitted them by their entitlement alone (canRegister), so that is what gave the place.
  if (f.admissionMode === 'restricted') return f.entitledVia;
  if (f.isInvited || options.viaInvite) return 'invite';
  if (f.entitledVia === 'allow_list') return 'allow_list';
  if (f.entitledVia === 'code') return 'code';
  if (f.inAudience) return 'audience';
  if (options.approvedRequest || f.myRequest === 'approved') return 'approval';
  return f.admissionMode === 'open' ? 'open' : null;
}
