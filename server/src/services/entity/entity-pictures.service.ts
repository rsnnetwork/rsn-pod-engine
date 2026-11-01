// ─── An entity's logo and banner (30 Oct review, 7.1: "Please add options to upload a company logo and banner") ──
//
// Kept as the member's photo and banner are (T3a, picture.service.ts): the picture an admin chose is kept as it came,
// with where they placed it, and the picture everyone sees is cut from it on the server by the same code and the
// same gate (picture-file.ts). Placing it again later sends only the new crop.
//   * The logo is cut as a photo is: a square, 1024 at most, JPEG at 0.9 (L1), on white. Every logo is drawn on a
//     white tile (EntityMark), so a see-through PNG looks the same on white as it did; one output format means one
//     cut, and a square JPEG is a fraction of a PNG's size.
//   * The banner is cut as a member's banner is: 3:1, 2400 by 800 at most, JPEG at 0.85.
// Only the entity's admins and platform admins change them (lockForAdmin). The bytes are opened and cut outside any
// transaction (a cut waits for one of two render slots), and written under the entity's row lock, which checks the
// writer is still an admin and the entity is not archived at that moment.

import type { PictureCrop, PictureKind, PictureSource } from '@rsn/shared';
import { PICTURE_CENTRED } from '@rsn/shared';
import { query, transaction } from '../../db';
import { NotFoundError, ValidationError } from '../../middleware/errors';
import { renderPicture, type PictureInput, type RenderedPicture } from '../user/picture.service';
import { namedPictureWords, parsePicture } from '../user/picture-file';
import { entityPictureUrl, type EntityPictureKind } from './entity-picture-url';
import { lockForAdmin } from './entity.service';

export type { EntityPictureKind } from './entity-picture-url';

/** Which of L1's shapes each picture is cut to. */
const CUT_AS: Record<EntityPictureKind, PictureKind> = { logo: 'avatar', banner: 'banner' };

// Each picture's columns, written out here; nothing a member sends names a column.
const COLUMNS: Record<EntityPictureKind, { shown: string; mime: string; crop: string; source: string; sourceMime: string }> = {
  logo: { shown: 'logo_blob', mime: 'logo_mime', crop: 'logo_crop', source: 'logo_source_blob', sourceMime: 'logo_source_mime' },
  banner: { shown: 'banner_blob', mime: 'banner_mime', crop: 'banner_crop', source: 'banner_source_blob', sourceMime: 'banner_source_mime' },
};

const CHOOSE_FIRST = 'Choose a picture first.';
const entityGone = (entityId: string) => new NotFoundError('Entity', entityId, 'This entity could not be found.');

/** A 403 or 404 before any picture is opened. */
async function assertMayChange(actorId: string, entityId: string, actorIsPlatformAdmin: boolean): Promise<void> {
  await transaction((client) => lockForAdmin(client, entityId, actorId, actorIsPlatformAdmin));
}

interface Stored { source: Buffer | null; source_mime: string | null; crop: unknown; shown: Buffer | null; shown_mime: string | null }

async function readStored(entityId: string, kind: EntityPictureKind): Promise<Stored> {
  const c = COLUMNS[kind];
  const r = await query<Stored>(
    `SELECT ${c.source} AS source, ${c.sourceMime} AS source_mime, ${c.crop} AS crop, ${c.shown} AS shown, ${c.mime} AS shown_mime
       FROM entities WHERE id = $1 AND archived_at IS NULL`,
    [entityId],
  );
  if (!r.rows[0]) throw entityGone(entityId);
  return r.rows[0];
}

/** A crop read back from the database, or null when there is none (or it is not one). */
function storedCrop(value: unknown): PictureCrop | null {
  if (!value || typeof value !== 'object') return null;
  const { x, y, zoom } = value as Record<string, unknown>;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof zoom !== 'number') return null;
  if (![x, y, zoom].every(Number.isFinite)) return null;
  return { x, y, zoom };
}

const bareType = (mime: string) => mime.split(';')[0].trim();

