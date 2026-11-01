// ─── Entities (21 Oct 2026) ──────────────────────────────────────────────────
// An Entity is an organisation people belong to or work with: a company, a fund, a university
// (Strategic Foundation, "ENTITY"). Members create their own (client feedback, 19 Oct: "Users should
// be able to create an Entity (their company) themselves") and link themselves to it with a role.
// Its creator is its first admin; its admins and platform admins edit and archive it. Entities are
// archived, never deleted, so every link survives an archive.
//
// Who sees whom. An entity's page lists its active people only, and never someone the viewer has
// blocked or who has blocked the viewer; the people count on every card counts the same people.
// A person's entities follow the person brief: blocked, closed and unknown read the same, as not found.
//
// Every write to an existing entity takes its row lock first (SELECT … FOR UPDATE), so the joins,
// leaves, edits and archives of one entity happen one after another, and a write that waited for an
// archive finds the entity gone.
//
// Claims wait for the entity's admins (30 Oct review, 7.2; L23). Saying you are part of an entity makes a
// 'pending' link: it is not listed or counted anywhere, fills no company and carries no admin rights until one
// of the entity's admins (or a platform admin) approves it. A change of role or title an active member asks
// for waits beside their link the same way. Admins decline claims and remove members; only a platform admin
// removes another admin, and nobody removes the last active admin. The links that existed before are all
// active. Every query on entity_members names the links it means (entity-links.ts).

import type { PoolClient } from 'pg';
import {
  COMPANY_ROLES, ENTITY_LIMITS, ErrorCodes,
  type CreateEntityResult, type EntityInfo, type EntityKind, type EntityList, type EntityMemberStatus,
  type EntityMembershipResult, type EntityPage, type EntityPerson, type EntityRequest, type EntityRole, type EntitySummary,
  type LeaveEntityResult, type PersonEntity,
} from '@rsn/shared';
import { query, transaction } from '../../db';
import logger from '../../config/logger';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../middleware/errors';
import * as blockService from '../block/block.service';
import { circlesOfEntity } from '../circle/circle-entities.service';
import { toPublicCardBasics } from '../user/public-card';
import { escapeLike } from '../user/user-search.service';
import { activeMemberSql } from '../users/active-member';
import { ringEntityAdmins, ringListed } from './entity-bells';
import { characterCount, normaliseName } from './entity-fields';
import { activeLinkSql, openLinkSql } from './entity-links';
import { entityPictureColumns, entityPictureUrl, type EntityPictureRow } from './entity-picture-url';

/** The most of their own entities a member's list holds. */
const MINE_MAX = 100;
/** The most people an entity's page lists; `peopleCount` still counts them all. */
const PEOPLE_MAX = 200;
/** The most entities a person's profile lists. */
const PERSON_ENTITIES_MAX = 100;
/** The most requests an admin's panel lists at once; `requestCount` still counts them all. */
const REQUESTS_MAX = 200;

export interface NewEntity {
  name: string;
  kind: EntityKind;
  /** The creator's own role in it. */
  role: EntityRole;
  title?: string | null;
  about?: string | null;
  location?: string | null;
  size?: string | null;
  website?: string | null;
}

/** What an edit changes. A field left out stays as it is; null clears it. */
export interface EntityChanges {
  name?: string;
  kind?: EntityKind;
  about?: string | null;
  location?: string | null;
  size?: string | null;
  website?: string | null;
}

// ── Errors, in words a member can read ───────────────────────────────────────

const entityNotFound = (entityId: string) => new NotFoundError('Entity', entityId, 'This entity could not be found.');
const notAnAdmin = () => new ForbiddenError("Only this entity's admins can change or archive it.");
// The person brief's rule: blocked, closed and unknown read the same.
const personNotAvailable = (userId: string) => new NotFoundError('User', userId, 'This person is not available.');
/** What an admin is told when the request they answer was answered already, withdrawn, or never made. */
export const REQUEST_ALREADY_ANSWERED = 'This request has already been answered.';
const alreadyAnswered = () => new NotFoundError('EntityRequest', undefined, REQUEST_ALREADY_ANSWERED);

/** The client offers to open or join the entity that already has the name. */
const nameTaken = (existing: { id: string; name: string }) =>
  new ConflictError(ErrorCodes.ENTITY_NAME_TAKEN, `${existing.name} is already on REASON.`, { existingId: [existing.id] });

