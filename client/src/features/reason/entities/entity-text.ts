// client/src/features/reason/entities/entity-text.ts
// What the Entities pages say, and the small rules behind it. Pure on purpose (no React, axios, store, router or
// alias), so a test can run it: server/src/__tests__/client/reason-entities-text.test.ts.
import {
  ENTITY_KIND_LABELS, ENTITY_LIMITS, ENTITY_ROLE_LABELS,
  type EntityKind, type EntityRole, type ErrorCodes, type PersonEntity,
} from '@rsn/shared';
import { CONNECTION_LOST, errorMessage, memberSentence } from '../errors';
import { firstCharacter } from '../for-you/firstCharacter';
import { statusOf } from '../human/profile-text';
import { visibleText } from '../person';

// ---- words -------------------------------------------------------------------------------------

/** The Foundation's word for a kind. A kind added on the server after this build still reads as words. */
export function kindLabel(kind: string): string {
  return ENTITY_KIND_LABELS[kind as EntityKind] ?? 'Organisation';
}

/** The Foundation's word for a role. "Other" is its own word for a relation it does not list. */
export function roleLabel(role: string): string {
  return ENTITY_ROLE_LABELS[role as EntityRole] ?? 'Other';
}

export const peopleCount = (n: number) => (n === 1 ? '1 person' : `${n} people`);

/** "Company · Copenhagen": the kind, then the place when there is one. */
export function entityMeta(e: { kind: string; location: string | null }): string {
  const place = visibleText(e.location);
  return place ? `${kindLabel(e.kind)} · ${place}` : kindLabel(e.kind);
}

/** "Founder · CEO": the role, then the title at this entity when there is one. */
export function roleLine(role: string, title: string | null | undefined): string {
  const t = visibleText(title);
  return t ? `${roleLabel(role)} · ${t}` : roleLabel(role);
}

/** The letter on the dark tile that stands in for a logo. */
export const entityLetter = (name: string) => firstCharacter(name);

// ---- size and website --------------------------------------------------------------------------

/** The sizes the create form offers (the brief's list). The server stores size as free text. */
export const SIZE_OPTIONS = ['1-10', '11-50', '51-200', '201-1000', '1000+'] as const;
const isSizeOption = (s: string): boolean => (SIZE_OPTIONS as readonly string[]).includes(s);

/** "11-50 people" for one of the five; a size written some other way is shown as it was written. */
export function sizeText(size: string | null): string | null {
  const s = visibleText(size);
  if (!s) return null;
  return isSizeOption(s) ? `${s} people` : s;
}

/** The edit form's choices: the five, and the entity's own size first when it is not one of them, so saving never drops it. */
export function sizeChoices(current: string | null): string[] {
  const s = visibleText(current);
  return s && !isSizeOption(s) ? [s, ...SIZE_OPTIONS] : [...SIZE_OPTIONS];
}

/**
 * The website as a link, or null. The server only stores http and https addresses; this checks again before an href
 * is drawn, so nothing else (javascript:, data:) can ever become a link on the page.
 */
export function websiteLink(website: string | null | undefined): { href: string; text: string } | null {
  const raw = visibleText(website);
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const rest = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  return { href: url.href, text: `${url.host}${rest}` };
}

// ---- ids, names and search ---------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An entity id, in either case. Anything else (a typo, a crafted address) needs no request. */
export const isEntityId = (id: string) => UUID.test(id);

/** A name as the server stores and compares it: outer spaces off, every run of spaces inside made one. */
export const tidyName = (typed: string) => typed.replace(/\s+/g, ' ').trim();

/**
 * What the search box asks the server for. Under 2 characters the server lists the most recently active entities
 * instead, so the page asks for exactly that (one cache entry, and no "nothing found" for a single letter).
 */
export function searchTerm(typed: string): string {
  const term = tidyName(typed);
  return term.length >= ENTITY_LIMITS.searchMin ? term.slice(0, ENTITY_LIMITS.searchMax) : '';
}

