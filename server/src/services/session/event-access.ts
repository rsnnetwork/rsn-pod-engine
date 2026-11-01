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
// "The event's audience" is one fragment, eventAudienceSql: today the pod's active members. A circle event (T13)
// widens it there, so every rule here follows.

import {
  ErrorCodes, UserRole, hasRoleAtLeast, isEventVisibility,
  type EventAccessMode, type EventJoinRequestStatus, type EventVisibility,
} from '@rsn/shared';
import { query } from '../../db';
import { AppError } from '../../middleware/errors';
import { activeMemberSql } from '../users/active-member';
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
 * The event's audience: the people it is for, who see a private event and never wait for approval. Today the
 * pod's active members. T13 (circle events) adds the circle's members here.
 */
export function eventAudienceSql(sessionAlias: string, userParam: string): string {
  checked(sessionAlias, userParam);
  return `EXISTS (SELECT 1 FROM pod_members ea_m
                   WHERE ea_m.pod_id = ${sessionAlias}.pod_id AND ea_m.user_id = ${userParam} AND ea_m.status = 'active')`;
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
  )`;
}

/** The events listed when nobody is asking: a public pod's NULL events, and every public or approval event. */
export function publicEventsSql(sessionAlias: string): string {
  checked(sessionAlias, '$1');
  const s = sessionAlias;
  return `(
    (${s}.visibility IS NULL AND ${s}.pod_id IN (SELECT pe_p.id FROM pods pe_p WHERE pe_p.visibility = 'public'))
    OR ${s}.visibility IN ('public', 'public_with_approval')
  )`;
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
            (SELECT r.status FROM event_join_requests r WHERE r.session_id = s.id AND r.user_id = $2) AS my_request
       FROM sessions s
       LEFT JOIN pods p ON p.id = s.pod_id
      WHERE s.id = $1`,
    [sessionId, userId],
  );
  const row = result.rows[0];
  if (!row) return null;
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
  };
}

// ─── The rules ───────────────────────────────────────────────────────────────

function isAdminRole(role: string | undefined): boolean {
  return !!role && hasRoleAtLeast(role as UserRole, UserRole.ADMIN);
}

const holdsPlace = (f: EventAccessFacts) => f.participantStatus !== null && f.participantStatus !== 'removed';

/** Host, co-host or admin: always sees and manages the event. */
export function runsEvent(f: EventAccessFacts, role: string | undefined): boolean {
  return f.isHost || f.isCohost || isAdminRole(role);
}

/** Who answers the event's requests: the people who run it and the pod's active directors and hosts. */
export function managesRequests(f: EventAccessFacts, role: string | undefined): boolean {
  return runsEvent(f, role) || f.isPodOrganiser;
}

/** Whether the person may see the event (its page, and the lists). */
export function canSeeEvent(f: EventAccessFacts, role: string | undefined): boolean {
  if (!f.accountActive) return false;
  if (runsEvent(f, role)) return true;
  if (f.visibility === null) {
    // Today's rule (canViewSession): a place that is not removed, an active pod member, or a public pod.
    return holdsPlace(f) || f.inAudience || f.podVisibility === 'public';
  }
  if (f.visibility === 'public' || f.visibility === 'public_with_approval') return true;
  return f.inAudience || f.isInvited || holdsPlace(f);
}

/**
 * Whether the person must request a place and wait for the host: an approval event, and they are not its
 * audience, not invited, and hold no place yet (someone already let in is never asked again, as T2's D2).
 * Never for a NULL event: an approval pod's NULL event refuses outsiders in words instead (T2's D2).
 */
export function needsApproval(f: EventAccessFacts, role: string | undefined): boolean {
  if (f.visibility !== 'public_with_approval') return false;
  if (!f.accountActive || runsEvent(f, role)) return false;
  return !f.inAudience && !f.isInvited && f.participantStatus === null;
}

export type RegisterDecision =
  | { ok: true; addToPod: boolean }
  | { ok: false; status: 403; code: string; message: string };

export const EVENT_PRIVATE_SENTENCE = 'This event is private. It is for its pod\'s members and the people the host invites.';
export const EVENT_NEEDS_APPROVAL_SENTENCE = 'This event asks the host to approve each place. Request to join from the event page.';
const ACCOUNT_CLOSED_SENTENCE = 'Your account cannot join events right now.';
const PRIVATE_POD_SENTENCE = 'You must be a pod member to register for events in a private pod';

/**
 * Whether the person may take a place now (the event's open/closed state, capacity and their own row are
 * registerParticipant's, after this). `viaInvite`: the invite-accept path. `approvedRequest`: the host approved
 * their request. A NULL event answers today's rules (registerParticipant runs them in SQL; the matrix test holds
 * the two to the same answers).
 */
export function canRegister(
  f: EventAccessFacts,
  role: string | undefined,
  options: { viaInvite?: boolean; approvedRequest?: boolean } = {},
): RegisterDecision {
  if (!f.accountActive) return { ok: false, status: 403, code: ErrorCodes.AUTH_FORBIDDEN, message: ACCOUNT_CLOSED_SENTENCE };
  if (isAdminRole(role)) return { ok: true, addToPod: false };
  const invited = f.isInvited || !!options.viaInvite;
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
  if (f.visibility === 'public_with_approval' && !options.approvedRequest) {
    return { ok: false, status: 403, code: ErrorCodes.EVENT_NEEDS_APPROVAL, message: EVENT_NEEDS_APPROVAL_SENTENCE };
  }
  return { ok: true, addToPod: false };
}

/** What the event page offers the person: Register, Request to join, or the private notice. */
export function eventAccessMode(f: EventAccessFacts, role: string | undefined): EventAccessMode {
  if (needsApproval(f, role)) return 'request';
  return canRegister(f, role).ok ? 'register' : 'private';
}

/** Whether opening the event page registers the person (L17: only its audience and its invitees). */
export function autoRegisters(f: EventAccessFacts, role: string | undefined): boolean {
  if (f.visibility === null) return canRegister(f, role).ok;
  return f.accountActive && (f.inAudience || f.isInvited || runsEvent(f, role));
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
}

export function summariseEventAccess(f: EventAccessFacts, role: string | undefined): EventAccessSummary {
  return {
    visibility: f.visibility,
    mode: eventAccessMode(f, role),
    myRequest: f.myRequest,
    autoRegister: autoRegisters(f, role),
    canManageRequests: f.visibility !== null && managesRequests(f, role),
  };
}