/** A name as stored, or a 400 when it is too short or too long once its spaces are tidied (in characters). */
function checkedName(typed: string): string {
  const name = normaliseName(typed);
  if (characterCount(name) < ENTITY_LIMITS.nameMin) {
    const message = `Give the entity a name of at least ${ENTITY_LIMITS.nameMin} characters.`;
    throw new ValidationError(message, { name: [message] });
  }
  if (characterCount(name) > ENTITY_LIMITS.nameMax) {
    const message = `Keep the name to ${ENTITY_LIMITS.nameMax} characters.`;
    throw new ValidationError(message, { name: [message] });
  }
  return name;
}

/**
 * The unique index on an active entity's name refused a write: someone took the name between the
 * check and the write. Matched by the database's own code and index name.
 */
function isNameClash(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const pg = err as { code?: unknown; constraint?: unknown };
  return pg.code === '23505' && pg.constraint === 'idx_entities_active_name';
}

// ── SQL shared by several reads and writes ───────────────────────────────────

// The active entity, other than $2 when it is given, whose name matches $1 however it is cased or spaced.
const SAME_NAME = `
  SELECT id, name FROM entities
   WHERE lower(btrim(name)) = lower(btrim($1)) AND archived_at IS NULL
     AND ($2::uuid IS NULL OR id <> $2::uuid)
   LIMIT 1`;

/**
 * How many of an entity's people the viewer can see: approved links of active accounts, not blocked either way.
 * `entity` and `viewer` are SQL written here (a column and a placeholder), never anything a member typed.
 */
const visiblePeople = (entity: string, viewer: string) => `
  (SELECT count(*)::int FROM entity_members pm JOIN users pu ON pu.id = pm.user_id
    WHERE pm.entity_id = ${entity} AND ${activeLinkSql('pm')} AND ${activeMemberSql('pu')}
      AND NOT EXISTS (SELECT 1 FROM user_blocks b
                       WHERE (b.blocker_id = ${viewer} AND b.blocked_id = pm.user_id)
                          OR (b.blocker_id = pm.user_id AND b.blocked_id = ${viewer})))`;

/** Not blocked either way between the person `person` (a column) and the viewer `viewer` (a placeholder). */
const notBlockedWith = (person: string, viewer: string) => `NOT EXISTS (SELECT 1 FROM user_blocks b
  WHERE (b.blocker_id = ${viewer} AND b.blocked_id = ${person}) OR (b.blocker_id = ${person} AND b.blocked_id = ${viewer}))`;

interface SummaryRow extends EntityPictureRow {
  id: string;
  name: string;
  kind: EntityKind;
  location: string | null;
  my_role: EntityRole | null;
  my_status: EntityMemberStatus | null;
  people_count: number;
}

const toSummary = (row: SummaryRow): EntitySummary => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  location: row.location,
  peopleCount: Number(row.people_count),
  myRole: row.my_role,
  logoUrl: entityPictureUrl(row.id, 'logo', row.has_logo, row.pictures_updated_at),
  myStatus: row.my_status === 'active' || row.my_status === 'pending' ? row.my_status : null,
});

/** A person's link to an entity, as a write reads it. `is_admin` is true only on an active link. */
interface LinkRow {
  status: EntityMemberStatus;
  role: EntityRole;
  title: string | null;
  requested_role: EntityRole | null;
  requested_title: string | null;
  is_admin: boolean;
}

// Every column of a link a write needs, from entity_members aliased m; the admin flag counts only on an active link.
const LINK_COLUMNS = `m.status, m.role, m.title, m.requested_role, m.requested_title, (m.is_admin AND ${activeLinkSql('m')}) AS is_admin`;

/**
 * The entity row, locked for this transaction, or a 404 when it is missing or archived; with the viewer's link to it.
 * The lock is its own statement and the link is read in the next one (H2b item 10, 26 Oct 2026): a statement that
 * joined the link under FOR UPDATE OF e read the link as it stood before the lock was granted, so an admin action
 * queued behind the actor's own demotion went through once.
 */
async function lockEntity(
  client: PoolClient, entityId: string, viewerId: string,
): Promise<{ name: string; link: LinkRow | null; isAdmin: boolean }> {
  const locked = await client.query<{ name: string }>(
    `SELECT name FROM entities WHERE id = $1 AND archived_at IS NULL FOR UPDATE`,
    [entityId],
  );
  const row = locked.rows[0];
  if (!row) throw entityNotFound(entityId);
  // Whatever its status, so a write can say what it changes; admin rights only on an active link (L23).
  const link = await client.query<LinkRow>(
    `SELECT ${LINK_COLUMNS} FROM entity_members m WHERE m.entity_id = $1 AND m.user_id = $2`,
    [entityId, viewerId],
  );
  const mine = link.rows[0] ?? null;
  return { name: row.name, link: mine, isAdmin: mine?.is_admin === true };
}

