// client/src/lib/form-resolver.ts
// react-hook-form's resolver for a Zod schema: the first problem of each field, in the schema's words, or the
// schema's (tidied) values. The project has no @hookform/resolvers, and this is all of it that the forms need.
// Moved here from the entity forms (26 Oct 2026) so the entity, pod and event forms share one; entity-form.ts
// re-exports it. Pure (types only from react-hook-form and zod), so a test can run it.
import type { FieldErrors, FieldValues, Resolver } from 'react-hook-form';
import type { ZodType, ZodTypeDef } from 'zod';

export function formResolver<T extends FieldValues>(schema: ZodType<T, ZodTypeDef, unknown>): Resolver<T> {
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
