// ─── The member banner (21 Oct 2026) ─────────────────────────────────────────
//
// "Users should be able to change their banner from their profile" (19 Oct feedback). The profile page crops
// the picture to 1500x500 in the browser and sends it as a data URL; it is kept in the member's own row, the
// way the stored LinkedIn photo is (avatar.service.ts), and served by GET /api/users/:id/banner.
//
// The server is the gate whatever the page does: only a JPEG, PNG or WebP of at most 3 MB is kept, and only
// when its bytes really are that kind of picture, so nothing else is ever served under an image type.

import { query } from '../../db';
import config from '../../config';
import { NotFoundError, ValidationError } from '../../middleware/errors';

export const BANNER_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type BannerType = (typeof BANNER_TYPES)[number];
export const BANNER_MAX_BYTES = 3 * 1024 * 1024;
/** The longest data URL that can hold BANNER_MAX_BYTES: the base64 text plus room for the prefix. */
export const BANNER_MAX_DATA_URL_CHARS = Math.ceil(BANNER_MAX_BYTES / 3) * 4 + 64;
/**
 * The most pixels on either side. A file of 3 MB can still say it is enormous (a PNG of one colour compresses to
 * almost nothing), and every phone that opens the profile would have to decode it. The page sends 1500x500.
 */
export const BANNER_MAX_SIDE = 4096;

const WRONG_TYPE = 'Choose a JPG, PNG or WebP picture for your banner.';
const TOO_BIG = 'Your banner must be 3 MB or smaller.';
const NOT_A_PICTURE = 'That file is not a picture we can use. Choose a JPG, PNG or WebP picture.';
const TOO_MANY_PIXELS = 'Your banner can be at most 4096 by 4096 pixels.';

const DATA_URL = /^data:([^;,]*);base64,(.*)$/s;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

// How each kind of file begins. A WebP is a RIFF file whose form type, at byte 8, is WEBP.
const startsWith = (bytes: Buffer, head: number[], at = 0) => head.every((b, i) => bytes[at + i] === b);
const LOOKS_LIKE: Record<BannerType, (bytes: Buffer) => boolean> = {
  'image/jpeg': (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  'image/png': (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/webp': (b) => startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8),
};

const isBannerType = (mime: string): mime is BannerType => (BANNER_TYPES as readonly string[]).includes(mime);

interface Size { width: number; height: number }

// A PNG: the 8-byte signature, then the IHDR chunk (its length, "IHDR", then the width and height, big-endian).
function pngSize(b: Buffer): Size | null {
  if (b.length < 24 || b.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

// The JPEG markers whose segment is a frame header, which states the size: SOF0-3, 5-7, 9-11 and 13-15. C4 is a
// Huffman table, C8 is reserved and CC is an arithmetic-coding table, so none of those three is a frame.
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

// A JPEG: segments after the start (FF D8), each a marker FF xx and then a length that counts itself. The frame
// header's data is the precision, then the height and the width. The scan (FF DA) starts the picture itself, and a
// file that reaches it, or its end (FF D9), with no frame header before has stated no size.
function jpegSize(b: Buffer): Size | null {
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1];
    if (marker === 0xff) { at += 1; continue; } // a fill byte before the marker
    if (marker === 0xda || marker === 0xd9) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { at += 2; continue; } // markers with no length
    const length = b.readUInt16BE(at + 2);
    if (length < 2) return null;
    if (JPEG_FRAMES.has(marker)) {
      if (length < 7 || at + 9 > b.length) return null;
      return { width: b.readUInt16BE(at + 7), height: b.readUInt16BE(at + 5) };
    }
    at += 2 + length;
  }
  return null;
}

// A WebP: "RIFF", a size, "WEBP", then its first chunk, which is one of three kinds.
function webpSize(b: Buffer): Size | null {
  if (b.length < 30) return null;
  switch (b.toString('latin1', 12, 16)) {
    case 'VP8 ': // lossy: a 3-byte frame tag, the start code 9D 01 2A, then 14-bit width and height, little-endian
      if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
      return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    case 'VP8L': { // lossless: the signature 2F, then width - 1 and height - 1 in 14 bits each
      if (b[20] !== 0x2f) return null;
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    case 'VP8X': // extended: flags and three reserved bytes, then the canvas width - 1 and height - 1 in 24 bits each
      return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
    default:
      return null;
  }
}

/** The width and height a picture states in its own header, read without decoding it; null when it cannot be read. */
export function pictureSize(bytes: Buffer, mime: BannerType): Size | null {
  if (mime === 'image/png') return pngSize(bytes);
  if (mime === 'image/jpeg') return jpegSize(bytes);
  return webpSize(bytes);
}

/** The picture in a data URL, or a 400 that says in a sentence what is wrong with it. */
export function parseBannerImage(image: string): { bytes: Buffer; mime: BannerType } {
  const parts = DATA_URL.exec(image);
  if (!parts) throw new ValidationError(NOT_A_PICTURE);
  const [, mime, base64] = parts;
  if (!isBannerType(mime)) throw new ValidationError(WRONG_TYPE);
  if (base64.length % 4 !== 0 || !BASE64.test(base64)) throw new ValidationError(NOT_A_PICTURE);
  // The decoded size, worked out from the text before anything is decoded.
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  if ((base64.length / 4) * 3 - padding > BANNER_MAX_BYTES) throw new ValidationError(TOO_BIG);
  const bytes = Buffer.from(base64, 'base64');
  if (!LOOKS_LIKE[mime](bytes)) throw new ValidationError(NOT_A_PICTURE);
  const size = pictureSize(bytes, mime);
  if (!size || size.width < 1 || size.height < 1) throw new ValidationError(NOT_A_PICTURE);
  if (size.width > BANNER_MAX_SIDE || size.height > BANNER_MAX_SIDE) throw new ValidationError(TOO_MANY_PIXELS);
  return { bytes, mime };
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

/** Keep a member's new banner. Answers with its address. */
export async function saveBanner(userId: string, image: string): Promise<{ bannerUrl: string | null }> {
  const { bytes, mime } = parseBannerImage(image);
  const r = await query<{ banner_updated_at: Date }>(
    `UPDATE users SET banner_blob = $2, banner_mime = $3, banner_updated_at = NOW()
      WHERE id = $1
      RETURNING banner_updated_at`,
    [userId, bytes, mime],
  );
  const row = r.rows[0];
  if (!row) throw new NotFoundError('User', userId, 'This account is no longer available.');
  return { bannerUrl: bannerUrlFor(userId, row.banner_updated_at) };
}

/** Take a member's banner away. Their profile goes back to the default one. */
export async function removeBanner(userId: string): Promise<void> {
  const r = await query<{ id: string }>(
    `UPDATE users SET banner_blob = NULL, banner_mime = NULL, banner_updated_at = NULL WHERE id = $1 RETURNING id`,
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
