// Picture files for the banner tests: real headers (the size each format states), then filler up to `size` bytes.
// The server reads the width and height from these headers, so a test picture has to carry them the way a real one does.

const pad = (head: Buffer, size: number) => {
  const bytes = Buffer.alloc(Math.max(size, head.length), 0);
  head.copy(bytes);
  return bytes;
};
const u16be = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32be = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u16le = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u24le = (n: number) => { const b = Buffer.alloc(3); b.writeUIntLE(n, 0, 3); return b; };
const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const ascii = (s: string) => Buffer.from(s, 'latin1');

/** A PNG: the signature, then the IHDR chunk with the width and height. */
export function png(width: number, height: number, size = 64): Buffer {
  const ihdr = Buffer.concat([u32be(width), u32be(height), Buffer.from([8, 2, 0, 0, 0])]);
  return pad(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32be(13), ascii('IHDR'), ihdr, u32be(0)]), size);
}

/** A segment of a JPEG: the marker, then the length (which counts itself) and the data. */
const segment = (marker: number, data: Buffer) => Buffer.concat([Buffer.from([0xff, marker]), u16be(data.length + 2), data]);

/**
 * A JPEG: SOI, an APP0 (JFIF) and a Huffman table first, as real files have them before the frame header, then the
 * frame header (`sof`, baseline C0 by default) with the height and width.
 */
export function jpeg(width: number, height: number, size = 64, opts: { sof?: number; before?: Buffer[] } = {}): Buffer {
  const app0 = segment(0xe0, Buffer.concat([ascii('JFIF\0'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])]));
  const dht = segment(0xc4, Buffer.alloc(20, 1));
  const frame = segment(opts.sof ?? 0xc0, Buffer.concat([Buffer.from([8]), u16be(height), u16be(width), Buffer.from([1, 1, 0x11, 0])]));
  return pad(Buffer.concat([Buffer.from([0xff, 0xd8]), ...(opts.before ?? [app0, dht]), frame, segment(0xda, Buffer.alloc(10))]), size);
}

/** A JPEG that never states its size: no frame header before the scan. */
export function jpegWithoutFrame(size = 64): Buffer {
  return pad(Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xe0, Buffer.alloc(14)), segment(0xda, Buffer.alloc(10))]), size);
}

const riff = (chunk: string, data: Buffer, size: number) =>
  pad(Buffer.concat([ascii('RIFF'), u32le(4 + 8 + data.length), ascii('WEBP'), ascii(chunk), u32le(data.length), data]), size);

/** A lossy WebP ("VP8 "): a frame tag, the start code 9D 01 2A, then 14-bit width and height. */
export function webpLossy(width: number, height: number, size = 64): Buffer {
  return riff('VP8 ', Buffer.concat([Buffer.from([0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a]), u16le(width), u16le(height)]), size);
}

/** A lossless WebP ("VP8L"): the signature 2F, then width - 1 and height - 1 in 14 bits each. */
export function webpLossless(width: number, height: number, size = 64): Buffer {
  return riff('VP8L', Buffer.concat([Buffer.from([0x2f]), u32le(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14))]), size);
}

/** An extended WebP ("VP8X"): flags, three reserved bytes, then the canvas width - 1 and height - 1 in 24 bits each. */
export function webpExtended(width: number, height: number, size = 64): Buffer {
  return riff('VP8X', Buffer.concat([Buffer.from([0, 0, 0, 0]), u24le(width - 1), u24le(height - 1)]), size);
}

export const dataUrl = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString('base64')}`;