/** As lockEntity, and a 403 unless the actor is one of its active admins or a platform admin. Answers its name. */
export async function lockForAdmin(
  client: PoolClient, entityId: string, actorId: string, actorIsPlatformAdmin: boolean,
): Promise<{ name: string }> {
  const row = await lockEntity(client, entityId, actorId);
  if (!row.isAdmin && !actorIsPlatformAdmin) throw notAnAdmin();
  return { name: row.name };
}

/** The entity moved: the list with no search shows the most recently active first. */
async function touch(client: PoolClient, entityId: string): Promise<void> {
  await client.query(`UPDATE entities SET updated_at = NOW() WHERE id = $1`, [entityId]);
}

/**
 * Creating or joining your own company (as its founder or an employee) fills your profile company
 * when it is empty or only spaces. A company you already gave is never overwritten. A claim fills it only
 * once it is approved.
 */
async function fillEmptyCompany(client: PoolClient, userId: string, entityName: string, role: EntityRole): Promise<boolean> {
  if (!COMPANY_ROLES.includes(role)) return false;
  const r = await client.query(
    `UPDATE users SET company = $2 WHERE id = $1 AND (company IS NULL OR company ~ '^[[:space:]]*$')`,
    [userId, entityName],
  );
  return (r.rowCount ?? 0) > 0;
}

/** After a refused write: the active entity that now has the name, read outside the failed transaction. */
async function holderOf(name: string, exceptId: string | null): Promise<{ id: string; name: string } | null> {
  const r = await query<{ id: string; name: string }>(SAME_NAME, [name, exceptId]);
  return r.rows[0] ?? null;
}

// ── Writes ───────────────────────────────────────────────────────────────────

