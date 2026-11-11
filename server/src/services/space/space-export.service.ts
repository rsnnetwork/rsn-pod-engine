// ─── An organiser's export of their circle or pod (Shirley pilot S7, 11 Nov 2026; item 20, plan decision D6) ─────
// "Organisers should be able to export if they leave", inside privacy limits (brief, "Data ownership and
// portability"): joining a space is not consent to a member's private data leaving REASON.
//
// Who: a circle's owner and moderators; a pod's director and hosts (active rows). A platform admin who holds no such
// role is refused like anyone else: the export is the organiser's own copy, not a staff tool. A private pod someone
// may not see answers its own 404, so the route never confirms it exists; a live circle (whose name is public) answers
// 403. An archived circle stays exportable by its owner and moderators (fix round 1, controller ruling: "if they
// leave", an organiser keeps their copy); anyone else, a role-less platform admin included, gets 404, so nobody can
// confirm an archived circle exists. Its owner and moderators reach it from the Circles page's list of archived circles
// they ran (listArchivedCirclesIRan); the archived circle's own page stays closed.
//
// One transaction per file: the organiser's role row is read FOR SHARE (a role change waits until the file is
// written, so nobody demoted mid-download takes it), the data is read, and the access-log row is written. Only once
// that commits does the route send the file; a failed log write refuses the download. The log is audit_log
// (entity_type 'circle' or 'pod', action 'space.export_downloaded', details { section, rows, role }), written here
// with the transaction's own client and never through recordAudit, which swallows failures.

import type { PoolClient } from 'pg';
import type { ArchivedCircleRun, SpaceExportSection, SpaceKind } from '@rsn/shared';
import { query, transaction } from '../../db';
import { ForbiddenError, NotFoundError, ValidationError } from '../../middleware/errors';
import { canViewPod } from '../pods/pod-access';
import { placesHeldSql, visibleEventsSql } from '../session/event-access';
import { activeMemberSql } from '../users/active-member';
import {
  eventRows, exportFile, memberRows, postRows, spaceRows,
  type EventRow, type MemberRow, type PostRow, type SpaceDetails, type SpaceExportFile,
} from './space-export-csv';

/** The action every download is logged under. */
export const SPACE_EXPORT_ACTION = 'space.export_downloaded';

/** The most rows one file holds; a space beyond it is refused in words rather than cut short without saying so. */
export const EXPORT_LIMITS = { members: 20_000, events: 5_000, posts: 5_000 } as const;

export const CIRCLE_EXPORT_REFUSED = "Only the circle's owner and moderators can export its data.";
export const POD_EXPORT_REFUSED = "Only the pod's director and hosts can export its data.";

const notFound = (kind: SpaceKind, id: string) => (kind === 'circle'
  ? new NotFoundError('Circle', id, "We couldn't find that circle.")
  : new NotFoundError('Pod', id, "We couldn't find that pod."));

const EXPORTER_ROLES: Record<SpaceKind, readonly string[]> = { circle: ['owner', 'moderator'], pod: ['director', 'host'] };

export interface Exporter { userId: string; role: string }

interface LockedSpace { kind: SpaceKind; id: string; role: string; archived: boolean }

/** The name a member goes by in a file: their display name, else their first and last name. */
const NAME_SQL = (u: string) => `COALESCE(NULLIF(btrim(${u}.display_name), ''), NULLIF(btrim(concat_ws(' ', ${u}.first_name, ${u}.last_name)), ''), 'A member')`;

/** Not blocked either way between the person `person` (a column) and the exporter ($2). Blocks always win. */
const NOT_BLOCKED = (person: string) => `NOT EXISTS (SELECT 1 FROM user_blocks b
  WHERE (b.blocker_id = $2 AND b.blocked_id = ${person}) OR (b.blocker_id = ${person} AND b.blocked_id = $2))`;

/**
 * 404 for a missing space; 403 unless the exporter holds an organiser's role in it now, except an archived circle,
 * which answers 404 to anyone without one (its existence is not confirmed).
 */
