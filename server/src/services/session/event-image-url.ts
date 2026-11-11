// ─── Where an event's image is loaded from (10 Nov 2026 spec, Part 3 Task 1) ─────────────────────────────────────
//
// Absolute, like an entity's pictures (entity-picture-url.ts): the app, the preview and every email open it from
// another origin than the API, and an email cannot carry a data URL (Gmail blocks them). The time of the last change
// rides along as ?v=, so the day-long cache never shows an old image after a new one. The reads select only whether
// an image is there and when it changed, never its bytes.

import { ErrorCodes } from '@rsn/shared';
import config from '../../config';
import { AppError } from '../../middleware/errors';

/** The image's address, or null when the event has none. */
export function eventImageUrl(sessionId: string, hasImage: boolean, updatedAt: Date | string | null): string | null {
  if (!hasImage || !updatedAt) return null;
  const at = new Date(updatedAt).getTime();
  if (Number.isNaN(at)) return null;
  const base = config.apiBaseUrl.replace(/\/+$/, '');
  return `${base}/api/sessions/${sessionId}/image?v=${at}`;
}

/** The two columns eventImageUrl needs, from the sessions row under `alias`: has_image and image_updated_at. */
export function eventImageColumns(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) {
    throw new AppError(500, ErrorCodes.INTERNAL_ERROR, `Not a table alias: ${JSON.stringify(alias)}`);
  }
  return `(${alias}.image_blob IS NOT NULL) AS has_image, ${alias}.image_updated_at`;
}

export interface EventImageRow { has_image?: boolean | null; image_updated_at?: Date | string | null }

/** The address from a row read with eventImageColumns. */
export function eventImageUrlOf(sessionId: string, row: EventImageRow): string | null {
  return eventImageUrl(sessionId, !!row.has_image, row.image_updated_at ?? null);
}