/** Creates the entity and the creator's link to it, as its active admin, in one transaction. */
export async function createEntity(creatorId: string, input: NewEntity): Promise<CreateEntityResult> {
  const name = checkedName(input.name);
  try {
    const created = await transaction(async (client) => {
      const clash = await client.query<{ id: string; name: string }>(SAME_NAME, [name, null]);
      if (clash.rows[0]) throw nameTaken(clash.rows[0]);
      const entity = await client.query<{ id: string }>(
        `INSERT INTO entities (name, kind, about, location, size, website, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [name, input.kind, input.about ?? null, input.location ?? null, input.size ?? null, input.website ?? null, creatorId],
      );
      const id = entity.rows[0].id;
      await client.query(
        `INSERT INTO entity_members (entity_id, user_id, role, title, is_admin, status) VALUES ($1, $2, $3, $4, true, 'active')`,
        [id, creatorId, input.role, input.title ?? null],
      );
      const companyUpdated = await fillEmptyCompany(client, creatorId, name, input.role);
      return { id, companyUpdated };
    });
    logger.info({ entityId: created.id, creatorId, companyUpdated: created.companyUpdated }, 'Entity created');
    return created;
  } catch (err) {
    if (isNameClash(err)) {
      const holder = await holderOf(name, null);
      if (holder) throw nameTaken(holder);
    }
    throw err;
  }
}

/** An admin's (or a platform admin's) edit. Only the fields given change. */
export async function updateEntity(
  actorId: string, entityId: string, changes: EntityChanges, actorIsPlatformAdmin: boolean,
): Promise<void> {
  const name = changes.name === undefined ? undefined : checkedName(changes.name);
  try {
    await transaction(async (client) => {
      await lockForAdmin(client, entityId, actorId, actorIsPlatformAdmin);
      if (name !== undefined) {
        const clash = await client.query<{ id: string; name: string }>(SAME_NAME, [name, entityId]);
        if (clash.rows[0]) throw nameTaken(clash.rows[0]);
      }
      const sets: string[] = [];
      const params: unknown[] = [entityId];
      // Column names are written here, never taken from the request; every value is a parameter.
      const set = (column: string, value: unknown) => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };
      if (name !== undefined) set('name', name);
      if (changes.kind !== undefined) set('kind', changes.kind);
      if (changes.about !== undefined) set('about', changes.about);
      if (changes.location !== undefined) set('location', changes.location);
      if (changes.size !== undefined) set('size', changes.size);
      if (changes.website !== undefined) set('website', changes.website);
      sets.push('updated_at = NOW()');
      await client.query(`UPDATE entities SET ${sets.join(', ')} WHERE id = $1`, params);
    });
  } catch (err) {
    if (name !== undefined && isNameClash(err)) {
      const holder = await holderOf(name, entityId);
      if (holder) throw nameTaken(holder);
    }
    throw err;
  }
}

interface MembershipOutcome { name: string; ring: boolean; result: EntityMembershipResult }

/**
 * Says the member is part of the entity with a role, or changes their own role and title in it. A title left out
 * stays as it was; null clears it. Saying it never makes anyone an admin.
 *   * No link, or a declined or removed one: a claim, 'pending' until an admin answers it. Nothing is listed and no
 *     company is filled; the entity's admins are rung.
 *   * A claim still waiting: the claim is changed (the admins are rung again only for new words).
 *   * An active member: the change waits beside their link (requested_role / requested_title) and the admins are
 *     rung; sending their current role and title back withdraws it.
 *   * One of the entity's admins, or a platform admin: applied at once, as before.
 */
export async function setMyMembership(
  userId: string, entityId: string, input: { role: EntityRole; title?: string | null }, actorIsPlatformAdmin = false,
): Promise<EntityMembershipResult> {
  const outcome = await transaction<MembershipOutcome>(async (client) => {
    const { name, link, isAdmin } = await lockEntity(client, entityId, userId);
    const applyNow = isAdmin || actorIsPlatformAdmin;
    const title = input.title === undefined ? (link?.title ?? null) : input.title;
    const where = `WHERE entity_id = $1 AND user_id = $2`;

    if (link?.status === 'active') {
      if (applyNow) {
        await client.query(
          `UPDATE entity_members SET role = $3, title = $4, requested_role = NULL, requested_title = NULL, requested_at = NULL ${where}`,
          [entityId, userId, input.role, title],
        );
        await touch(client, entityId);
        const companyUpdated = await fillEmptyCompany(client, userId, name, input.role);
        return { name, ring: false, result: { joined: false, status: 'active', role: input.role, title, isAdmin, companyUpdated, pendingChange: null } };
      }
      const unchanged = input.role === link.role && title === link.title;
      if (unchanged) {
        await client.query(`UPDATE entity_members SET requested_role = NULL, requested_title = NULL, requested_at = NULL ${where}`, [entityId, userId]);
      } else {
        await client.query(
          `UPDATE entity_members SET requested_role = $3, requested_title = $4, requested_at = NOW() ${where}`,
          [entityId, userId, input.role, title],
        );
      }
      return {
        name,
        ring: !unchanged,
        result: {
          joined: false, status: 'active', role: link.role, title: link.title, isAdmin: false, companyUpdated: false,
          pendingChange: unchanged ? null : { role: input.role, title },
        },
      };
    }

    const status: EntityMemberStatus = applyNow ? 'active' : 'pending';
    if (link) {
      await client.query(
        `UPDATE entity_members SET status = $5::text, role = $3, title = $4, is_admin = false,
                requested_role = NULL, requested_title = NULL, requested_at = CASE WHEN $5::text = 'pending' THEN NOW() END
          ${where}`,
        [entityId, userId, input.role, title, status],
      );
    } else {
      await client.query(
        `INSERT INTO entity_members (entity_id, user_id, role, title, status, requested_at)
         VALUES ($1, $2, $3, $4, $5::text, CASE WHEN $5::text = 'pending' THEN NOW() END)`,
        [entityId, userId, input.role, title, status],
      );
    }
    let companyUpdated = false;
    if (status === 'active') {
      await touch(client, entityId);
      companyUpdated = await fillEmptyCompany(client, userId, name, input.role);
    }
    return {
      name,
      ring: status === 'pending',
      result: { joined: link?.status !== 'pending', status, role: input.role, title, isAdmin: false, companyUpdated, pendingChange: null },
    };
  });
  if (outcome.ring) {
    await ringEntityAdmins({ id: entityId, name: outcome.name }, userId, outcome.result.pendingChange?.role ?? outcome.result.role);
  }
  return outcome.result;
}

/**
 * The claim or change waiting from `userId`, read under the entity's lock, from an active account; a 404 in words
 * when there is none (answered already, withdrawn, or never made). Every write to the entity takes that lock first,
 * so two admins pressing at once make one decision.
 */
async function waitingRequest(client: PoolClient, entityId: string, userId: string): Promise<LinkRow> {
  const r = await client.query<LinkRow>(
    `SELECT ${LINK_COLUMNS} FROM entity_members m JOIN users u ON u.id = m.user_id
      WHERE m.entity_id = $1 AND m.user_id = $2 AND ${activeMemberSql('u')}
        AND (m.status = 'pending' OR (${activeLinkSql('m')} AND m.requested_role IS NOT NULL))`,
    [entityId, userId],
  );
  if (!r.rows[0]) throw alreadyAnswered();
  return r.rows[0];
}

/**
 * An admin (or a platform admin) approves a claim, which lists the member at once, or an active member's change,
 * which is applied. An empty company is filled as joining as a founder or an employee always did. The member is
 * rung: "You're listed at {entity}".
 */
export async function approveMember(
  actorId: string, entityId: string, userId: string, actorIsPlatformAdmin: boolean,
): Promise<{ companyUpdated: boolean }> {
  const done = await transaction(async (client) => {
    const { name } = await lockForAdmin(client, entityId, actorId, actorIsPlatformAdmin);
    const row = await waitingRequest(client, entityId, userId);
    const role = row.status === 'pending' ? row.role : (row.requested_role as EntityRole);
    const title = row.status === 'pending' ? row.title : row.requested_title;
    await client.query(
      `UPDATE entity_members SET status = 'active', role = $3, title = $4,
              requested_role = NULL, requested_title = NULL, requested_at = NULL
        WHERE entity_id = $1 AND user_id = $2`,
      [entityId, userId, role, title],
    );
    await touch(client, entityId);
    return { name, companyUpdated: await fillEmptyCompany(client, userId, name, role) };
  });
  logger.info({ entityId, userId, actorId }, 'Entity member approved');
  await ringListed({ id: entityId, name: done.name }, userId);
  return { companyUpdated: done.companyUpdated };
}

/** An admin declines a claim (the link becomes 'declined'; they may ask again) or an active member's change. No bell. */
export async function declineMember(actorId: string, entityId: string, userId: string, actorIsPlatformAdmin: boolean): Promise<void> {
  await transaction(async (client) => {
    await lockForAdmin(client, entityId, actorId, actorIsPlatformAdmin);
    const row = await waitingRequest(client, entityId, userId);
    const declined = row.status === 'pending' ? `status = 'declined', ` : '';
    await client.query(
      `UPDATE entity_members SET ${declined}requested_role = NULL, requested_title = NULL, requested_at = NULL
        WHERE entity_id = $1 AND user_id = $2`,
      [entityId, userId],
    );
  });
  logger.info({ entityId, userId, actorId }, 'Entity request declined');
}

/**
 * An admin removes an active member: they leave every list at once and lose any admin rights. An entity admin
 * removes members who are not admins; only a platform admin removes another admin; nobody removes the last active
 * admin (409), and nobody removes themselves (they leave). A removed member may ask again. No bell.
 */
export async function removeMember(actorId: string, entityId: string, userId: string, actorIsPlatformAdmin: boolean): Promise<void> {
  if (userId === actorId) throw new ValidationError('To leave this entity, use Leave.');
  await transaction(async (client) => {
    await lockForAdmin(client, entityId, actorId, actorIsPlatformAdmin);
    const r = await client.query<{ is_admin: boolean; account_active: boolean }>(
      `SELECT m.is_admin, ${activeMemberSql('u')} AS account_active
         FROM entity_members m JOIN users u ON u.id = m.user_id
        WHERE m.entity_id = $1 AND m.user_id = $2 AND ${activeLinkSql('m')}`,
      [entityId, userId],
    );
    const target = r.rows[0];
    if (!target) throw new NotFoundError('EntityMember', undefined, 'They are not listed at this entity.');
    if (target.is_admin) {
      if (!actorIsPlatformAdmin) throw new ForbiddenError('Only a platform admin can remove one of its admins.');
      const others = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM entity_members m JOIN users u ON u.id = m.user_id
          WHERE m.entity_id = $1 AND m.user_id <> $2 AND m.is_admin AND ${activeLinkSql('m')} AND ${activeMemberSql('u')}`,
        [entityId, userId],
      );
      if (target.account_active && others.rows[0].n === 0) {
        throw new ConflictError(ErrorCodes.ENTITY_LAST_ADMIN, "This is the entity's last admin, so they can't be removed.");
      }
    }
    await client.query(
      `UPDATE entity_members SET status = 'removed', is_admin = false,
              requested_role = NULL, requested_title = NULL, requested_at = NULL
        WHERE entity_id = $1 AND user_id = $2`,
      [entityId, userId],
    );
    await touch(client, entityId);
  });
  logger.info({ entityId, userId, actorId }, 'Entity member removed');
}