async function lockExporter(client: PoolClient, kind: SpaceKind, spaceId: string, userId: string): Promise<LockedSpace> {
  const space = kind === 'circle'
    ? await client.query<{ archived: boolean }>(`SELECT (archived_at IS NOT NULL) AS archived FROM circles WHERE id = $1`, [spaceId])
    : await client.query<{ archived: boolean }>(`SELECT (status::text = 'archived') AS archived FROM pods WHERE id = $1`, [spaceId]);
  if (space.rows.length === 0) throw notFound(kind, spaceId);
  const archived = space.rows[0].archived === true;
  const role = kind === 'circle'
    ? await client.query<{ role: string }>(
      `SELECT role FROM circle_members WHERE circle_id = $1 AND user_id = $2 FOR SHARE`, [spaceId, userId])
    : await client.query<{ role: string }>(
      `SELECT role::text AS role FROM pod_members WHERE pod_id = $1 AND user_id = $2 AND status = 'active' FOR SHARE`, [spaceId, userId]);
  const held = role.rows[0]?.role;
  if (!held || !EXPORTER_ROLES[kind].includes(held)) {
    if (kind === 'circle' && archived) throw notFound(kind, spaceId);
    throw new ForbiddenError(kind === 'circle' ? CIRCLE_EXPORT_REFUSED : POD_EXPORT_REFUSED);
  }
  return { kind, id: spaceId, role: held, archived };
}

/** More rows than one file holds: said in words, never a file cut short without saying so. */
function tooMany(kind: SpaceKind, what: string, max: number): never {
  throw new ValidationError(`This ${kind} has more ${what} than one file can hold (${max.toLocaleString('en-GB')}). Contact REASON support for a full copy.`);
}

async function readDetails(client: PoolClient, s: LockedSpace, userId: string): Promise<SpaceDetails> {
  if (s.kind === 'circle') {
    const r = await client.query<{ name: string; description: string | null; join_policy: string; created_at: Date; members: number; removed: number }>(
      `SELECT c.name, c.description, c.join_policy, c.created_at,
              (SELECT count(*)::int FROM circle_members m JOIN users u ON u.id = m.user_id
                WHERE m.circle_id = c.id AND ${activeMemberSql('u')}) AS members,
              (SELECT count(*)::int FROM circle_removals r WHERE r.circle_id = c.id) AS removed
         FROM circles c WHERE c.id = $1`, [s.id]);
    // A pod is named only when the exporter could see it on the circle's page: not archived, and a private one only to
    // its active members (S2's rule; an old invite-only row reads as private).
    const [pods, orgs] = await Promise.all([
      client.query<{ name: string }>(
        `SELECT p.name FROM circle_pods cp JOIN pods p ON p.id = cp.pod_id
          WHERE cp.circle_id = $1 AND p.status <> 'archived'
            AND (p.visibility::text NOT IN ('private', 'invite_only')
                 OR EXISTS (SELECT 1 FROM pod_members pm WHERE pm.pod_id = p.id AND pm.user_id = $2 AND pm.status = 'active'))
          ORDER BY cp.created_at ASC, p.id LIMIT 200`, [s.id, userId]),
      client.query<{ name: string }>(
        `SELECT e.name FROM circle_entities ce JOIN entities e ON e.id = ce.entity_id
          WHERE ce.circle_id = $1 AND e.archived_at IS NULL ORDER BY lower(e.name), e.id LIMIT 200`, [s.id]),
    ]);
    const c = r.rows[0];
    return {
      kind: 'circle', name: c.name, description: c.description, access: c.join_policy, createdAt: c.created_at, status: s.archived ? 'archived' : 'active',
      currentMembers: c.members, formerMembers: c.removed, linked: pods.rows.map((p) => p.name), organisations: orgs.rows.map((o) => o.name),
    };
  }
  const r = await client.query<{
    name: string; description: string | null; visibility: string; created_at: Date; pod_type: string | null;
    status: string; rules: string | null; members: number; former: number;
  }>(
    `SELECT p.name, p.description, p.visibility::text AS visibility, p.created_at, p.pod_type::text AS pod_type,
            p.status::text AS status, p.rules,
            (SELECT count(*)::int FROM pod_members m JOIN users u ON u.id = m.user_id
              WHERE m.pod_id = p.id AND m.status = 'active' AND ${activeMemberSql('u')}) AS members,
            (SELECT count(*)::int FROM pod_members m
              WHERE m.pod_id = p.id AND (m.status = 'left' OR (m.status = 'removed' AND m.removal_kind IS DISTINCT FROM 'rejected'))) AS former
       FROM pods p WHERE p.id = $1`, [s.id]);
  const circles = await client.query<{ name: string }>(
    `SELECT c.name FROM circle_pods cp JOIN circles c ON c.id = cp.circle_id
      WHERE cp.pod_id = $1 AND c.archived_at IS NULL ORDER BY c.name ASC, c.id LIMIT 200`, [s.id]);
  const p = r.rows[0];
  return {
    kind: 'pod', name: p.name, description: p.description, access: p.visibility, createdAt: p.created_at,
    podType: p.pod_type, status: p.status, rules: p.rules, currentMembers: p.members, formerMembers: p.former,
    linked: circles.rows.map((c) => c.name),
  };
}

