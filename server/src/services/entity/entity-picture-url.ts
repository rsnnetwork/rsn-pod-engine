// ─── Where an entity's logo and banner are loaded from (30 Oct review, T15) ──────────────────────────────────────
//
// Absolute, like the member banner's address (bannerUrlFor): the app and the preview are served from another origin
// than the API. The time of the last picture change rides along as ?v=, so the day-long cache on a picture never
// shows an old one after a new one. The reads select only whether a picture is there (never its bytes) and the time.

import { ErrorCodes } from '@rsn/shared';
import config from '../../config';
import { AppError } from '../../middleware/errors';

export type EntityPictureKind = 'logo' | 'banner';

export function entityPictureUrl(entityId: string, kind: EntityPictureKind, has: boolean, updatedAt: Date | null): string | null {
  if (!has || !updatedAt) return null;
  const base = config.apiBaseUrl.replace(/\/+$/, '');
  return `${base}/api/entities/${entityId}/${kind}?v=${updatedAt.getTime()}`;
}

/**
 * The columns a read adds for the pictures of the entity aliased `e`: whether each is there and when they changed.
 * `IS NOT NULL` reads only the row's null map, so the pictures themselves are never loaded by a list.
 */
export function entityPictureColumns(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) {
    throw new AppError(500, ErrorCodes.INTERNAL_ERROR, `Not a table alias: ${JSON.stringify(alias)}`);
  }
  return `(${alias}.logo_blob IS NOT NULL) AS has_logo, (${alias}.banner_blob IS NOT NULL) AS has_banner,
          ${alias}.pictures_updated_at`;
}

export interface EntityPictureRow { has_logo: boolean; has_banner: boolean; pictures_updated_at: Date | null }