/**
 * Removes the member's own link, or withdraws their claim while it waits. When the last active person leaves, the
 * entity is archived with them (it frees the name); a claim still waiting does not keep it. When the last active
 * admin leaves, the longest-standing active person becomes an admin, so the entity can still be looked after.
 * A declined or removed link is not theirs to take away: it stays, and nothing changes.
 */
export async function leaveEntity(userId: string, entityId: string): Promise<LeaveEntityResult> {
  return transaction(async (client) => {
    await lockEntity(client, entityId, userId);
    const gone = await client.query<{ is_admin: boolean; status: EntityMemberStatus }>(
      `DELETE FROM entity_members m WHERE m.entity_id = $1 AND m.user_id = $2 AND ${openLinkSql('m')}
       RETURNING m.is_admin, m.status`,
      [entityId, userId],
    );
    const link = gone.rows[0];
    if (!link) return { left: false, archived: false };
    if (link.status === 'pending') return { left: true, archived: false };

    const rest = await client.query<{ people: number; active_admins: number }>(
      `SELECT count(*) FILTER (WHERE ${activeLinkSql('m')})::int AS people,
              count(*) FILTER (WHERE m.is_admin AND ${activeLinkSql('m')} AND ${activeMemberSql('u')})::int AS active_admins
         FROM entity_members m JOIN users u ON u.id = m.user_id
        WHERE m.entity_id = $1`,
      [entityId],
    );
    const { people, active_admins: activeAdmins } = rest.rows[0];
    if (people === 0) {
      await client.query(`UPDATE entities SET archived_at = NOW(), updated_at = NOW() WHERE id = $1`, [entityId]);
      logger.info({ entityId, userId }, 'Entity archived: the last person left it');
      return { left: true, archived: true };
    }
    if (link.is_admin && activeAdmins === 0) {
      await client.query(
        `UPDATE entity_members SET is_admin = true
          WHERE entity_id = $1 AND user_id = (
            SELECT m.user_id FROM entity_members m JOIN users u ON u.id = m.user_id
             WHERE m.entity_id = $1 AND ${activeLinkSql('m')} AND ${activeMemberSql('u')}
             ORDER BY m.created_at ASC, m.user_id ASC LIMIT 1)`,
        [entityId],
      );
    }
    await touch(client, entityId);
    return { left: true, archived: false };
  });
}