/** Current members with active accounts, not blocked either way with the exporter, in the order they joined. */
async function readMembers(client: PoolClient, s: LockedSpace, userId: string): Promise<MemberRow[]> {
  const sql = s.kind === 'circle'
    ? `SELECT ${NAME_SQL('u')} AS name, m.role, m.joined_at FROM circle_members m JOIN users u ON u.id = m.user_id
        WHERE m.circle_id = $1 AND ${activeMemberSql('u')} AND ${NOT_BLOCKED('m.user_id')}
        ORDER BY m.joined_at ASC, u.id LIMIT ${EXPORT_LIMITS.members + 1}`
    : `SELECT ${NAME_SQL('u')} AS name, m.role::text AS role, m.joined_at FROM pod_members m JOIN users u ON u.id = m.user_id
        WHERE m.pod_id = $1 AND m.status = 'active' AND ${activeMemberSql('u')} AND ${NOT_BLOCKED('m.user_id')}
        ORDER BY m.joined_at ASC, u.id LIMIT ${EXPORT_LIMITS.members + 1}`;
  const r = await client.query<{ name: string; role: string; joined_at: Date }>(sql, [s.id, userId]);
  if (r.rows.length > EXPORT_LIMITS.members) tooMany(s.kind, 'members', EXPORT_LIMITS.members);
  return r.rows.map((m) => ({ name: m.name, role: m.role, joinedAt: m.joined_at }));
}

/** The space's events the exporter may see, each as counts only (who came is each event's own report). */
async function readEvents(client: PoolClient, s: LockedSpace, userId: string): Promise<EventRow[]> {
  const r = await client.query<{
    title: string; scheduled_at: Date; timezone: string | null; status: string; publication: string | null;
    event_format: string | null; config: object | null; registered: number; came: number;
  }>(
    `SELECT s.title, s.scheduled_at, s.timezone, s.status::text AS status, s.publication, s.event_format, s.config,
            ${placesHeldSql('s')} AS registered,
            (SELECT count(*)::int FROM session_participants a
              WHERE a.session_id = s.id AND a.status <> 'removed' AND a.joined_at IS NOT NULL
                AND a.user_id IS DISTINCT FROM s.host_user_id
                AND NOT EXISTS (SELECT 1 FROM session_cohosts ac WHERE ac.session_id = s.id AND ac.user_id = a.user_id)) AS came
       FROM sessions s
      WHERE s.${s.kind === 'circle' ? 'circle_id' : 'pod_id'} = $1 AND ${visibleEventsSql('s', '$2')}
      ORDER BY s.scheduled_at ASC, s.id LIMIT ${EXPORT_LIMITS.events + 1}`, [s.id, userId]);
  if (r.rows.length > EXPORT_LIMITS.events) tooMany(s.kind, 'events', EXPORT_LIMITS.events);
  return r.rows.map((e) => ({
    title: e.title, scheduledAt: e.scheduled_at, timezone: e.timezone, status: e.status, publication: e.publication,
    format: e.event_format, config: e.config, registered: e.registered, came: e.came,
  }));
}

