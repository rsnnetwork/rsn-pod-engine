// ─── Who should meet whom: the template an event pairs people with (30 Oct 2026, T12) ────────────
//
// An event's config.matchingTemplateId names a matching_templates row. Any organiser may choose one of REASON's
// presets (migration 126, is_preset = true); any other template is a platform admin's pick. Until now the id was
// any string from anyone, and a value that was not a UUID made the engine's template read throw (D6).
//
// Only the template's weights are ever used. Its own matching_policy and cooldown_months are never applied over
// the event's rule (D5): the event's form always sets a rule, and that rule is the one the engine follows.

import { z } from 'zod';
import { ErrorCodes, type MatchingPreset } from '@rsn/shared';
import { query } from '../../db';
import { AppError, ValidationError } from '../../middleware/errors';

const uuid = z.string().uuid();

const NOT_AN_ID = 'Choose who should meet whom from the list.';
const NO_SUCH_TEMPLATE = "That matching choice doesn't exist any more. Choose another.";
const ADMINS_ONLY = 'Only platform admins can choose that matching template. Choose one of the presets.';

/**
 * The template id an event's config names, when it is one. A value stored before ids were checked (a name, a
 * typo) reads as no template, so the event pairs on the engine's own weights instead of failing at the read.
 */
export function templateIdOf(config: unknown): string | null {
  const value = (config as { matchingTemplateId?: unknown } | null | undefined)?.matchingTemplateId;
  return uuid.safeParse(value).success ? (value as string) : null;
}

/**
 * Refuses a template choice an organiser may not make, each at the field: not an id (400), no such template
 * (400), a template that is not a preset chosen by someone who is not a platform admin (403). An empty value
 * means no template and is fine.
 */
export async function assertTemplateChoice(value: unknown, isAdmin: boolean): Promise<void> {
  if (value === undefined || value === null || value === '') return;
  if (!uuid.safeParse(value).success) {
    throw new ValidationError(NOT_AN_ID, { matchingTemplateId: [NOT_AN_ID] });
  }
  const row = (await query<{ is_preset: boolean }>(
    `SELECT is_preset FROM matching_templates WHERE id = $1`,
    [value],
  )).rows[0];
  if (!row) throw new ValidationError(NO_SUCH_TEMPLATE, { matchingTemplateId: [NO_SUCH_TEMPLATE] });
  if (!row.is_preset && !isAdmin) {
    throw new AppError(403, ErrorCodes.AUTH_FORBIDDEN, ADMINS_ONLY, { matchingTemplateId: [ADMINS_ONLY] });
  }
}

/** The presets any organiser may choose, in the order the form lists them. */
export async function listMatchingPresets(): Promise<MatchingPreset[]> {
  const result = await query<MatchingPreset>(
    `SELECT id, name, description FROM matching_templates WHERE is_preset = TRUE ORDER BY id LIMIT 20`,
  );
  return result.rows;
}
