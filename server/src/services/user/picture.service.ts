// ─── The member's photo and banner, cut from the picture they chose (30 Oct review, T3a) ─────────────────────────
//
// "Add an edit (pencil) button directly on the profile picture ... that allows to fix the size or position", and
// "Pictures look pixelated". The picture a member chooses is kept as it came (at most 3 MB, checked by
// picture-file.ts) with where they placed it (a crop: shared/src/picture/crop.ts). The picture everyone sees is cut
// from it here and kept beside it: a photo as a 1024 square JPEG at 0.9, a banner as 2400 by 800 at 0.85 (L1), or
// smaller when the part kept is smaller, never enlarged. Placing it again later sends only the new crop: the kept
// picture is cut again, and is not sent or written again.
//
// The cut is made with sharp (libvips): it reads JPEG, PNG and WebP, turns a phone photo the way its EXIF says (as the
// browser in the editor does), shrinks with a Lanczos filter (the browser's own one-step canvas shrink was part of the
// pixelation), and works off the main thread, so a cut never holds up a live event.

import sharp from 'sharp';
import {
  PICTURE_CENTRED, PICTURE_MAX_ZOOM, PICTURE_SHAPES, clampPictureCrop, pictureCropRect, pictureOutputSize,
  type PictureCrop, type PictureKind, type PictureSource,
} from '@rsn/shared';
import { query } from '../../db';
import { AppError, NotFoundError, ValidationError } from '../../middleware/errors';
import { avatarAddress } from '../onboarding/avatar.service';
import { bannerUrlFor } from './banner.service';
import { NOT_A_PICTURE, PICTURE_MAX_SIDE, parsePicture } from './picture-file';

const GONE = 'This account is no longer available.';
const CHOOSE_FIRST = 'Choose a picture first.';

// Opening a picture: refuse one with broken pixel data, and one past the side limit (a captured photo was never
// checked by picture-file.ts, so the decoder holds the line too).
const OPEN: sharp.SharpOptions = { failOn: 'error', limitInputPixels: PICTURE_MAX_SIDE * PICTURE_MAX_SIDE };

// Bounded on purpose (review of T3a): a tiny one-colour 4096 square PNG opens to about 67 MB, and the API runs on a
// 512 MB instance during live events. So libvips keeps no cache of opened pictures, each cut uses one thread, and at
// most PICTURE_RENDER_SLOTS pictures are cut at once across all requests; the others wait their turn (a save takes
// well under a second). The photo's write limit (10 a minute per member) also covers production's PUT /users/me.
sharp.cache(false);
sharp.concurrency(1);
export const PICTURE_RENDER_SLOTS = 2;
let running = 0;
const waiting: Array<() => void> = [];

/** Run `job` in one of the render slots. A finished job hands its slot straight to the next in line. */
async function inRenderSlot<T>(job: () => Promise<T>): Promise<T> {
  if (running < PICTURE_RENDER_SLOTS) running += 1;
  else await new Promise<void>((resume) => waiting.push(resume));
  try {
    return await job();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  }
}

/** How many cuts are running and how many wait (for tests and logs). */
export const pictureRenderLoad = () => ({ running, waiting: waiting.length });

export interface RenderedPicture { bytes: Buffer; mime: 'image/jpeg'; crop: PictureCrop }

/** The picture everyone sees, cut from `source` where `crop` places it. A file that cannot be opened is a 400. */
export function renderPicture(source: Buffer, kind: PictureKind, crop: PictureCrop): Promise<RenderedPicture> {
  return inRenderSlot(() => cutPicture(source, kind, crop));
}

async function cutPicture(source: Buffer, kind: PictureKind, crop: PictureCrop): Promise<RenderedPicture> {
  const shape = PICTURE_SHAPES[kind];
  try {
    const meta = await sharp(source, OPEN).metadata();
    if (!meta.width || !meta.height) throw new ValidationError(NOT_A_PICTURE);
    // Orientations 5 to 8 are a quarter turn: the picture shows with its width and height swapped.
    const turned = (meta.orientation ?? 1) >= 5;
    const width = turned ? meta.height : meta.width;
    const height = turned ? meta.width : meta.height;
    const placed = clampPictureCrop(crop, width, height, shape.aspect);
    const rect = pictureCropRect(placed, width, height, shape.aspect);
    const size = pictureOutputSize(rect, shape);
    const bytes = await sharp(source, OPEN)
      .rotate() // as the EXIF orientation says, before the cut, so the cut is the part the member saw
      .extract(rect)
      .resize(size.width, size.height, { fit: 'fill', kernel: 'lanczos3' })
      .flatten({ background: '#ffffff' }) // a JPEG has no transparency: a see-through PNG goes on white, not black
      .jpeg({ quality: Math.round(shape.quality * 100) })
      .toBuffer();
    return { bytes, mime: 'image/jpeg', crop: placed };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new ValidationError(NOT_A_PICTURE);
  }
}

export interface PictureInput {
  /** A new picture, as a data URL. Without one, the kept picture is placed again. */
  image?: string;
  crop?: PictureCrop;
}

interface StoredPicture {
  source: Buffer | null;
  source_mime: string | null;
  crop: unknown;
  shown: Buffer | null;
  shown_mime: string | null;
}

