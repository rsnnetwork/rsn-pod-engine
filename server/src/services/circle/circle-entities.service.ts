// ─── Entities linked to circles (30 Oct review, 7.3: "An entity should be linkable to one or more Circles"; L23) ───
//
// A link says an organisation belongs with a community (circle_entities, migration 130). The people who run the
// circle link and unlink (its creator, owners and moderators, and platform admins; circle-managers.ts, L21); an
// entity's own active admins may also take their entity off a circle. Linking changes nobody's access to anything.
// Both reads skip an archived circle or entity, list at most 50, and follow L22: a closed circle the viewer is outside
// is named on the entity's page without its member count, and its own page (locked to them) names no entities.

import type { CircleEntityLink, EntityCircle, EntityKind } from '@rsn/shared';
import { ErrorCodes } from '@rsn/shared';
import { query } from '../../db';
import logger from '../../config/logger';
import { AppError, NotFoundError } from '../../middleware/errors';
import { activeMemberSql } from '../users/active-member';
import { activeLinkSql } from '../entity/entity-links';
import { entityPictureColumns, entityPictureUrl, type EntityPictureRow } from '../entity/entity-picture-url';
import { assertCircleManager, isCircleManager } from './circle-managers';

/** The most links each page lists. */
export const LINKS_SHOWN = 50;

export interface LinkActor { userId: string; role?: string }

async function liveEntity(entityId: string): Promise<void> {
  const r = await query(`SELECT 1 FROM entities WHERE id = $1 AND archived_at IS NULL`, [entityId]);
  if (r.rows.length === 0) throw new NotFoundError('Entity', entityId, 'This entity could not be found.');
}

/** Link an entity to a circle, once (a second link adds nothing). The people who run the circle only. */
export async function linkEntity(circleId: string, entityId: string, actor: LinkActor): Promise<void> {
  await assertCircleManager(circleId, actor.userId, actor.role, 'Only the people who run this circle can link an entity to it.');
  await liveEntity(entityId);
  await query(
    `INSERT INTO circle_entities (circle_id, entity_id, created_by) VALUES ($1, $2, $3)
     ON CONFLICT (circle_id, entity_id) DO NOTHING`,
    [circleId, entityId, actor.userId],
  );
  logger.info({ circleId, entityId, actorId: actor.userId }, 'Entity linked to circle');
}

/** Whether this person is one of the entity's active admins (whose account is active). */
async function isEntityAdmin(entityId: string, userId: string): Promise<boolean> {
  const r = await query(
    `SELECT 1 FROM entity_members m JOIN users u ON u.id = m.user_id
      WHERE m.entity_id = $1 AND m.user_id = $2 AND m.is_admin AND ${activeLinkSql('m')} AND ${activeMemberSql('u')}`,
    [entityId, userId],
  );
  return r.rows.length > 0;
}

/**
 * Take an entity off a circle: the people who run the circle, or the entity's own active admins. 404 for an archived
 * circle or entity (its page is gone). Answers whether a link was removed: one that was not there changes nothing.
 */
export async function unlinkEntity(circleId: string, entityId: string, actor: LinkActor): Promise<{ unlinked: boolean }> {
  const circle = await query(`SELECT 1 FROM circles WHERE id = $1 AND archived_at IS NULL`, [circleId]);
  if (circle.rows.length === 0) throw new NotFoundError('Circle', circleId);
  await liveEntity(entityId);
  const allowed = (await isCircleManager(circleId, actor.userId, actor.role)) || (await isEntityAdmin(entityId, actor.userId));
  if (!allowed) {
    throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, 'Only the people who run this circle, or the entity\'s admins, can unlink it.');
  }
  const gone = await query(`DELETE FROM circle_entities WHERE circle_id = $1 AND entity_id = $2`, [circleId, entityId]);
  const unlinked = (gone.rowCount ?? 0) > 0;
  if (unlinked) logger.info({ circleId, entityId, actorId: actor.userId }, 'Entity unlinked from circle');
  return { unlinked };
}

/** The entities on a circle's page: not archived, by name, at most 50. The caller decides the viewer may see them. */
export async function entitiesOfCircle(circleId: string): Promise<CircleEntityLink[]> {
  const r = await query<EntityPictureRow & { id: string; name: string; kind: EntityKind }>(
    `SELECT e.id, e.name, e.kind, ${entityPictureColumns('e')}
       FROM circle_entities ce JOIN entities e ON e.id = ce.entity_id
      WHERE ce.circle_id = $1 AND e.archived_at IS NULL
      ORDER BY lower(e.name), e.id
      LIMIT ${LINKS_SHOWN}`,
    [circleId],
  );
  return r.rows.map((row) => ({
    id: row.id, name: row.name, kind: row.kind, logoUrl: entityPictureUrl(row.id, 'logo', row.has_logo, row.pictures_updated_at),
  }));
}

/**
 * The circles on an entity's page: not archived, by name, at most 50. A closed circle the viewer is neither in nor
 * runs is named only (memberCount null, L22); every other circle carries its count of active members.
 */
export async function circlesOfEntity(entityId: string, viewerId: string, viewerIsPlatformAdmin: boolean): Promise<EntityCircle[]> {
  const r = await query<{ id: string; name: string; join_policy: string | null; member_count: number; locked: boolean }>(
    `SELECT c.id, c.name, c.join_policy,
            (SELECT count(*)::int FROM circle_members cm JOIN users cu ON cu.id = cm.user_id
              WHERE cm.circle_id = c.id AND ${activeMemberSql('cu')}) AS member_count,
            (c.join_policy = 'closed' AND NOT ($3::boolean OR c.created_by = $2
              OR EXISTS (SELECT 1 FROM circle_members mm WHERE mm.circle_id = c.id AND mm.user_id = $2))) AS locked
       FROM circle_entities ce JOIN circles c ON c.id = ce.circle_id
      WHERE ce.entity_id = $1 AND c.archived_at IS NULL
      ORDER BY lower(c.name), c.id
      LIMIT ${LINKS_SHOWN}`,
    [entityId, viewerId, viewerIsPlatformAdmin],
  );
  return r.rows.map((row) => ({
    id: row.id,
    name: row.name,
    memberCount: row.locked ? null : row.member_count,
    joinPolicy: row.join_policy === 'closed' ? 'closed' : 'open',
  }));
}
