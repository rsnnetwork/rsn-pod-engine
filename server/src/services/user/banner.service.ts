// ─── The member banner (21 Oct 2026) ─────────────────────────────────────────
//
// "Users should be able to change their banner from their profile" (19 Oct feedback). It is kept in the member's
// own row, the way the stored LinkedIn photo is (avatar.service.ts), and served by GET /api/users/:id/banner.
//
// Since the 30 Oct review (T3a) the picture the member chose is kept too, with where they placed it, and the banner
// everyone sees is cut from it on the server (picture.service.ts). The gate on what is accepted is picture-file.ts,
// shared with the photo: only a JPEG, PNG or WebP of at most 3 MB, whose bytes really are that kind of picture.

import { query } from '../../db';
import config from '../../config';
import { NotFoundError } from '../../middleware/errors';
import {
  PICTURE_MAX_BYTES, PICTURE_MAX_DATA_URL_CHARS, PICTURE_MAX_SIDE, PICTURE_TYPES, parsePicture, pictureSize,
  type PictureType,
} from './picture-file';

export const BANNER_TYPES = PICTURE_TYPES;
export type BannerType = PictureType;
export const BANNER_MAX_BYTES = PICTURE_MAX_BYTES;
/** The longest data URL that can hold BANNER_MAX_BYTES: the base64 text plus room for the prefix. */
export const BANNER_MAX_DATA_URL_CHARS = PICTURE_MAX_DATA_URL_CHARS;
/** The most pixels on either side (picture-file.ts says why). */
export const BANNER_MAX_SIDE = PICTURE_MAX_SIDE;
export { pictureSize };

/** The picture in a data URL, or a 400 that says in a sentence what is wrong with it. */
export function parseBannerImage(image: string): { bytes: Buffer; mime: BannerType } {
  return parsePicture(image, 'banner');
}

/**
 * Where a member's banner is loaded from, or null when they have none. Absolute, like the stored photo's
 * address (avatarUrlFor): the app and the preview are served from another origin than the API, so a
 * relative /api/... would be asked of the wrong site. The time of the change rides along as ?v=, so the
 * day-long cache on the picture never shows an old banner after a new one.
 */
export function bannerUrlFor(userId: string, updatedAt: Date | null): string | null {
  if (!updatedAt) return null;
  const base = config.apiBaseUrl.replace(/\/+$/, '');
  return `${base}/api/users/${userId}/banner?v=${updatedAt.getTime()}`;
}

/** Take a member's banner away, with the picture it was cut from. Their profile goes back to the default one. */
export async function removeBanner(userId: string): Promise<void> {
  const r = await query<{ id: string }>(
    `UPDATE users SET banner_blob = NULL, banner_mime = NULL, banner_updated_at = NULL,
            banner_source_blob = NULL, banner_source_mime = NULL, banner_crop = NULL
      WHERE id = $1 RETURNING id`,
    [userId],
  );
  if (!r.rows[0]) throw new NotFoundError('User', userId, 'This account is no longer available.');
}

/** The stored banner for the public picture route. Null when the member has none. */
export async function getBannerBlob(userId: string): Promise<{ blob: Buffer; contentType: string } | null> {
  const r = await query<{ banner_blob: Buffer | null; banner_mime: string | null }>(
    `SELECT banner_blob, banner_mime FROM users WHERE id = $1`,
    [userId],
  );
  const row = r.rows[0];
  if (!row || !row.banner_blob || !row.banner_mime) return null;
  return { blob: row.banner_blob, contentType: row.banner_mime };
}
