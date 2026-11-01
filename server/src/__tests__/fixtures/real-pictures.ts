// Real pictures for the picture tests (30 Oct review, T3a). The server now opens a picture to cut it, so a test picture
// has to be one a decoder can open: these are made with sharp itself, from plain colours, so a test can tell which part
// of a picture was kept by the colour it reads back.
import sharp from 'sharp';

type Rgb = [number, number, number];
export const RED: Rgb = [220, 30, 30];
export const BLUE: Rgb = [30, 30, 220];
export const WHITE: Rgb = [255, 255, 255];

type Format = 'jpeg' | 'png' | 'webp';

const encode = (img: sharp.Sharp, format: Format) =>
  (format === 'jpeg' ? img.jpeg({ quality: 95 }) : format === 'png' ? img.png() : img.webp({ quality: 95 })).toBuffer();

/** A picture of one colour. */
export function solid(width: number, height: number, color: Rgb = RED, format: Format = 'jpeg'): Promise<Buffer> {
  return encode(sharp({ create: { width, height, channels: 3, background: { r: color[0], g: color[1], b: color[2] } } }), format);
}

/** A picture whose left half is one colour and right half another, stored with an EXIF orientation when given. */
export async function halves(width: number, height: number, left: Rgb, right: Rgb, opts: { format?: Format; orientation?: number } = {}): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const c = x < width / 2 ? left : right;
      raw.set(c, (y * width + x) * 3);
    }
  }
  let img = sharp(raw, { raw: { width, height, channels: 3 } });
  if (opts.orientation) img = img.withMetadata({ orientation: opts.orientation });
  return encode(img, opts.format ?? 'jpeg');
}

/** A PNG that is see-through everywhere. */
export function clear(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
}

/** A picture's width, height and format, read by opening it. */
export async function sizeOf(bytes: Buffer): Promise<{ width: number; height: number; format: string }> {
  const m = await sharp(bytes).metadata();
  return { width: m.width ?? 0, height: m.height ?? 0, format: m.format ?? '' };
}

/** The colour at a point of a picture. */
export async function colourAt(bytes: Buffer, x: number, y: number): Promise<Rgb> {
  const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * info.channels;
  return [data[at], data[at + 1], data[at + 2]];
}

/** True when two colours are the same to the eye (JPEG moves a colour by a few steps). */
export const near = (a: Rgb, b: Rgb, by = 24) => a.every((v, i) => Math.abs(v - b[i]) <= by);
