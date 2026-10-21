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

import type { PoolClient } from 'pg';
import {
  COMPANY_ROLES, ENTITY_LIMITS, ErrorCodes,
  type CreateEntityResult, type EntityInfo, type EntityKind, type EntityList, type EntityMembershipResult,
  type EntityPage, type EntityPerson, type EntityRole, type EntitySummary, type LeaveEntityResult, type PersonEntity,
} from '@rsn/shared';
import { query, transaction } from '../../db';
import logger from '../../config/logger';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../middleware/errors';
import * as blockService from '../block/block.service';
import { toPublicCardBasics } from '../user/public-card';
import { escapeLike } from '../user/user-search.service';
import { normaliseName } from './entity-fields';

/** The most of their own entities a member's list holds. */
const MINE_MAX = 100;
/** The most people an entity's page lists; `peopleCount` still counts them all. */
const PEOPLE_MAX = 200;
/** The most entities a person's profile lists. */
const PERSON_ENTITIES_MAX = 100;

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

/** The client offers to open or join the entity that already has the name. */
const nameTaken = (existing: { id: string; name: string }) =>
  new ConflictError(ErrorCodes.ENTITY_NAME_TAKEN, `${existing.name} is already on REASON.`, { existingId: [existing.id] });

/** A name as stored, or a 400 when it is too short or too long once its spaces are tidied. */
function checkedName(typed: string): string {
  const name = normaliseName(typed);
  if (name.length < ENTITY_LIMITS.nameMin) {
    const message = `Give the entity a name of at least ${ENTITY_LIMITS.nameMin} characters.`;
    throw new ValidationError(message, { name: [message] });
  }
  if (name.length > ENTITY_LIMITS.nameMax) {
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
 * How many of an entity's people the viewer can see: active, and not blocked either way. `entity` and
 * `viewer` are SQL written here (a column and a placeholder), never anything a member typed.
 */
const visiblePeople = (entity: string, viewer: string) => `
  (SELECT count(*)::int FROM entity_members pm JOIN users pu ON pu.id = pm.user_id
    WHERE pm.entity_id = ${entity} AND pu.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM user_blocks b
                       WHERE (b.blocker_id = ${viewer} AND b.blocked_id = pm.user_id)
                          OR (b.blocker_id = pm.user_id AND b.blocked_id = ${viewer})))`;

interface SummaryRow {
  id: string;
  name: string;
  kind: EntityKind;
  location: string | null;
  my_role: EntityRole | null;
  people_count: number;
}

const toSummary = (row: SummaryRow): EntitySummary => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  location: row.location,
  peopleCount: Number(row.people_count),
  myRole: row.my_role,
});

/** The entity row, locked for this transaction, or a 404 when it is missing or archived. */
async function lockEntity(
  client: PoolClient, entityId: string, viewerId: string,
): Promise<{ name: string; is_admin: boolean | null }> {
  const r = await client.query<{ name: string; is_admin: boolean | null }>(
    `SELECT e.name, m.is_admin
       FROM entities e
       LEFT JOIN entity_members m ON m.entity_id = e.id AND m.user_id = $2
      WHERE e.id = $1 AND e.archived_at IS NULL
      FOR UPDATE OF e`,
    [entityId, viewerId],
  );
  const row = r.rows[0];
  if (!row) throw entityNotFound(entityId);
  return row;
}

/** As lockEntity, and a 403 unless the actor is one of its admins or a platform admin. */
async function lockForAdmin(client: PoolClient, entityId: string, actorId: string, actorIsPlatformAdmin: boolean): Promise<void> {
  const row = await lockEntity(client, entityId, actorId);
  if (row.is_admin !== true && !actorIsPlatformAdmin) throw notAnAdmin();
}

/** The entity moved: the list with no search shows the most recently active first. */
async function touch(client: PoolClient, entityId: string): Promise<void> {
  await client.query(`UPDATE entities SET updated_at = NOW() WHERE id = $1`, [entityId]);
}

