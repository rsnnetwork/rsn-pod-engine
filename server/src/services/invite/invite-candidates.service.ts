// ─── Inviting from your connections: the candidates list and the batch (26 Oct 2026) ────────────────
//
// Stefan, inviting to a pod on 25 Oct: "I should be able to see all the users I'm friends with. I may have 400
// friends. I can't remember that he's called Claus." The old invite search read only event encounters, needed a
// typed name, returned 20 people, ignored blocks and sent one request per person. This is the server half of its
// replacement (the picker sheet is a client task):
//
//   listInviteCandidates  your connections, or the people in an event's pod, with where each stands against the
//                         pod or event being invited to, a page at a time, searched by name, title or company;
//   createInvitesBatch    up to 50 people in one call, one outcome each, the same person never invited twice.
//
// "Connection" has ONE definition, the one the People page lists (people/connections.service.ts); whoever may send
// an invite is decided by the same two functions createInvite asks (invite.service.ts), so the list, the batch
// and the invite itself can never disagree. Emails are resolved here and never leave: a person is picked by id.

import { query } from '../../db';
import logger from '../../config/logger';
import { ValidationError } from '../../middleware/errors';
import {
  InviteType,
  InviteBatchInput, InviteBatchOutcome, InviteBatchResult, InviteBatchResponse,
  InviteCandidate, InviteCandidatePage, InviteCandidateSource, InviteCandidateState,
} from '@rsn/shared';
import { CONNECTION_SIGNALS_SQL, pageBySince } from '../people/connections.service';
import { escapeLike } from '../user/user-search.service';
import * as invites from './invite.service';

/** Who is asking, as the route knows them. */
export interface Asker {
  userId: string;
  role?: string;
}

/** One batch invites at most this many people; the route allows that many ids. */
export const BATCH_MAX = 50;

/** A pod invite from the picker lasts a week, as the old pod invite modal made it. An event invite ends with the event. */
const POD_INVITE_HOURS = 168;

/** Emails and bells go out this many at a time, so 50 invites do not wait on 50 mail round trips one after another. */
const DELIVERY_CONCURRENCY = 10;

/** Search words beyond this are ignored, as in the member search. */
const MAX_SEARCH_WORDS = 6;

const OUTCOMES: InviteBatchOutcome[] = ['invited', 'already_member', 'already_going', 'already_invited', 'not_allowed', 'failed'];

// ─── The target: the pod or event being invited to ────────────────────────────────────────────────

type Target =
  | { kind: 'pod'; id: string; podId: string; sessionId: null }
  | { kind: 'session'; id: string; podId: string; sessionId: string };

/** Who may send an invite here, decided by the very functions createInvite asks. 403 otherwise, 404 when it does not exist. */
async function resolveTarget(asker: Asker, ids: { podId?: string; sessionId?: string }): Promise<Target> {
  const isAdmin = invites.isAdminRole(asker.role);
  if (ids.sessionId) {
    const session = await invites.assertMayInviteToSession(ids.sessionId, asker.userId, isAdmin);
    return { kind: 'session', id: session.id, podId: session.podId, sessionId: session.id };
  }
  const pod = await invites.assertMayInviteToPod(ids.podId as string, asker.userId, isAdmin);
  return { kind: 'pod', id: pod.id, podId: pod.id, sessionId: null };
}

// ─── SQL pieces ───────────────────────────────────────────────────────────────────────────────────

/** Blocked in either direction between the asker ($1) and this person. */
const BLOCKED_EITHER_WAY = (person: string) =>
  `EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = ${person}) OR (b.blocker_id = ${person} AND b.blocked_id = $1))`;

/**
 * Where a person stands against the pod or event `target` (a placeholder such as $5): a member of the pod or
 * going to the event, else the latest invite sent to their address decides. That invite is "invited" while it can
 * still be accepted (pending and not expired), "declined" when the person said no to it, and nothing otherwise: an
 * invite an organiser withdrew, or that ran out, leaves them available again. `person` names the columns holding
 * the member's id and lower-case address. The pieces are fixed text; nothing a member types reaches them.
 */
