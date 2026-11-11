// client/src/features/reason/entities/entity-services-form.ts
// The services editor's rules (Shirley pilot S7, RSN 15): one checkbox per category of the shared list, and for each
// checked one an optional description (280 characters, counted as the server counts them: one emoji is one) and an
// optional https website. Flat field names (`<category>_on`, `_description`, `_website`) so formResolver, which reads
// the first part of each problem's path, puts every message next to its own field. Pure on purpose, so a test can run
// it: server/src/__tests__/client/s7-entity-services.test.ts. The server checks everything again.
import { z } from 'zod';
import {
  ENTITY_LIMITS, ENTITY_SERVICE_CATEGORIES, ENTITY_SERVICE_LABELS,
  type EntityService, type EntityServiceCategory, type SetEntityServicesBody,
} from '@rsn/shared';

export type ServicesFormValues = Record<string, string | boolean>;

export const onField = (c: EntityServiceCategory) => `${c}_on`;
export const descriptionField = (c: EntityServiceCategory) => `${c}_description`;
export const websiteField = (c: EntityServiceCategory) => `${c}_website`;

/** Characters as the database counts them. */
export const characterCount = (text: string) => Array.from(text).length;

export const SERVICE_WEBSITE_HELP = 'Enter a secure web address that starts with https://, such as https://acme.com.';
const SCHEME = /^[a-z][a-z0-9+-]*:/i;

/** A website the server would refuse on sight: another scheme than https (http:, javascript:, mailto:), or spaces. */
export function websiteProblem(typed: string): string | null {
  const text = typed.trim();
  if (text === '') return null;
  if (/\s/.test(text)) return SERVICE_WEBSITE_HELP;
  if (SCHEME.test(text) && !/^https:\/\//i.test(text)) return SERVICE_WEBSITE_HELP;
  if (characterCount(text) > ENTITY_LIMITS.websiteMax) return `Keep the website to ${ENTITY_LIMITS.websiteMax} characters.`;
  return null;
}

/** The form as it opens: the entity's services checked, with their words; every other category empty. */
export function servicesDefaults(services: readonly EntityService[] | undefined): ServicesFormValues {
  const values: ServicesFormValues = {};
  for (const c of ENTITY_SERVICE_CATEGORIES) {
    const s = services?.find((x) => x.category === c);
    values[onField(c)] = !!s;
    values[descriptionField(c)] = s?.description ?? '';
    values[websiteField(c)] = s?.website ?? '';
  }
  return values;
}

const shape: Record<string, z.ZodTypeAny> = {};
for (const c of ENTITY_SERVICE_CATEGORIES) {
  shape[onField(c)] = z.boolean();
  shape[descriptionField(c)] = z.string();
  shape[websiteField(c)] = z.string();
}

/** Only a checked service's words are checked; an unchecked one's are ignored and never sent. */
export const servicesSchema = z.object(shape).superRefine((v, ctx) => {
  for (const c of ENTITY_SERVICE_CATEGORIES) {
    if (v[onField(c)] !== true) continue;
    const description = String(v[descriptionField(c)] ?? '').trim();
    if (characterCount(description) > ENTITY_LIMITS.serviceDescriptionMax) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [descriptionField(c)], message: `Keep the description to ${ENTITY_LIMITS.serviceDescriptionMax} characters.` });
    }
    const problem = websiteProblem(String(v[websiteField(c)] ?? ''));
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [websiteField(c)], message: problem });
  }
}) as unknown as z.ZodType<ServicesFormValues>;

/** The categories checked, in the list's order: the order the page shows them in. */
export function checkedCategories(v: ServicesFormValues): EntityServiceCategory[] {
  return ENTITY_SERVICE_CATEGORIES.filter((c) => v[onField(c)] === true);
}

/** PUT /api/entities/:id/services. Blank words go as null. */
export function servicesBody(v: ServicesFormValues): SetEntityServicesBody {
  return {
    services: checkedCategories(v).map((c) => ({
      category: c,
      description: String(v[descriptionField(c)] ?? '').trim() || null,
      website: String(v[websiteField(c)] ?? '').trim() || null,
    })),
  };
}

/**
 * A refused save's reasons next to their fields. The server names a problem `services.<n>.<field>`, where n counts the
 * services sent; `sent` is that list, so n finds its category. A reason about the whole list comes back as `general`.
 */
export function servicesFieldErrors(
  details: unknown, sent: readonly EntityServiceCategory[],
): { fields: Record<string, string>; general: string | null } {
  const fields: Record<string, string> = {};
  let general: string | null = null;
  if (!details || typeof details !== 'object') return { fields, general };
  for (const [key, messages] of Object.entries(details as Record<string, unknown>)) {
    const first = Array.isArray(messages) && typeof messages[0] === 'string' ? messages[0] : null;
    if (!first) continue;
    const parts = key.split('.');
    const category = parts[0] === 'services' && parts.length === 3 ? sent[Number(parts[1])] : undefined;
    if (category && (parts[2] === 'description' || parts[2] === 'website')) {
      fields[parts[2] === 'description' ? descriptionField(category) : websiteField(category)] = first;
    } else if (general === null) {
      general = first;
    }
  }
  return { fields, general };
}

export const serviceLabel = (c: EntityServiceCategory) => ENTITY_SERVICE_LABELS[c] ?? 'Other';