/**
 * Creating or joining your own company (as its founder or an employee) fills your profile company
 * when it is empty or only spaces. A company you already gave is never overwritten.
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

/** Creates the entity and the creator's link to it, as its admin, in one transaction. */
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
        `INSERT INTO entity_members (entity_id, user_id, role, title, is_admin) VALUES ($1, $2, $3, $4, true)`,
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

/**
 * Joins the entity with a role, or changes the member's own role and title in it. A title left out
 * stays as it was; null clears it. Joining never makes anyone an admin.
 */
export async function setMyMembership(
  userId: string, entityId: string, input: { role: EntityRole; title?: string | null },
): Promise<EntityMembershipResult> {
  return transaction(async (client) => {
    const entity = await lockEntity(client, entityId, userId);
    const link = await client.query<{ title: string | null; is_admin: boolean }>(
      `SELECT title, is_admin FROM entity_members WHERE entity_id = $1 AND user_id = $2`,
      [entityId, userId],
    );
    const before = link.rows[0];
    const title = input.title === undefined ? (before?.title ?? null) : input.title;
    if (before) {
      await client.query(
        `UPDATE entity_members SET role = $3, title = $4 WHERE entity_id = $1 AND user_id = $2`,
        [entityId, userId, input.role, title],
      );
    } else {
      await client.query(
        `INSERT INTO entity_members (entity_id, user_id, role, title) VALUES ($1, $2, $3, $4)`,
        [entityId, userId, input.role, title],
      );
    }
    await touch(client, entityId);
    const companyUpdated = await fillEmptyCompany(client, userId, entity.name, input.role);
    return { joined: !before, role: input.role, title, isAdmin: before?.is_admin ?? false, companyUpdated };
  });
}

/**
 * Removes the member's own link. When the last person leaves, the entity is archived with them (it
 * frees the name). When the last active admin leaves, the longest-standing active person becomes an
 * admin, so the entity can still be looked after.
 */