function standing(kind: 'pod' | 'session', target: string, person: { id: string; email: string }) {
  const present = kind === 'pod'
    ? `WHEN EXISTS (SELECT 1 FROM pod_members pm WHERE pm.pod_id = ${target} AND pm.user_id = ${person.id} AND pm.status = 'active') THEN 'member'`
    : `WHEN EXISTS (SELECT 1 FROM session_participants sp WHERE sp.session_id = ${target} AND sp.user_id = ${person.id} AND sp.status NOT IN ('removed', 'left')) THEN 'going'`;
  const latest = kind === 'pod'
    ? `i.type = 'pod' AND i.pod_id = ${target}`
    : `i.type = 'session' AND i.session_id = ${target}`;
  return {
    join: `LEFT JOIN LATERAL (
      SELECT i.id,
             (i.status = 'pending' AND (i.expires_at IS NULL OR i.expires_at > NOW())) AS live,
             (i.declined_at IS NOT NULL) AS declined
        FROM invites i
       WHERE ${latest} AND i.invitee_email = ${person.email}
       ORDER BY i.created_at DESC LIMIT 1
    ) li ON true`,
    state: `CASE ${present} WHEN li.live THEN 'invited' WHEN li.declined THEN 'declined' ELSE 'available' END`,
  };
}

/** Every word has to match, each against the name, the title or the company. `first` is the number of the first parameter it uses. */
function searchClause(text: string | undefined, first: number): { sql: string; params: string[] } {
  const words = (text ?? '').split(/\s+/).map((word) => word.trim()).filter(Boolean).slice(0, MAX_SEARCH_WORDS);
  if (words.length === 0) return { sql: '', params: [] };
  const each = words.map((_word, at) => {
    const p = `$${first + at}`;
    return `(u.display_name ILIKE ${p} OR u.first_name ILIKE ${p} OR u.last_name ILIKE ${p} OR u.job_title ILIKE ${p} OR u.company ILIKE ${p})`;
  });
  return { sql: `AND (${each.join(' AND ')})`, params: words.map((word) => `%${escapeLike(word)}%`) };
}

// ─── The candidates list ──────────────────────────────────────────────────────────────────────────

export interface CandidateParams {
  podId?: string;
  sessionId?: string;
  source: InviteCandidateSource;
  q?: string;
  /** The `nextBefore` of the page already shown. */
  before: string | null;
  limit: number;
}

interface CandidateRow {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  job_title: string | null;
  company: string | null;
  met?: boolean;
  since: Date;
  state: InviteCandidateState;
  latest_invite_id: string | null;
}

// $1 the asker, $2 the cursor or null, $3 how many, $4 one moment only or null, $5 the pod or event being invited
// to, then the search words. The page of people is cut first; only then is each of them looked up against the target.
function connectionsSql(kind: 'pod' | 'session', search: string): string {
  const { join, state } = standing(kind, '$5', { id: 'p.user_id', email: 'p.email' });
  return `
  WITH ${CONNECTION_SIGNALS_SQL},
  page AS (
    SELECT u.id AS user_id, LOWER(u.email) AS email, u.display_name, u.avatar_url, u.job_title, u.company, pe.met, pe.since
      FROM people pe
      JOIN users u ON u.id = pe.person_id
     WHERE u.id <> $1
       AND u.status = 'active'
       AND NOT ${BLOCKED_EITHER_WAY('u.id')}
       ${search}
       AND ($2::timestamptz IS NULL OR pe.since < $2::timestamptz)
       AND ($4::timestamptz IS NULL OR pe.since = $4::timestamptz)
     ORDER BY pe.since DESC, u.id
     LIMIT $3)
  SELECT p.user_id, p.display_name, p.avatar_url, p.job_title, p.company, p.met, p.since,
         ${state} AS state, li.id AS latest_invite_id
    FROM page p
    ${join}
   ORDER BY p.since DESC, p.user_id`;
}

// $1 the asker, $2 the cursor or null, $3 how many, $4 one moment only or null, $5 the event, $6 its pod, then the
// search words. The members come newest first by the time they joined.
function podMembersSql(search: string): string {
  const { join, state } = standing('session', '$5', { id: 'p.user_id', email: 'p.email' });
  return `
  WITH page AS (
    SELECT u.id AS user_id, LOWER(u.email) AS email, u.display_name, u.avatar_url, u.job_title, u.company,
           date_trunc('milliseconds', pm.joined_at) AS since
      FROM pod_members pm
      JOIN users u ON u.id = pm.user_id
     WHERE pm.pod_id = $6 AND pm.status = 'active'
       AND u.id <> $1
       AND u.status = 'active'
       AND NOT ${BLOCKED_EITHER_WAY('u.id')}
       ${search}
       AND ($2::timestamptz IS NULL OR date_trunc('milliseconds', pm.joined_at) < $2::timestamptz)
       AND ($4::timestamptz IS NULL OR date_trunc('milliseconds', pm.joined_at) = $4::timestamptz)
     ORDER BY date_trunc('milliseconds', pm.joined_at) DESC, u.id
     LIMIT $3)
  SELECT p.user_id, p.display_name, p.avatar_url, p.job_title, p.company, p.since,
         ${state} AS state, li.id AS latest_invite_id
    FROM page p
    ${join}
   ORDER BY p.since DESC, p.user_id`;
}