/** The posts the exporter wrote on the space's wall and has not deleted. Nobody else's words. */
async function readPosts(client: PoolClient, s: LockedSpace, userId: string): Promise<PostRow[]> {
  const table = s.kind === 'circle' ? 'circle_posts' : 'pod_posts';
  const shared = s.kind === 'circle' ? '(p.shared_from_post_id IS NOT NULL)' : 'false';
  const r = await client.query<{
    created_at: Date; edited_at: Date | null; content: string; link_url: string | null; media_count: number;
    comment_count: number; pinned: boolean; shared: boolean;
  }>(
    `SELECT p.created_at, p.edited_at, p.content, p.link_url,
            CASE WHEN jsonb_typeof(p.media) = 'array' THEN jsonb_array_length(p.media) ELSE 0 END AS media_count,
            p.comment_count, (p.pinned_at IS NOT NULL) AS pinned, ${shared} AS shared
       FROM ${table} p
      WHERE p.${s.kind === 'circle' ? 'circle_id' : 'pod_id'} = $1 AND p.author_id = $2 AND p.deleted_at IS NULL
      ORDER BY p.created_at ASC, p.id LIMIT ${EXPORT_LIMITS.posts + 1}`, [s.id, userId]);
  if (r.rows.length > EXPORT_LIMITS.posts) tooMany(s.kind, 'posts', EXPORT_LIMITS.posts);
  return r.rows.map((p) => ({
    createdAt: p.created_at, editedAt: p.edited_at, content: p.content, linkUrl: p.link_url, mediaCount: Number(p.media_count),
    commentCount: Number(p.comment_count), pinned: p.pinned, shared: p.shared,
  }));
}

async function buildFile(client: PoolClient, s: LockedSpace, section: SpaceExportSection, userId: string, at: Date): Promise<SpaceExportFile> {
  switch (section) {
    case 'space': return exportFile(s.kind, section, spaceRows(await readDetails(client, s, userId), at), at);
    case 'members': return exportFile(s.kind, section, memberRows(await readMembers(client, s, userId)), at);
    case 'events': return exportFile(s.kind, section, eventRows(await readEvents(client, s, userId)), at);
    case 'posts': return exportFile(s.kind, section, postRows(s.kind, await readPosts(client, s, userId)), at);
  }
}

/**
 * One file of an organiser's export, logged before it is handed back. Throws 404 (no such space, an archived circle, a
 * private pod the asker may not see), 403 (no organiser's role in it), 400 (more rows than a file holds), or the
 * database's own error when the access log cannot be written: then nothing is handed back.
 */
export async function exportSpaceSection(
  kind: SpaceKind, spaceId: string, section: SpaceExportSection, exporter: Exporter, at: Date = new Date(),
): Promise<SpaceExportFile> {
  if (kind === 'pod' && !(await canViewPod(exporter.userId, spaceId, exporter.role))) throw notFound(kind, spaceId);
  return transaction(async (client) => {
    const space = await lockExporter(client, kind, spaceId, exporter.userId);
    const file = await buildFile(client, space, section, exporter.userId, at);
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details) VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [exporter.userId, SPACE_EXPORT_ACTION, kind, spaceId, JSON.stringify({ section, rows: file.rows, role: space.role })],
    );
    return file;
  });
}

/** The most archived circles the Circles page lists. */
export const ARCHIVED_RUN_MAX = 50;

/**
 * The archived circles in which the member is owner or moderator, newest archived first (Circles page, "Circles you ran
 * (archived)"). Their own pages stay closed; each opens the export sheet only. Nothing is listed for anyone else.
 */
export async function listArchivedCirclesIRan(userId: string): Promise<ArchivedCircleRun[]> {
  const r = await query<{ id: string; name: string; archived_at: Date; role: 'owner' | 'moderator' }>(
    `SELECT c.id, c.name, c.archived_at, m.role
       FROM circle_members m JOIN circles c ON c.id = m.circle_id
      WHERE m.user_id = $1 AND m.role IN ('owner', 'moderator') AND c.archived_at IS NOT NULL
      ORDER BY c.archived_at DESC, c.id LIMIT ${ARCHIVED_RUN_MAX}`,
    [userId],
  );
  return r.rows.map((c) => ({ id: c.id, name: c.name, archivedAt: new Date(c.archived_at).toISOString(), myRole: c.role }));
}
