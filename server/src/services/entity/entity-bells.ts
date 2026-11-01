// ─── The bells of an entity's claims (30 Oct review, 7.2; L23) ───────────────────────────────────────────────────
//
// A claim, or an active member's change of role or title, rings the entity's admins with a `join_request` bell; an
// approval rings the member with an `approval` bell. Decline and removal ring nobody, as for pods. Both types are in
// the allowlist already (only migration 118 touches notifications_type_check). Each row is pushed live with
// notification:new and the person's own notifications tag, as the circle bells are (circle-join.service.ts).
// A bell never decides anything: every function here logs a failure and returns.

import { ENTITY_ROLE_LABELS, type EntityRole } from '@rsn/shared';
import { query } from '../../db';
import logger from '../../config/logger';
import { E } from '../../realtime/entities';
import { emitEntities, getRealtimeIo } from '../../realtime/emit';
import { activeMemberSql } from '../users/active-member';
import { activeLinkSql } from './entity-links';

type Bell = { type: 'join_request' | 'approval'; title: string; body: string; link: string };
type BellRow = { id: string; user_id: string; created_at: Date };

async function pushBells(rows: BellRow[], bell: Bell): Promise<void> {
  const io = getRealtimeIo();
  if (!io || rows.length === 0) return;
  try {
    for (const row of rows) {
      io.to(`user:${row.user_id}`).emit('notification:new', {
        id: row.id, type: bell.type, title: bell.title, body: bell.body, link: bell.link, isRead: false, createdAt: row.created_at,
      });
    }
    await Promise.all(rows.map((row) => emitEntities(io, [row.user_id], [E.userNotifications(row.user_id)])));
  } catch (err) {
    logger.warn({ err, type: bell.type, link: bell.link }, 'entity bell push failed (non-fatal)');
  }
}

/** "a founder", "an investor", …: the role as it reads after "they are". */
export function roleWithArticle(role: EntityRole): string {
  const label = ENTITY_ROLE_LABELS[role].toLowerCase();
  return `${/^[aeiou]/.test(label) ? 'an' : 'a'} ${label}`;
}

/** The bell's title: "{name} says they are {role} at {entity}" ("part of" for the role Other). */
export function claimBellTitle(name: string, role: EntityRole, entityName: string): string {
  return role === 'other' ? `${name} says they are part of ${entityName}` : `${name} says they are ${roleWithArticle(role)} at ${entityName}`;
}

/**
 * The people a claim rings: the entity's active admins whose accounts are active; when there are none (its only
 * admin's account was closed), the platform admins, who can still answer. Never the claimant, and never someone who
 * blocked them or whom they blocked.
 */
async function adminsToRing(entityId: string, requesterId: string): Promise<string[]> {
  const notBlocked = `NOT EXISTS (SELECT 1 FROM user_blocks b
                                   WHERE (b.blocker_id = u.id AND b.blocked_id = $2) OR (b.blocker_id = $2 AND b.blocked_id = u.id))`;
  const own = await query<{ id: string; blocked: boolean }>(
    `SELECT u.id, NOT ${notBlocked} AS blocked
       FROM entity_members m JOIN users u ON u.id = m.user_id
      WHERE m.entity_id = $1 AND m.is_admin AND ${activeLinkSql('m')} AND ${activeMemberSql('u')} AND u.id <> $2`,
    [entityId, requesterId],
  );
  if (own.rows.length > 0) return own.rows.filter((r) => !r.blocked).map((r) => r.id);
  const admins = await query<{ id: string }>(
    `SELECT u.id FROM users u
      WHERE u.role IN ('admin', 'super_admin') AND ${activeMemberSql('u')} AND u.id <> $1
        AND NOT EXISTS (SELECT 1 FROM user_blocks b
                         WHERE (b.blocker_id = u.id AND b.blocked_id = $1) OR (b.blocker_id = $1 AND b.blocked_id = u.id))`,
    [requesterId],
  );
  return admins.rows.map((r) => r.id);
}

/** A claim or a change waits: ring the people who answer it, once an hour at most for the same words. */
export async function ringEntityAdmins(entity: { id: string; name: string }, requesterId: string, role: EntityRole): Promise<void> {
  try {
    const recipients = await adminsToRing(entity.id, requesterId);
    if (recipients.length === 0) return;
    const who = await query<{ display_name: string | null }>(`SELECT display_name FROM users WHERE id = $1`, [requesterId]);
    const bell: Bell = {
      type: 'join_request',
      title: claimBellTitle(who.rows[0]?.display_name?.trim() || 'Someone', role, entity.name),
      body: 'Approve or decline it on the entity page.',
      link: `/entities/${entity.id}?requests=1`,
    };
    const rows = await query<BellRow>(
      `INSERT INTO notifications (user_id, type, title, body, link)
       SELECT r.id, 'join_request', $2, $3, $4 FROM unnest($1::uuid[]) AS r(id)
        WHERE NOT EXISTS (SELECT 1 FROM notifications n
                           WHERE n.user_id = r.id AND n.type = 'join_request' AND n.link = $4 AND n.title = $2
                             AND n.created_at > NOW() - INTERVAL '1 hour')
       RETURNING id, user_id, created_at`,
      [recipients, bell.title, bell.body, bell.link],
    );
    await pushBells(rows.rows, bell);
  } catch (err) {
    logger.warn({ err, entityId: entity.id, requesterId }, 'entity claim bell failed (non-fatal)');
  }
}

/** "You're listed at {entity}" for the member an admin approved. */
export async function ringListed(entity: { id: string; name: string }, userId: string): Promise<void> {
  try {
    const bell: Bell = { type: 'approval', title: `You're listed at ${entity.name}`, body: 'Your request was approved.', link: `/entities/${entity.id}` };
    const rows = await query<BellRow>(
      `INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1, 'approval', $2, $3, $4)
       RETURNING id, user_id, created_at`,
      [userId, bell.title, bell.body, bell.link],
    );
    await pushBells(rows.rows, bell);
  } catch (err) {
    logger.warn({ err, entityId: entity.id, userId }, 'entity approval bell failed (non-fatal)');
  }
}