/** One person, field by field: nothing is copied across wholesale, so an address in a row can never reach the answer. */
function toCandidate(row: CandidateRow, source: InviteCandidateSource): InviteCandidate {
  const candidate: InviteCandidate = {
    userId: row.user_id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    jobTitle: row.job_title,
    company: row.company,
    how: source === 'pod' ? 'pod' : row.met ? 'met' : 'connected',
    since: row.since.toISOString(),
    state: row.state,
  };
  // The invite behind "invited" and "declined", so an organiser can remind or withdraw it. For anyone else it is history.
  if ((row.state === 'invited' || row.state === 'declined') && row.latest_invite_id) candidate.inviteId = row.latest_invite_id;
  return candidate;
}

/**
 * One page of the people an organiser can invite, newest first, each with where they stand against the target.
 * `connections` lists the asker's own connections; `pod` lists the active members of the event's pod. People who
 * are blocked either way with the asker, and accounts that are not active, are not listed. Refused (403) unless the
 * asker may send an invite here, so the list never shows who belongs to a pod the asker has no business with.
 */
export async function listInviteCandidates(asker: Asker, params: CandidateParams): Promise<InviteCandidatePage> {
  if (Boolean(params.podId) === Boolean(params.sessionId)) {
    throw new ValidationError('Name either a pod or an event to invite to');
  }
  if (params.source === 'pod' && !params.sessionId) {
    throw new ValidationError('The pod list is for inviting to an event');
  }

  const target = await resolveTarget(asker, params);

  const { rows, nextBefore } = await pageBySince<CandidateRow>(params.limit, async (count, moment) => {
    if (params.source === 'pod') {
      const search = searchClause(params.q, 7);
      const result = await query<CandidateRow>(
        podMembersSql(search.sql),
        [asker.userId, params.before, count, moment, target.id, target.podId, ...search.params],
      );
      return result.rows;
    }
    const search = searchClause(params.q, 6);
    const result = await query<CandidateRow>(
      connectionsSql(target.kind, search.sql),
      [asker.userId, params.before, count, moment, target.id, ...search.params],
    );
    return result.rows;
  });

  return { items: rows.map((row) => toCandidate(row, params.source)), nextBefore };
}

// ─── The batch ────────────────────────────────────────────────────────────────────────────────────

export type BatchSummary = InviteBatchResponse & {
  /** The pod or event the invites went to, so the route can tell the screens that show it, once. */
  target: { podId: string; sessionId: string | null };
};

interface RecipientRow {
  user_id: string;
  email: string | null;
  active: boolean;
  blocked: boolean;
  connected: boolean;
  in_pod: boolean;
  state: InviteCandidateState;
  latest_invite_id: string | null;
}

/**
 * Who each of these members is to the asker and to the target, in one question: whether the account exists and is
 * active, whether they are blocked either way with the asker, whether the asker is connected to them (the one
 * definition, from the People page), whether they belong to `allowedPodId` (an event's pod: its members may be
 * invited to its events without being a connection), and where they stand against the target.
 * $1 the asker, $2 the ids, $3 the pod whose members are allowed or null, $4 the pod or event being invited to.
 */
async function readRecipients(askerId: string, target: Target, ids: string[]): Promise<Map<string, RecipientRow>> {
  const { join, state } = standing(target.kind, '$4', { id: 'w.id', email: 'LOWER(u.email)' });
  const result = await query<RecipientRow>(
    `
  WITH wanted AS (SELECT DISTINCT unnest($2::uuid[]) AS id),
  ${CONNECTION_SIGNALS_SQL}
  SELECT w.id AS user_id, LOWER(u.email) AS email,
         (u.id IS NOT NULL AND u.status = 'active') AS active,
         ${BLOCKED_EITHER_WAY('w.id')} AS blocked,
         EXISTS (SELECT 1 FROM people pe WHERE pe.person_id = w.id) AS connected,
         ($3::uuid IS NOT NULL AND EXISTS (SELECT 1 FROM pod_members pm WHERE pm.pod_id = $3 AND pm.user_id = w.id AND pm.status = 'active')) AS in_pod,
         ${state} AS state, li.id AS latest_invite_id
    FROM wanted w
    LEFT JOIN users u ON u.id = w.id
    ${join}`,
    [askerId, ids, target.kind === 'session' ? target.podId : null, target.id],
  );
  return new Map(result.rows.map((row) => [row.user_id, row]));
}