/** An admin's (or a platform admin's) archive. Every link stays; the name is free again. */
export async function archiveEntity(actorId: string, entityId: string, actorIsPlatformAdmin: boolean): Promise<void> {
  await transaction(async (client) => {
    await lockForAdmin(client, entityId, actorId, actorIsPlatformAdmin);
    await client.query(`UPDATE entities SET archived_at = NOW(), updated_at = NOW() WHERE id = $1`, [entityId]);
  });
  logger.info({ entityId, actorId }, 'Entity archived');
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** Holds a requested list size to 1–30; anything unusable is the full 30. */
function othersLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return ENTITY_LIMITS.othersMax;
  return Math.min(Math.max(1, Math.floor(limit)), ENTITY_LIMITS.othersMax);
}

/**
 * The viewer's own entities (listed, and claims still waiting), and others they are not linked to: a name search
 * from 2 characters on (the whole name first, then names that start with it), otherwise the most recently active.
 * An entity that declined or removed the viewer is among the others, so they can ask again.
 */
export async function listEntities(viewerId: string, opts: { q?: string; limit?: number } = {}): Promise<EntityList> {
  const limit = othersLimit(opts.limit);
  const term = (opts.q ?? '').trim().slice(0, ENTITY_LIMITS.searchMax);
  const notMine = `NOT EXISTS (SELECT 1 FROM entity_members m WHERE m.entity_id = e.id AND m.user_id = $1 AND ${openLinkSql('m')})`;
  const columns = `e.id, e.name, e.kind, e.location, ${visiblePeople('e.id', '$1')} AS people_count, ${entityPictureColumns('e')}`;
  const others = term.length >= ENTITY_LIMITS.searchMin
    ? query<SummaryRow>(
      `SELECT ${columns}, NULL::text AS my_role, NULL::text AS my_status
         FROM entities e
        WHERE e.archived_at IS NULL AND e.name ILIKE $2 AND ${notMine}
        ORDER BY (lower(btrim(e.name)) = lower($3)) DESC, (e.name ILIKE $4) DESC, lower(e.name), e.id
        LIMIT $5`,
      [viewerId, `%${escapeLike(term)}%`, term, `${escapeLike(term)}%`, limit],
    )
    : query<SummaryRow>(
      `SELECT ${columns}, NULL::text AS my_role, NULL::text AS my_status
         FROM entities e
        WHERE e.archived_at IS NULL AND ${notMine}
        ORDER BY e.updated_at DESC, e.id
        LIMIT $2`,
      [viewerId, limit],
    );
  const [mine, rest] = await Promise.all([
    query<SummaryRow>(
      `SELECT ${columns}, m.role AS my_role, m.status AS my_status
         FROM entity_members m JOIN entities e ON e.id = m.entity_id
        WHERE m.user_id = $1 AND ${openLinkSql('m')} AND e.archived_at IS NULL
        ORDER BY lower(e.name), e.id
        LIMIT ${MINE_MAX}`,
      [viewerId],
    ),
    others,
  ]);
  return { mine: mine.rows.map(toSummary), others: rest.rows.map(toSummary) };
}

