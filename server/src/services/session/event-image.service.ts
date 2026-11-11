// ─── An event's image (10 Nov 2026 spec, Part 3 Task 1; spec 03 "imagery") ───────────────────────────────────────
//
// Kept as an entity's banner is (entity-pictures.service.ts): the picture the organiser chose is kept as it came, with
// where they placed it, and the picture everyone sees is cut from it on the server by the same code and the same gate
// (picture-file.ts): 3:1, 2400 by 800 at most, JPEG at 0.85, on white. Placing it again later sends only the new crop.
//
// Who may change it is updateSession's rule: a platform admin or the event's host (host_user_id). A co-host may not.
// They are checked without a lock before a picture is opened, the bytes are cut outside any transaction (a cut waits
// for one of two render slots), and written under the event's row lock, which checks again that the writer may still
// change it and that the event still exists. An event that does not exist (or was deleted) is a 404; anyone else a 403.

import type { PictureCrop, PictureSource } from '@rsn/shared';
import { PICTURE_CENTRED } from '@rsn/shared';
import type { PoolClient } from 'pg';
import { query, transaction } from '../../db';
import { ForbiddenError, NotFoundError, ValidationError } from '../../middleware/errors';
import type { PictureBody } from '../../routes/picture-body';
import { renderPicture, type RenderedPicture } from '../user/picture.service';
import { namedPictureWords, parsePicture } from '../user/picture-file';
import { eventImageUrl } from './event-image-url';

export const EVENT_IMAGE_NOT_HOST = "Only the event's host can change its image.";
const CHOOSE_FIRST = 'Choose a picture first.';
const IMAGE_WORDS = namedPictureWords('event image');
const eventGone = (sessionId: string) => new NotFoundError('Session', sessionId, "We couldn't find that event.");

type Read = (text: string, params: unknown[]) => Promise<{ rows: Array<{ host_user_id: string; pod_id: string | null }> }>;

/**
 * The event's pod, once the actor is known to be allowed to change its image: 404 for an event that is not there,
 * 403 for anyone but its host and platform admins. `lock` reads the row FOR UPDATE (inside the write's transaction).
 */
async function assertMayChange(
  read: Read, sessionId: string, actorId: string, isAdmin: boolean, lock: boolean,
): Promise<{ podId: string | null }> {
  const found = await read(
    `SELECT host_user_id, pod_id FROM sessions WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [sessionId],
  );
  const row = found.rows[0];
  if (!row) throw eventGone(sessionId);
  if (!isAdmin && row.host_user_id !== actorId) throw new ForbiddenError(EVENT_IMAGE_NOT_HOST);
  return { podId: row.pod_id };
}

const readUnlocked: Read = (text, params) => query(text, params);
const readWith = (client: PoolClient): Read => (text, params) => client.query(text, params);

interface Stored { source: Buffer | null; source_mime: string | null; crop: unknown }

async function readStored(sessionId: string): Promise<Stored> {
  const r = await query<Stored>(
    `SELECT image_source_blob AS source, image_source_mime AS source_mime, image_crop AS crop FROM sessions WHERE id = $1`,
    [sessionId],
  );
  if (!r.rows[0]) throw eventGone(sessionId);
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

/** A crop as the column holds it: JSONB comes back parsed from Postgres, a stand-in may hand back the text. */
function cropOf(value: unknown): PictureCrop | null {
  if (typeof value === 'string') {
    try {
      return storedCrop(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return storedCrop(value);
}

const bareType = (mime: string) => mime.split(';')[0].trim();

async function writeImage(
  actorId: string, sessionId: string, out: RenderedPicture, source: { bytes: Buffer; mime: string } | null, isAdmin: boolean,
): Promise<{ imageUrl: string; podId: string | null }> {
  const at = new Date();
  const { podId } = await transaction(async (client) => {
    const allowed = await assertMayChange(readWith(client), sessionId, actorId, isAdmin, true);
    const params: unknown[] = [sessionId, out.bytes, out.mime, JSON.stringify(out.crop), at];
    const keepSource = source ? ', image_source_blob = $6, image_source_mime = $7' : '';
    if (source) params.push(source.bytes, source.mime);
    await client.query(
      `UPDATE sessions SET image_blob = $2, image_mime = $3, image_crop = $4, image_updated_at = $5${keepSource}
        WHERE id = $1`,
      params,
    );
    return allowed;
  });
  return { imageUrl: eventImageUrl(sessionId, true, at) as string, podId };
}

/**
 * Keep an event's image. With a new picture: it is kept as it came, with its crop (the middle when none is given), and
 * the image everyone sees is cut from it. With only a crop: the kept picture is cut again (none kept: a 400 asking for
 * a picture). Answers the image's new address, and the event's pod for the caller's fanout. 403 for anyone but the
 * event's host and platform admins, 404 for an event that is not there.
 */
export async function saveEventImage(
  actorId: string, sessionId: string, input: PictureBody, isAdmin: boolean,
): Promise<{ imageUrl: string; podId: string | null }> {
  await assertMayChange(readUnlocked, sessionId, actorId, isAdmin, false);
  if (input.image !== undefined) {
    const chosen = parsePicture(input.image, IMAGE_WORDS);
    const out = await renderPicture(chosen.bytes, 'banner', input.crop ?? PICTURE_CENTRED);
    return writeImage(actorId, sessionId, out, chosen, isAdmin);
  }
  const stored = await readStored(sessionId);
  if (!stored.source) throw new ValidationError(CHOOSE_FIRST);
  const out = await renderPicture(stored.source, 'banner', input.crop ?? cropOf(stored.crop) ?? PICTURE_CENTRED);
  return writeImage(actorId, sessionId, out, null, isAdmin);
}

/** Take the image away, with the picture it was cut from. Answers no address, and the event's pod for the fanout. */
export async function removeEventImage(
  actorId: string, sessionId: string, isAdmin: boolean,
): Promise<{ imageUrl: null; podId: string | null }> {
  const { podId } = await transaction(async (client) => {
    const allowed = await assertMayChange(readWith(client), sessionId, actorId, isAdmin, true);
    await client.query(
      `UPDATE sessions SET image_blob = NULL, image_mime = NULL, image_crop = NULL, image_source_blob = NULL,
              image_source_mime = NULL, image_updated_at = NOW()
        WHERE id = $1`,
      [sessionId],
    );
    return allowed;
  });
  return { imageUrl: null, podId };
}

/** What the organiser's editor opens on: the kept picture and its crop, or none. A read: it takes no lock. */
export async function getEventImageSource(actorId: string, sessionId: string, isAdmin: boolean): Promise<PictureSource> {
  await assertMayChange(readUnlocked, sessionId, actorId, isAdmin, false);
  const stored = await readStored(sessionId);
  if (!stored.source || !stored.source_mime) return { image: null, crop: null };
  return { image: `data:${bareType(stored.source_mime)};base64,${stored.source.toString('base64')}`, crop: cropOf(stored.crop) };
}

/** The image for the public route. Null when there is none, or the event is not there (its address stops working). */
export async function getEventImageBlob(sessionId: string): Promise<{ bytes: Buffer; mime: string } | null> {
  const r = await query<{ blob: Buffer | null; mime: string | null }>(
    `SELECT image_blob AS blob, image_mime AS mime FROM sessions WHERE id = $1`,
    [sessionId],
  );
  const row = r.rows[0];
  if (!row || !row.blob || !row.mime) return null;
  return { bytes: row.blob, mime: row.mime };
}