/**
 * The members of an event's pod who can still be invited to it (not going, not invited, not declined), oldest
 * member first, for "invite everyone in the pod". At most `room` ids, and how many such members there are in all,
 * so the organiser can be told how many are left when the batch is full.
 * $1 the asker, $2 the pod, $3 the people already named, $4 how many to take, $5 the event.
 */
async function availablePodMembers(
  askerId: string,
  target: Target & { kind: 'session' },
  named: string[],
  room: number,
): Promise<{ ids: string[]; total: number }> {
  const { join, state } = standing('session', '$5', { id: 'p.user_id', email: 'p.email' });
  const result = await query<{ total: number; ids: string[] }>(
    `
  SELECT COUNT(*)::int AS total,
         COALESCE((array_agg(a.user_id ORDER BY a.rn) FILTER (WHERE a.rn <= $4)), ARRAY[]::uuid[]) AS ids
    FROM (
      SELECT p.user_id, ROW_NUMBER() OVER (ORDER BY p.joined_at, p.user_id) AS rn
        FROM (
          SELECT u.id AS user_id, LOWER(u.email) AS email, pm.joined_at
            FROM pod_members pm
            JOIN users u ON u.id = pm.user_id
           WHERE pm.pod_id = $2 AND pm.status = 'active'
             AND u.id <> $1
             AND u.status = 'active'
             AND NOT ${BLOCKED_EITHER_WAY('u.id')}
             AND NOT (u.id = ANY($3::uuid[]))
        ) p
        ${join}
       WHERE ${state} = 'available'
    ) a`,
    [askerId, target.podId, named, Math.max(0, room), target.sessionId],
  );
  return { ids: result.rows[0]?.ids ?? [], total: result.rows[0]?.total ?? 0 };
}

type Decision =
  | { userId: string; outcome: Exclude<InviteBatchOutcome, 'invited' | 'failed'>; inviteId?: string }
  | { userId: string; outcome: 'create'; email: string };

/**
 * What to do about one person. Order matters: an account that cannot be invited is not_allowed whatever else is
 * true; someone already in the pod or going to the event is told so (the organiser can see them anyway); anyone
 * the asker has no business with is not_allowed rather than having a pending invite revealed. Who counts as having
 * business with the asker: their connections, an admin's reach (any active member), and for an event the members
 * of its pod. A pod's own members are no reason to invite someone to that pod, so there they do not count.
 */
function decide(userId: string, row: RecipientRow | undefined, asker: { id: string; isAdmin: boolean; target: Target }): Decision {
  if (!row || !row.active || row.blocked || userId === asker.id || !row.email) return { userId, outcome: 'not_allowed' };
  if (row.state === 'member') return { userId, outcome: 'already_member' };
  if (row.state === 'going') return { userId, outcome: 'already_going' };
  const inEventsPod = asker.target.kind === 'session' && row.in_pod;
  if (!asker.isAdmin && !row.connected && !inEventsPod) return { userId, outcome: 'not_allowed' };
  if (row.state === 'invited') {
    return row.latest_invite_id
      ? { userId, outcome: 'already_invited', inviteId: row.latest_invite_id }
      : { userId, outcome: 'already_invited' };
  }
  return { userId, outcome: 'create', email: row.email };
}

/** The ids as asked, lower case, each once, in the order first named. */
function distinctIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.toLowerCase()))];
}

/**
 * Invites up to 50 people to a pod or an event in one call, with one outcome for each. Whether the asker may invite
 * here is decided once, for the whole request (403). Each person is then checked: an account that is not active,
 * someone blocked either way, and anyone the asker has no connection to (an admin's reach is any active member; an
 * event also reaches its pod's members) is `not_allowed`; the members and the guests already there, and those with
 * a live invite, are told so; the rest are invited. The same person is never invited twice: the same id repeated is
 * one invite, and two batches that name them at the same moment make one invite between them (the second reports
 * `already_invited`), through the lock insertPendingInvite takes. Email and bell go out as for any invite.
 */