/** The person brief's entities. The API answering may be older than the field (the live one, until it ships it). */
export function entitiesOf(brief: { entities?: PersonEntity[] | null }): PersonEntity[] {
  return Array.isArray(brief.entities) ? brief.entities : [];
}

// ---- what a failed request says ----------------------------------------------------------------

export const ENTITY_GONE = 'This entity could not be found. It may have been archived.';
const TRY_LATER = 'Try again in a moment.';

interface ServerAnswer { response?: { status?: number; data?: { error?: { code?: unknown; message?: unknown; details?: unknown } } } }
const errorBody = (err: unknown) => (err as ServerAnswer | null | undefined)?.response?.data?.error;

const ENTITY_NOT_FOUND: typeof ErrorCodes.ENTITY_NOT_FOUND = 'ENTITY_NOT_FOUND';

/**
 * One sentence for a failed entity request. A 404 for the entity says it is gone (errorMessage's own 404 is about a
 * person); any other 404 (an API without these routes yet, such as the live one before they ship) is the caller's
 * fallback. A 429 passes on the server's sentence when it is fit to show: the hourly create limit says more than
 * "slow down".
 */
export function entityError(err: unknown, fallback: string): string {
  const status = statusOf(err);
  if (status === 404) return errorBody(err)?.code === ENTITY_NOT_FOUND ? ENTITY_GONE : fallback;
  if (status === 429) return memberSentence(errorBody(err)?.message) ?? errorMessage(err, fallback);
  return errorMessage(err, fallback);
}

/**
 * The line under "We could not load ...". Only the connection and a slow-down are worth saying: a 404 here is an API
 * that has no entities yet (the live one, until it ships them), and is neither "this person" nor "this entity".
 */
export function loadFailedLine(error: unknown, fetchStatus: string): string {
  if (fetchStatus === 'paused') return CONNECTION_LOST;
  const status = statusOf(error);
  return status === undefined || status === 429 ? errorMessage(error, TRY_LATER) : TRY_LATER;
}

const NAME_TAKEN: typeof ErrorCodes.ENTITY_NAME_TAKEN = 'ENTITY_NAME_TAKEN';

/** On a 409 for a name another active entity has: that entity's id (details.existingId[0]), else null. */
export function nameTakenId(err: unknown): string | null {
  const error = errorBody(err);
  if (statusOf(err) !== 409 || error?.code !== NAME_TAKEN) return null;
  const ids = (error.details as { existingId?: unknown } | undefined)?.existingId;
  const id: unknown = Array.isArray(ids) ? ids[0] : undefined;
  return typeof id === 'string' && isEntityId(id) ? id.toLowerCase() : null;
}

export type EntityField = 'name' | 'kind' | 'role' | 'title' | 'about' | 'location' | 'size' | 'website';
const FIELDS: EntityField[] = ['name', 'kind', 'role', 'title', 'about', 'location', 'size', 'website'];

/** A refused form's reasons, one per field the server named, each fit to show next to that field. */
export function fieldErrors(err: unknown): Partial<Record<EntityField, string>> {
  const details = errorBody(err)?.details;
  if (statusOf(err) !== 400 || !details || typeof details !== 'object') return {};
  const out: Partial<Record<EntityField, string>> = {};
  for (const field of FIELDS) {
    const messages: unknown = (details as Record<string, unknown>)[field];
    if (!Array.isArray(messages)) continue;
    const first = memberSentence(messages[0]);
    if (first) out[field] = first;
  }
  return out;
}

// ---- toasts ------------------------------------------------------------------------------------

const COMPANY_FILLED = ' Your profile now shows it as your company.';

export const createdToast = (name: string, companyUpdated: boolean) => `${name} is on REASON.${companyUpdated ? COMPANY_FILLED : ''}`;
export const joinedToast = (name: string, companyUpdated: boolean) => `You joined ${name}.${companyUpdated ? COMPANY_FILLED : ''}`;
export const leftToast = (name: string, archived: boolean) =>
  (archived ? `You left ${name}. No one else was linked to it, so it is archived.` : `You left ${name}.`);