interface EntityRow extends EntityPictureRow {
  id: string;
  name: string;
  kind: EntityKind;
  about: string | null;
  location: string | null;
  size: string | null;
  website: string | null;
  created_at: Date;
  updated_at: Date;
  my_role: EntityRole | null;
  my_status: EntityMemberStatus | null;
  my_admin: boolean | null;
  my_requested_role: EntityRole | null;
  my_requested_title: string | null;
  people_count: number;
}

interface PersonRow {
  id: string;
  displayName: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  jobTitle: string | null;
  company: string | null;
  location: string | null;
  entityRole: EntityRole;
  entityTitle: string | null;
  entityAdmin: boolean;
}

const toInfo = (row: EntityRow): EntityInfo => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  about: row.about,
  location: row.location,
  size: row.size,
  website: row.website,
  peopleCount: Number(row.people_count),
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  logoUrl: entityPictureUrl(row.id, 'logo', row.has_logo, row.pictures_updated_at),
  bannerUrl: entityPictureUrl(row.id, 'banner', row.has_banner, row.pictures_updated_at),
});

const toPerson = (row: PersonRow): EntityPerson => ({
  ...toPublicCardBasics(row),
  role: row.entityRole,
  title: row.entityTitle,
  isAdmin: row.entityAdmin,
});

// The columns of a person's public card and their link, from users aliased u and entity_members aliased m.
const PERSON_COLUMNS = `u.id, u.display_name AS "displayName", u.first_name AS "firstName", u.last_name AS "lastName",
  u.avatar_url AS "avatarUrl", u.job_title AS "jobTitle", u.company, u.location,
  m.role AS "entityRole", m.title AS "entityTitle", m.is_admin AS "entityAdmin"`;

interface RequestRow extends PersonRow {
  linkStatus: EntityMemberStatus;
  requestedRole: EntityRole | null;
  requestedTitle: string | null;
  requestedAt: Date | null;
  createdAt: Date;
  total: number;
}

const toRequest = (row: RequestRow): EntityRequest => {
  const change = row.linkStatus === 'active';
  return {
    ...toPublicCardBasics(row),
    kind: change ? 'change' : 'join',
    role: change ? (row.requestedRole as EntityRole) : row.entityRole,
    title: change ? row.requestedTitle : row.entityTitle,
    currentRole: change ? row.entityRole : null,
    currentTitle: change ? row.entityTitle : null,
    requestedAt: (row.requestedAt ?? row.createdAt).toISOString(),
  };
};

/** The claims and changes waiting, oldest first, from active accounts not blocked either way with the viewer. */
async function waitingRequests(entityId: string, viewerId: string): Promise<{ requests: EntityRequest[]; requestCount: number }> {
  const r = await query<RequestRow>(
    `SELECT ${PERSON_COLUMNS}, m.status AS "linkStatus", m.requested_role AS "requestedRole", m.requested_title AS "requestedTitle",
            m.requested_at AS "requestedAt", m.created_at AS "createdAt", count(*) OVER ()::int AS total
       FROM entity_members m JOIN users u ON u.id = m.user_id
      WHERE m.entity_id = $1 AND (m.status = 'pending' OR (${activeLinkSql('m')} AND m.requested_role IS NOT NULL))
        AND ${activeMemberSql('u')} AND ${notBlockedWith('m.user_id', '$2')}
      ORDER BY COALESCE(m.requested_at, m.created_at) ASC, u.id
      LIMIT ${REQUESTS_MAX}`,
    [entityId, viewerId],
  );
  return { requests: r.rows.map(toRequest), requestCount: r.rows[0]?.total ?? 0 };
}

/**
 * An entity's page: the entity, the people the viewer can see (approved links of active accounts), the circles it
 * is linked to, where the viewer's own link stands, and what the viewer may do. The people who may edit it also get
 * the requests waiting for them.
 */