export async function createInvitesBatch(asker: Asker, input: InviteBatchInput): Promise<BatchSummary> {
  if (input.allPodMembers && input.type !== 'session') {
    throw new ValidationError('"Everyone in the pod" is for inviting to an event');
  }
  const targetId = input.type === 'pod' ? input.podId : input.sessionId;
  if (!targetId) throw new ValidationError(input.type === 'pod' ? 'Choose the pod to invite to' : 'Choose the event to invite to');
  const named = distinctIds(input.inviteeUserIds);
  if (named.length === 0 && !input.allPodMembers) throw new ValidationError('Choose at least one person to invite');
  if (named.length > BATCH_MAX) throw new ValidationError(`Invite at most ${BATCH_MAX} people at a time`);

  const isAdmin = invites.isAdminRole(asker.role);
  const target = await resolveTarget(asker, input.type === 'pod' ? { podId: targetId } : { sessionId: targetId });

  let ids = named;
  let remaining: number | undefined;
  if (input.allPodMembers && target.kind === 'session') {
    const more = await availablePodMembers(asker.userId, target, named, BATCH_MAX - named.length);
    ids = [...named, ...more.ids];
    remaining = Math.max(0, more.total - more.ids.length);
  }

  const recipients = ids.length > 0 ? await readRecipients(asker.userId, target, ids) : new Map<string, RecipientRow>();
  const decisions = ids.map((id) => decide(id, recipients.get(id), { id: asker.userId, isAdmin, target }));

  const results = new Map<string, InviteBatchResult>();
  for (const decision of decisions) {
    if (decision.outcome !== 'create') {
      results.set(decision.userId, decision.inviteId
        ? { userId: decision.userId, outcome: decision.outcome, inviteId: decision.inviteId }
        : { userId: decision.userId, outcome: decision.outcome });
    }
  }

  const toCreate = decisions.filter((d): d is Extract<Decision, { outcome: 'create' }> => d.outcome === 'create');
  if (toCreate.length > 0) {
    // A member's daily allowance counts the invites they make here too. None left is one plain refusal for the whole
    // request; part-way through, the people it does not stretch to are reported failed.
    let left = Number.POSITIVE_INFINITY;
    if (!isAdmin) {
      const { maxPerDay, sentToday } = await invites.dailyInviteAllowance(asker.userId);
      left = maxPerDay - sentToday;
      if (left <= 0) throw invites.inviteLimitError(maxPerDay);
    }

    // Looked up before anything is written, once for the whole batch: a failure here leaves nothing half done.
    const context = await invites.buildInviteContext(
      asker.userId,
      target.kind === 'pod' ? InviteType.POD : InviteType.SESSION,
      { podId: target.kind === 'pod' ? target.podId : null, sessionId: target.sessionId },
    );

    const made: Array<{ userId: string; email: string; code: string }> = [];
    for (const decision of toCreate) {
      if (left <= 0) {
        results.set(decision.userId, { userId: decision.userId, outcome: 'failed' });
        continue;
      }
      const code = invites.generateCode();
      try {
        const inserted = await invites.insertPendingInvite({
          code,
          type: target.kind === 'pod' ? InviteType.POD : InviteType.SESSION,
          inviterId: asker.userId,
          inviteeEmail: decision.email,
          podId: target.kind === 'pod' ? target.podId : null,
          sessionId: target.sessionId,
          circleId: null,
          maxUses: 1,
          expiresAt: target.kind === 'pod' ? new Date(Date.now() + POD_INVITE_HOURS * 60 * 60 * 1000) : null,
        });
        if (inserted.duplicate) {
          // Someone else's batch (or a second tab) got there first: one invite exists, and this caller is told so.
          results.set(decision.userId, { userId: decision.userId, outcome: 'already_invited', inviteId: inserted.existingId });
          continue;
        }
        left -= 1;
        results.set(decision.userId, { userId: decision.userId, outcome: 'invited', inviteId: inserted.invite.id });
        made.push({ userId: decision.userId, email: decision.email, code });
      } catch (err) {
        logger.warn({ err, askerId: asker.userId, inviteeId: decision.userId }, 'Batch invite could not be created');
        results.set(decision.userId, { userId: decision.userId, outcome: 'failed' });
      }
    }

    for (let from = 0; from < made.length; from += DELIVERY_CONCURRENCY) {
      const group = made.slice(from, from + DELIVERY_CONCURRENCY);
      const settled = await Promise.allSettled(group.map((m) =>
        invites.deliverInvite(context, { code: m.code, inviteeEmail: m.email, inviteeUserId: m.userId })));
      settled.forEach((outcome, at) => {
        if (outcome.status === 'rejected') {
          logger.warn({ err: outcome.reason, inviteeId: group[at].userId }, 'Batch invite delivery failed (invite still created)');
        }
      });
    }
  }

  const ordered = ids.map((id) => results.get(id) as InviteBatchResult);
  const counts = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) as Record<InviteBatchOutcome, number>;
  for (const result of ordered) counts[result.outcome] += 1;

  logger.info({ askerId: asker.userId, type: input.type, targetId: target.id, counts }, 'Invite batch sent');

  const summary: BatchSummary = { results: ordered, counts, target: { podId: target.podId, sessionId: target.sessionId } };
  if (remaining !== undefined) summary.remaining = remaining;
  return summary;
}