async function writePicture(
  actorId: string, entityId: string, kind: EntityPictureKind, out: RenderedPicture,
  source: { bytes: Buffer; mime: string } | null, actorIsPlatformAdmin: boolean,
): Promise<string> {
  const c = COLUMNS[kind];
  const at = new Date();
  await transaction(async (client) => {
    await lockForAdmin(client, entityId, actorId, actorIsPlatformAdmin);
    const params: unknown[] = [entityId, out.bytes, out.mime, JSON.stringify(out.crop), at];
    const keepSource = source ? `, ${c.source} = $6, ${c.sourceMime} = $7` : '';
    if (source) params.push(source.bytes, source.mime);
    await client.query(
      `UPDATE entities SET ${c.shown} = $2, ${c.mime} = $3, ${c.crop} = $4, pictures_updated_at = $5, updated_at = NOW()${keepSource}
        WHERE id = $1`,
      params,
    );
  });
  return entityPictureUrl(entityId, kind, true, at) as string;
}

/**
 * Keep an entity's logo or banner. With a new picture: it is kept as it came, with its crop (the middle when none is
 * given), and the picture everyone sees is cut from it. With only a crop: the kept picture is cut again. Answers with
 * the picture's new address. 403 for anyone but its admins and platform admins, 404 for a missing or archived entity.
 */
export async function saveEntityPicture(
  actorId: string, entityId: string, kind: EntityPictureKind, input: PictureInput, actorIsPlatformAdmin: boolean,
): Promise<{ url: string }> {
  await assertMayChange(actorId, entityId, actorIsPlatformAdmin);
  if (input.image !== undefined) {
    const chosen = parsePicture(input.image, namedPictureWords(kind));
    const out = await renderPicture(chosen.bytes, CUT_AS[kind], input.crop ?? PICTURE_CENTRED);
    return { url: await writePicture(actorId, entityId, kind, out, chosen, actorIsPlatformAdmin) };
  }
  const stored = await readStored(entityId, kind);
  const crop = input.crop ?? storedCrop(stored.crop) ?? PICTURE_CENTRED;
  if (stored.source) {
    const out = await renderPicture(stored.source, CUT_AS[kind], crop);
    return { url: await writePicture(actorId, entityId, kind, out, null, actorIsPlatformAdmin) };
  }
  if (stored.shown && stored.shown_mime) {
    const out = await renderPicture(stored.shown, CUT_AS[kind], crop);
    const keep = { bytes: stored.shown, mime: bareType(stored.shown_mime) };
    return { url: await writePicture(actorId, entityId, kind, out, keep, actorIsPlatformAdmin) };
  }
  throw new ValidationError(CHOOSE_FIRST);
}

/** Take the logo or banner away, with the picture it was cut from. The page goes back to the letter tile / no strip. */
export async function removeEntityPicture(
  actorId: string, entityId: string, kind: EntityPictureKind, actorIsPlatformAdmin: boolean,
): Promise<void> {
  const c = COLUMNS[kind];
  await transaction(async (client) => {
    await lockForAdmin(client, entityId, actorId, actorIsPlatformAdmin);
    await client.query(
      `UPDATE entities SET ${c.shown} = NULL, ${c.mime} = NULL, ${c.crop} = NULL, ${c.source} = NULL, ${c.sourceMime} = NULL,
              pictures_updated_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [entityId],
    );
  });
}

/** What the admin's editor opens on: the kept picture and its crop, else the picture everyone sees, else none. */
export async function getEntityPictureSource(
  actorId: string, entityId: string, kind: EntityPictureKind, actorIsPlatformAdmin: boolean,
): Promise<PictureSource> {
  await assertMayChange(actorId, entityId, actorIsPlatformAdmin);
  const stored = await readStored(entityId, kind);
  const asDataUrl = (mime: string, bytes: Buffer) => `data:${bareType(mime)};base64,${bytes.toString('base64')}`;
  if (stored.source && stored.source_mime) return { image: asDataUrl(stored.source_mime, stored.source), crop: storedCrop(stored.crop) };
  if (stored.shown && stored.shown_mime) return { image: asDataUrl(stored.shown_mime, stored.shown), crop: null };
  return { image: null, crop: null };
}

/** The picture for the public route. Null when there is none, or the entity is archived (its address stops working). */
export async function getEntityPictureBlob(entityId: string, kind: EntityPictureKind): Promise<{ blob: Buffer; contentType: string } | null> {
  const c = COLUMNS[kind];
  const r = await query<{ blob: Buffer | null; mime: string | null }>(
    `SELECT ${c.shown} AS blob, ${c.mime} AS mime FROM entities WHERE id = $1 AND archived_at IS NULL`,
    [entityId],
  );
  const row = r.rows[0];
  if (!row || !row.blob || !row.mime) return null;
  return { blob: row.blob, contentType: row.mime };
}