export async function getEntity(viewerId: string, entityId: string, viewerIsPlatformAdmin: boolean): Promise<EntityPage> {
  // The viewer's own link is read whatever its status (it says where their claim stands); its role and admin
  // flag count only when it is active.
  const r = await query<EntityRow>(
    `SELECT e.id, e.name, e.kind, e.about, e.location, e.size, e.website, e.created_at, e.updated_at,
            my.status AS my_status, CASE WHEN ${activeLinkSql('my')} THEN my.role END AS my_role,
            (my.is_admin AND ${activeLinkSql('my')}) AS my_admin,
            my.requested_role AS my_requested_role, my.requested_title AS my_requested_title,
            ${visiblePeople('e.id', '$2')} AS people_count, ${entityPictureColumns('e')}
       FROM entities e
       LEFT JOIN entity_members my ON my.entity_id = e.id AND my.user_id = $2
      WHERE e.id = $1 AND e.archived_at IS NULL`,
    [entityId, viewerId],
  );
  const row = r.rows[0];
  if (!row) throw entityNotFound(entityId);
  const canEdit = row.my_admin === true || viewerIsPlatformAdmin;
  const [people, circles, waiting] = await Promise.all([
    // Admins first, then in the order people joined.
    query<PersonRow>(
      `SELECT ${PERSON_COLUMNS}
         FROM entity_members m JOIN users u ON u.id = m.user_id
        WHERE m.entity_id = $1 AND ${activeLinkSql('m')} AND ${activeMemberSql('u')} AND ${notBlockedWith('m.user_id', '$2')}
        ORDER BY m.is_admin DESC, m.created_at ASC, u.id
        LIMIT ${PEOPLE_MAX}`,
      [entityId, viewerId],
    ),
    circlesOfEntity(entityId, viewerId, viewerIsPlatformAdmin),
    canEdit ? waitingRequests(entityId, viewerId) : Promise.resolve(null),
  ]);
  const page: EntityPage = {
    entity: toInfo(row),
    people: people.rows.map(toPerson),
    myRole: row.my_role,
    canEdit,
    myStatus: row.my_status,
    myPendingChange: row.my_status === 'active' && row.my_requested_role
      ? { role: row.my_requested_role, title: row.my_requested_title }
      : null,
    circles,
  };
  if (waiting) {
    page.requests = waiting.requests;
    page.requestCount = waiting.requestCount;
  }
  return page;
}

interface PersonEntityRow extends EntityPictureRow {
  id: string;
  name: string;
  kind: EntityKind;
  role: EntityRole;
  title: string | null;
  status: EntityMemberStatus;
}

const toPersonEntity = (row: PersonEntityRow, withStatus: boolean): PersonEntity => {
  const entity: PersonEntity = {
    id: row.id,
    name: row.name,
    kind: row.kind,
    role: row.role,
    title: row.title,
    logoUrl: entityPictureUrl(row.id, 'logo', row.has_logo, row.pictures_updated_at),
  };
  if (withStatus) entity.status = row.status === 'pending' ? 'pending' : 'active';
  return entity;
};

/** A person's entities by name: approved links, and with `withPending` their own claims still waiting too. */
async function linksOf(userId: string, withPending: boolean): Promise<PersonEntity[]> {
  const r = await query<PersonEntityRow>(
    `SELECT e.id, e.name, e.kind, m.role, m.title, m.status, ${entityPictureColumns('e')}
       FROM entity_members m JOIN entities e ON e.id = m.entity_id
      WHERE m.user_id = $1 AND e.archived_at IS NULL AND ${withPending ? openLinkSql('m') : activeLinkSql('m')}
      ORDER BY lower(e.name), e.id
      LIMIT ${PERSON_ENTITIES_MAX}`,
    [userId],
  );
  return r.rows.map((row) => toPersonEntity(row, withPending));
}

/**
 * A person's entities with their role and title in each, by name: approved links only, so a claim still waiting is
 * on nobody's view of them. No checks: the caller has already decided the viewer may see this person (the person
 * brief, or listUserEntities).
 */
export async function entitiesOf(userId: string): Promise<PersonEntity[]> {
  return linksOf(userId, false);
}

/**
 * Another person's entities, held to the person brief's rule (approved links only); a member's own, with their
 * claims still waiting, each saying its `status`.
 */
export async function listUserEntities(viewerId: string, userId: string): Promise<PersonEntity[]> {
  if (viewerId === userId) return linksOf(userId, true);
  if (await blockService.areBlocked(viewerId, userId)) throw personNotAvailable(userId);
  const person = await query<{ status: string }>(`SELECT status FROM users WHERE id = $1`, [userId]);
  if (person.rows[0]?.status !== 'active') throw personNotAvailable(userId);
  return entitiesOf(userId);
}