export async function leaveEntity(userId: string, entityId: string): Promise<LeaveEntityResult> {
  return transaction(async (client) => {
    await lockEntity(client, entityId, userId);
    const gone = await client.query<{ is_admin: boolean }>(
      `DELETE FROM entity_members WHERE entity_id = $1 AND user_id = $2 RETURNING is_admin`,
      [entityId, userId],
    );
    const link = gone.rows[0];
    if (!link) return { left: false, archived: false };

    const rest = await client.query<{ people: number; active_admins: number }>(
      `SELECT count(*)::int AS people,
              count(*) FILTER (WHERE m.is_admin AND u.status = 'active')::int AS active_admins
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
             WHERE m.entity_id = $1 AND u.status = 'active'
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
 * The viewer's own entities, and others they are not linked to: a name search from 2 characters on
 * (the whole name first, then names that start with it), otherwise the most recently active.
 */
export async function listEntities(viewerId: string, opts: { q?: string; limit?: number } = {}): Promise<EntityList> {
  const limit = othersLimit(opts.limit);
  const term = (opts.q ?? '').trim().slice(0, ENTITY_LIMITS.searchMax);
  const notMine = `NOT EXISTS (SELECT 1 FROM entity_members m WHERE m.entity_id = e.id AND m.user_id = $1)`;
  const others = term.length >= ENTITY_LIMITS.searchMin
    ? query<SummaryRow>(
      `SELECT e.id, e.name, e.kind, e.location, NULL::text AS my_role, ${visiblePeople('e.id', '$1')} AS people_count
         FROM entities e
        WHERE e.archived_at IS NULL AND e.name ILIKE $2 AND ${notMine}
        ORDER BY (lower(btrim(e.name)) = lower($3)) DESC, (e.name ILIKE $4) DESC, lower(e.name), e.id
        LIMIT $5`,
      [viewerId, `%${escapeLike(term)}%`, term, `${escapeLike(term)}%`, limit],
    )
    : query<SummaryRow>(
      `SELECT e.id, e.name, e.kind, e.location, NULL::text AS my_role, ${visiblePeople('e.id', '$1')} AS people_count
         FROM entities e
        WHERE e.archived_at IS NULL AND ${notMine}
        ORDER BY e.updated_at DESC, e.id
        LIMIT $2`,
      [viewerId, limit],
    );
  const [mine, rest] = await Promise.all([
    query<SummaryRow>(
      `SELECT e.id, e.name, e.kind, e.location, m.role AS my_role, ${visiblePeople('e.id', '$1')} AS people_count
         FROM entity_members m JOIN entities e ON e.id = m.entity_id
        WHERE m.user_id = $1 AND e.archived_at IS NULL
        ORDER BY lower(e.name), e.id
        LIMIT ${MINE_MAX}`,
      [viewerId],
    ),
    others,
  ]);
  return { mine: mine.rows.map(toSummary), others: rest.rows.map(toSummary) };
}

interface EntityRow {
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
  my_admin: boolean | null;
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
});

const toPerson = (row: PersonRow): EntityPerson => ({
  ...toPublicCardBasics(row),
  role: row.entityRole,
  title: row.entityTitle,
  isAdmin: row.entityAdmin,
});

/** An entity's page: the entity, the people the viewer can see, and what the viewer may do. */
export async function getEntity(viewerId: string, entityId: string, viewerIsPlatformAdmin: boolean): Promise<EntityPage> {
  const r = await query<EntityRow>(
    `SELECT e.id, e.name, e.kind, e.about, e.location, e.size, e.website, e.created_at, e.updated_at,
            my.role AS my_role, my.is_admin AS my_admin, ${visiblePeople('e.id', '$2')} AS people_count
       FROM entities e
       LEFT JOIN entity_members my ON my.entity_id = e.id AND my.user_id = $2
      WHERE e.id = $1 AND e.archived_at IS NULL`,
    [entityId, viewerId],
  );
  const row = r.rows[0];
  if (!row) throw entityNotFound(entityId);
  // Admins first, then in the order people joined.
  const people = await query<PersonRow>(
    `SELECT u.id, u.display_name AS "displayName", u.first_name AS "firstName", u.last_name AS "lastName",
            u.avatar_url AS "avatarUrl", u.job_title AS "jobTitle", u.company, u.location,
            m.role AS "entityRole", m.title AS "entityTitle", m.is_admin AS "entityAdmin"
       FROM entity_members m JOIN users u ON u.id = m.user_id
      WHERE m.entity_id = $1 AND u.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM user_blocks b
                         WHERE (b.blocker_id = $2 AND b.blocked_id = m.user_id)
                            OR (b.blocker_id = m.user_id AND b.blocked_id = $2))
      ORDER BY m.is_admin DESC, m.created_at ASC, u.id
      LIMIT ${PEOPLE_MAX}`,
    [entityId, viewerId],
  );
  return {
    entity: toInfo(row),
    people: people.rows.map(toPerson),
    myRole: row.my_role,
    canEdit: row.my_admin === true || viewerIsPlatformAdmin,
  };
}

/**
 * A person's active entities with their role and title in each, by name. No checks: the caller has
 * already decided the viewer may see this person (the person brief, or listUserEntities).
 */
export async function entitiesOf(userId: string): Promise<PersonEntity[]> {
  const r = await query<PersonEntity>(
    `SELECT e.id, e.name, e.kind, m.role, m.title
       FROM entity_members m JOIN entities e ON e.id = m.entity_id
      WHERE m.user_id = $1 AND e.archived_at IS NULL
      ORDER BY lower(e.name), e.id
      LIMIT ${PERSON_ENTITIES_MAX}`,
    [userId],
  );
  return r.rows;
}

/** Another person's entities, held to the person brief's rule; a member's own, as they are. */
export async function listUserEntities(viewerId: string, userId: string): Promise<PersonEntity[]> {
  if (viewerId !== userId) {
    if (await blockService.areBlocked(viewerId, userId)) throw personNotAvailable(userId);
    const person = await query<{ status: string }>(`SELECT status FROM users WHERE id = $1`, [userId]);
    if (person.rows[0]?.status !== 'active') throw personNotAvailable(userId);
  }
  return entitiesOf(userId);
}