// Each kind's columns, written out: the photo also carries its address (avatar_url, which every list reads) and the
// row's updated_at, as a captured photo does (avatar.service.ts); the banner's address is built from its time.
const READ: Record<PictureKind, string> = {
  avatar: `SELECT avatar_source_blob AS source, avatar_source_mime AS source_mime, avatar_crop AS crop,
                  avatar_blob AS shown, avatar_blob_type AS shown_mime
             FROM users WHERE id = $1`,
  banner: `SELECT banner_source_blob AS source, banner_source_mime AS source_mime, banner_crop AS crop,
                  banner_blob AS shown, banner_mime AS shown_mime
             FROM users WHERE id = $1`,
};

async function readStored(kind: PictureKind, userId: string): Promise<StoredPicture> {
  const r = await query<StoredPicture>(READ[kind], [userId]);
  const row = r.rows[0];
  if (!row) throw new NotFoundError('User', userId, GONE);
  return row;
}

/** A crop read back from the database, or null when there is none (or it is not one). */
function storedCrop(value: unknown): PictureCrop | null {
  if (!value || typeof value !== 'object') return null;
  const { x, y, zoom } = value as Record<string, unknown>;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof zoom !== 'number') return null;
  if (![x, y, zoom].every(Number.isFinite) || zoom < 1 || zoom > PICTURE_MAX_ZOOM) return null;
  return { x, y, zoom };
}

const bareType = (mime: string) => mime.split(';')[0].trim();
const asDataUrl = (mime: string, bytes: Buffer) => `data:${bareType(mime)};base64,${bytes.toString('base64')}`;

async function writePicture(
  kind: PictureKind, userId: string, out: RenderedPicture, at: Date, source: { bytes: Buffer; mime: string } | null,
): Promise<string> {
  const crop = JSON.stringify(out.crop);
  let sql: string;
  let params: unknown[];
  let url: string;
  if (kind === 'avatar') {
    url = avatarAddress(userId, at);
    sql = source
      ? `UPDATE users SET avatar_blob = $2, avatar_blob_type = $3, avatar_crop = $4, avatar_updated_at = $5, avatar_url = $6,
                avatar_source_blob = $7, avatar_source_mime = $8, updated_at = NOW()
          WHERE id = $1 RETURNING id`
      : `UPDATE users SET avatar_blob = $2, avatar_blob_type = $3, avatar_crop = $4, avatar_updated_at = $5, avatar_url = $6,
                updated_at = NOW()
          WHERE id = $1 RETURNING id`;
    params = [userId, out.bytes, out.mime, crop, at, url, ...(source ? [source.bytes, source.mime] : [])];
  } else {
    url = bannerUrlFor(userId, at) as string;
    sql = source
      ? `UPDATE users SET banner_blob = $2, banner_mime = $3, banner_crop = $4, banner_updated_at = $5,
                banner_source_blob = $6, banner_source_mime = $7
          WHERE id = $1 RETURNING id`
      : `UPDATE users SET banner_blob = $2, banner_mime = $3, banner_crop = $4, banner_updated_at = $5
          WHERE id = $1 RETURNING id`;
    params = [userId, out.bytes, out.mime, crop, at, ...(source ? [source.bytes, source.mime] : [])];
  }
  const r = await query<{ id: string }>(sql, params);
  if (!r.rows[0]) throw new NotFoundError('User', userId, GONE);
  return url;
}

/**
 * Keep a member's photo or banner. With a new picture: it is kept as it came, with its crop (the middle when none is
 * given), and the picture everyone sees is cut from it. With only a crop: the kept picture is cut again. A member
 * whose picture came from elsewhere (a captured LinkedIn, Google or Gravatar photo, or a banner from before) and was
 * never placed is placed from that picture, which is then kept. Answers with the picture's new address.
 */
export async function savePicture(kind: PictureKind, userId: string, input: PictureInput): Promise<{ url: string }> {
  if (input.image !== undefined) {
    const chosen = parsePicture(input.image, kind);
    const out = await renderPicture(chosen.bytes, kind, input.crop ?? PICTURE_CENTRED);
    return { url: await writePicture(kind, userId, out, new Date(), chosen) };
  }
  const stored = await readStored(kind, userId);
  const crop = input.crop ?? storedCrop(stored.crop) ?? PICTURE_CENTRED;
  if (stored.source) {
    const out = await renderPicture(stored.source, kind, crop);
    return { url: await writePicture(kind, userId, out, new Date(), null) };
  }
  if (stored.shown && stored.shown_mime) {
    const out = await renderPicture(stored.shown, kind, crop);
    return { url: await writePicture(kind, userId, out, new Date(), { bytes: stored.shown, mime: bareType(stored.shown_mime) }) };
  }
  throw new ValidationError(CHOOSE_FIRST);
}

/** What the member's editor opens on: the kept picture and its crop, else the picture everyone sees, else none. */
export async function getPictureSource(kind: PictureKind, userId: string): Promise<PictureSource> {
  const stored = await readStored(kind, userId);
  if (stored.source && stored.source_mime) {
    return { image: asDataUrl(stored.source_mime, stored.source), crop: storedCrop(stored.crop) };
  }
  if (stored.shown && stored.shown_mime) return { image: asDataUrl(stored.shown_mime, stored.shown), crop: null };
  return { image: null, crop: null };
}
