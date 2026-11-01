// ─── A picture a member sends, checked before anything opens it (21 Oct 2026; shared with the photo 30 Oct) ──────
//
// The banner's gate, now the photo's too (30 Oct review, T3a): only a JPEG, PNG or WebP of at most 3 MB and at most
// 4096 pixels a side is kept, and only when its bytes really are that kind of picture, so nothing else is ever opened
// or served under an image type. Each refusal is a sentence that names the picture it is about.

import type { PictureKind } from '@rsn/shared';
import { ValidationError } from '../../middleware/errors';

export const PICTURE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type PictureType = (typeof PICTURE_TYPES)[number];
export const PICTURE_MAX_BYTES = 3 * 1024 * 1024;
/** The longest data URL that can hold PICTURE_MAX_BYTES: the base64 text plus room for the prefix. */
export const PICTURE_MAX_DATA_URL_CHARS = Math.ceil(PICTURE_MAX_BYTES / 3) * 4 + 64;
/**
 * The most pixels on either side. A file of 3 MB can still say it is enormous (a PNG of one colour compresses to
 * almost nothing), and the server opens it to cut it.
 */
export const PICTURE_MAX_SIDE = 4096;

const NAME: Record<PictureKind, string> = { avatar: 'photo', banner: 'banner' };
export const NOT_A_PICTURE = 'That file is not a picture we can use. Choose a JPG, PNG or WebP picture.';
export const pictureWords = (kind: PictureKind) => ({
  wrongType: `Choose a JPG, PNG or WebP picture for your ${NAME[kind]}.`,
  tooBig: `Your ${NAME[kind]} must be 3 MB or smaller.`,
  tooManyPixels: `Your ${NAME[kind]} can be at most 4096 by 4096 pixels.`,
});

// A data URL holds up to 4 MB of base64, and Node 20's pattern engine has run out of stack reading one that long
// (CI, 21 Oct 2026), so its text is read with plain string steps, never a pattern.
const DATA_URL_START = 'data:';
const BASE64_MARK = ';base64,';

/** The type and the base64 text of a data URL, or null when it is not one; the type holds no ";" or ",". */
function splitDataUrl(image: string): { mime: string; base64: string } | null {
  if (!image.startsWith(DATA_URL_START)) return null;
  const mark = image.indexOf(BASE64_MARK);
  if (mark < 0) return null;
  const mime = image.slice(DATA_URL_START.length, mark);
  if (mime.includes(';') || mime.includes(',')) return null;
  return { mime, base64: image.slice(mark + BASE64_MARK.length) };
}

const isBase64Letter = (c: number) =>
  (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2f;

/** True for base64 as browsers write it: groups of four, A-Z a-z 0-9 + and /, then at most two "=" at the end. */
function isBase64Text(text: string): boolean {
  if (text.length === 0 || text.length % 4 !== 0) return false;
  const end = text.endsWith('==') ? text.length - 2 : text.endsWith('=') ? text.length - 1 : text.length;
  for (let i = 0; i < end; i += 1) if (!isBase64Letter(text.charCodeAt(i))) return false;
  return true;
}

// How each kind of file begins. A WebP is a RIFF file whose form type, at byte 8, is WEBP.
const startsWith = (bytes: Buffer, head: number[], at = 0) => head.every((b, i) => bytes[at + i] === b);
const LOOKS_LIKE: Record<PictureType, (bytes: Buffer) => boolean> = {
  'image/jpeg': (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  'image/png': (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/webp': (b) => startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8),
};

const isPictureType = (mime: string): mime is PictureType => (PICTURE_TYPES as readonly string[]).includes(mime);

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
export function pictureSize(bytes: Buffer, mime: PictureType): Size | null {
  if (mime === 'image/png') return pngSize(bytes);
  if (mime === 'image/jpeg') return jpegSize(bytes);
  return webpSize(bytes);
}

/** The picture in a data URL, or a 400 that says in a sentence what is wrong with it. */
export function parsePicture(image: string, kind: PictureKind): { bytes: Buffer; mime: PictureType } {
  const words = pictureWords(kind);
  const parts = splitDataUrl(image);
  if (!parts) throw new ValidationError(NOT_A_PICTURE);
  const { mime, base64 } = parts;
  if (!isPictureType(mime)) throw new ValidationError(words.wrongType);
  if (!isBase64Text(base64)) throw new ValidationError(NOT_A_PICTURE);
  // The decoded size, worked out from the text before anything is decoded.
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  if ((base64.length / 4) * 3 - padding > PICTURE_MAX_BYTES) throw new ValidationError(words.tooBig);
  const bytes = Buffer.from(base64, 'base64');
  if (!LOOKS_LIKE[mime](bytes)) throw new ValidationError(NOT_A_PICTURE);
  const size = pictureSize(bytes, mime);
  if (!size || size.width < 1 || size.height < 1) throw new ValidationError(NOT_A_PICTURE);
  if (size.width > PICTURE_MAX_SIDE || size.height > PICTURE_MAX_SIDE) throw new ValidationError(words.tooManyPixels);
  return { bytes, mime };
}
