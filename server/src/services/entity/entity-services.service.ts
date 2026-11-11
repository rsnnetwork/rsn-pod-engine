// ─── What an entity offers (Shirley pilot S7, 11 Nov 2026; brief RSN 15) ─────────────────────────────────────────
// "Put services on Entity, not on Person": an entity lists services from the controlled ENTITY_SERVICE_CATEGORIES,
// each with an optional description and an optional https website. They are shown on the entity's page only; no
// person's profile carries them.
//
// Only the entity's active admins and platform admins set them (lockForAdmin: 404 for a missing or archived entity,
// 403 for anyone else). A save replaces the whole list in the order given, under the entity's row lock, so two admins
// saving at once land one after the other and the last one wins; both screens refetch on entity:<id>.

import type { PoolClient } from 'pg';
import { ENTITY_LIMITS, type EntityService, type EntityServiceCategory } from '@rsn/shared';
import { query, transaction } from '../../db';
import { ValidationError } from '../../middleware/errors';
import { characterCount, normaliseWebsite } from './entity-fields';
import { lockForAdmin } from './entity.service';

/** One service as the route hands it over: checked, trimmed, blank as null. */
export interface ServiceInput {
  category: EntityServiceCategory;
  description: string | null;
  website: string | null;
}

/** What a member is told for a website that is not a secure web address. */
export const SERVICE_WEBSITE_REFUSED = 'Enter a secure web address that starts with https://, such as https://acme.com.';

/**
 * A service's website as stored, or null when it is not one: the entity website's rules (normaliseWebsite: a real
 * host, no user name or password, no spaces, never javascript: or any scheme but http and https), and https only.
 * A bare address ("acme.com") gets https:// in front.
 */
export function normaliseServiceWebsite(typed: string): string | null {
  const address = normaliseWebsite(typed);
  if (address === null || !/^https:\/\//i.test(address) || address.length > ENTITY_LIMITS.websiteMax) return null;
  return address;
}

/** The service list's own rules, checked again here whatever the route did: the count, no category twice, the limits. */
function checkedServices(services: readonly ServiceInput[]): ServiceInput[] {
  if (services.length > ENTITY_LIMITS.servicesMax) {
    throw new ValidationError(`List at most ${ENTITY_LIMITS.servicesMax} services.`, { services: [`List at most ${ENTITY_LIMITS.servicesMax} services.`] });
  }
  const seen = new Set<string>();
  return services.map((s) => {
    if (seen.has(s.category)) {
      throw new ValidationError('Each service can be listed once.', { services: ['Each service can be listed once.'] });
    }
    seen.add(s.category);
    const description = s.description?.trim() || null;
    if (description !== null && characterCount(description) > ENTITY_LIMITS.serviceDescriptionMax) {
      const message = `Keep each description to ${ENTITY_LIMITS.serviceDescriptionMax} characters.`;
      throw new ValidationError(message, { services: [message] });
    }
    const website = s.website === null ? null : normaliseServiceWebsite(s.website);
    if (s.website !== null && website === null) throw new ValidationError(SERVICE_WEBSITE_REFUSED, { services: [SERVICE_WEBSITE_REFUSED] });
    return { category: s.category, description, website };
  });
}

interface ServiceRow { category: EntityServiceCategory; description: string | null; website: string | null }

const LIST_SQL = `SELECT category, description, website FROM entity_services
                   WHERE entity_id = $1 ORDER BY position ASC, category ASC LIMIT ${ENTITY_LIMITS.servicesMax}`;

/** An entity's services in its admins' order. The caller has already decided the entity is live and may be seen. */
export async function listEntityServices(entityId: string, client?: PoolClient): Promise<EntityService[]> {
  const r = client ? await client.query<ServiceRow>(LIST_SQL, [entityId]) : await query<ServiceRow>(LIST_SQL, [entityId]);
  return r.rows.map((row) => ({ category: row.category, description: row.description, website: row.website }));
}

/**
 * Replaces the entity's services with `services`, in that order (an empty list clears them), for one of its active
 * admins or a platform admin. One DELETE and one INSERT from arrays, whatever the count. Answers the list as saved.
 */
export async function setEntityServices(
  actorId: string, entityId: string, services: readonly ServiceInput[], actorIsPlatformAdmin: boolean,
): Promise<EntityService[]> {
  const list = checkedServices(services);
  return transaction(async (client) => {
    await lockForAdmin(client, entityId, actorId, actorIsPlatformAdmin);
    await client.query(`DELETE FROM entity_services WHERE entity_id = $1`, [entityId]);
    if (list.length > 0) {
      await client.query(
        `INSERT INTO entity_services (entity_id, category, description, website, position, created_by)
         SELECT $1, s.category, s.description, s.website, (s.ord - 1)::smallint, $2
           FROM unnest($3::text[], $4::text[], $5::text[]) WITH ORDINALITY AS s(category, description, website, ord)`,
        [entityId, actorId, list.map((s) => s.category), list.map((s) => s.description), list.map((s) => s.website)],
      );
    }
    // The entity moved: the list with no search shows the most recently active first.
    await client.query(`UPDATE entities SET updated_at = NOW() WHERE id = $1`, [entityId]);
    return listEntityServices(entityId, client);
  });
}
