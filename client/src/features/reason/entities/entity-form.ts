// client/src/features/reason/entities/entity-form.ts
// The create and edit forms' rules: their starting values, a Zod schema per form (the routes' own limits and words,
// from the shared ENTITY_LIMITS), the resolver that hands the schema to react-hook-form, and the request each form
// sends. Pure on purpose, so a test can run it: server/src/__tests__/client/reason-entities-text.test.ts.
//
// The server checks everything again (Zod on the route); these checks only answer at once, next to the field.
// Whether a website is a real address is left to the server, which says so for that field.
import { z } from 'zod';
import type { FieldErrors, FieldValues, Resolver } from 'react-hook-form';
import { ENTITY_KINDS, ENTITY_LIMITS, ENTITY_ROLES, type EntityInfo, type EntityKind, type EntityRole } from '@rsn/shared';
import { tidyName } from './entity-text';

const L = ENTITY_LIMITS;

/** Optional text, as the route counts it: trimmed, then at most `max` characters. */
const optionalText = (max: number, what: string) => z.string().trim().max(max, `Keep ${what} to ${max} characters.`);

const name = z.string().transform(tidyName).pipe(z.string()
  .min(1, 'Give the entity a name.')
  .min(L.nameMin, `Give the entity a name of at least ${L.nameMin} characters.`)
  .max(L.nameMax, `Keep the name to ${L.nameMax} characters.`));

const details = {
  name,
  kind: z.enum(ENTITY_KINDS, { errorMap: () => ({ message: 'Choose what kind of entity this is.' }) }),
  location: optionalText(L.locationMax, 'the location'),
  size: optionalText(L.sizeMax, 'the size'),
  about: optionalText(L.aboutMax, 'the description'),
  website: optionalText(L.websiteMax, 'the website'),
};

// Your own link: how you are linked to it, and your title there.
const link = {
  role: z.enum(ENTITY_ROLES, { errorMap: () => ({ message: 'Choose how you are linked to it.' }) }),
  title: optionalText(L.titleMax, 'the title'),
};

export const editSchema = z.object(details);
export const createSchema = z.object({ ...details, ...link });
export const roleSchema = z.object(link);

export type EntityFormValues = z.infer<typeof editSchema>;
export type CreateFormValues = z.infer<typeof createSchema>;
export type RoleFormValues = z.infer<typeof roleSchema>;

/**
 * react-hook-form's resolver for a Zod schema: the first problem of each field, in the schema's words, or the
 * schema's (tidied) values. The project has no @hookform/resolvers, and this is all of it that the forms need.
 */
export function formResolver<T extends FieldValues>(schema: z.ZodType<T, z.ZodTypeDef, unknown>): Resolver<T> {
  return async (values) => {
    const parsed = schema.safeParse(values);
    if (parsed.success) return { values: parsed.data, errors: {} };
    const errors: Record<string, { type: string; message: string }> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (typeof field === 'string' && !(field in errors)) errors[field] = { type: issue.code, message: issue.message };
    }
    return { values: {}, errors: errors as FieldErrors<T> };
  };
}

/** The create form as it opens: a company, and you as its founder (the brief's defaults). */
export function createDefaults(startName = ''): CreateFormValues {
  return { name: startName, kind: 'company', role: 'founder', title: '', location: '', size: '', about: '', website: '' };
}

/** The edit form as it opens: the entity as it is, with nothing shown as an empty field. */
export function editDefaults(e: Pick<EntityInfo, 'name' | 'kind' | 'location' | 'size' | 'about' | 'website'>): EntityFormValues {
  return { name: e.name, kind: e.kind, location: e.location ?? '', size: e.size ?? '', about: e.about ?? '', website: e.website ?? '' };
}

const orNull = (text: string) => text.trim() || null;

/** POST /api/entities. Blank optional fields go as null, which the route stores as nothing. */
export interface NewEntityBody {
  name: string; kind: EntityKind; role: EntityRole;
  title: string | null; location: string | null; size: string | null; about: string | null; website: string | null;
}

export function createBody(v: CreateFormValues): NewEntityBody {
  return {
    name: tidyName(v.name), kind: v.kind, role: v.role, title: orNull(v.title),
    location: orNull(v.location), size: orNull(v.size), about: orNull(v.about), website: orNull(v.website),
  };
}

/** The role form as it opens: your link as it is. */
export function roleDefaults(role: EntityRole, title: string | null): RoleFormValues {
  return { role, title: title ?? '' };
}

/**
 * POST /api/entities/:id/members from the role form. A title the member did not touch is left out, so the server keeps
 * the one on record (the page may not even know it: it lists at most 200 people). A title cleared on purpose is null.
 */
export function roleBody(v: RoleFormValues, titleChanged: boolean): { role: EntityRole; title?: string | null } {
  return titleChanged ? { role: v.role, title: orNull(v.title) } : { role: v.role };
}

/** PATCH /api/entities/:id. Only what the member changed is sent, so a field another admin just edited is left alone. */
export type EntityChanges = Partial<{ name: string; kind: EntityKind } & Record<'location' | 'size' | 'about' | 'website', string | null>>;

export function editChanges(v: EntityFormValues, dirty: Partial<Record<keyof EntityFormValues, boolean | undefined>>): EntityChanges {
  const changes: EntityChanges = {};
  if (dirty.name) changes.name = tidyName(v.name);
  if (dirty.kind) changes.kind = v.kind;
  for (const field of ['location', 'size', 'about', 'website'] as const) {
    if (dirty[field]) changes[field] = orNull(v[field]);
  }
  return changes;
}
