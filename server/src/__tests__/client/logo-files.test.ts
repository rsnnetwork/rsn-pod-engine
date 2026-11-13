// server/src/__tests__/client/logo-files.test.ts
//
// 1 Nov 2026 (30 Oct review 8.1, "wrong logo on preview"). The top-left mark and the lockup had been made by growing
// the official sheep's outline on a canvas that was not enlarged, so the sheep was cut flat on all four sides (85
// opaque pixels on the mark's top row, 109 on its right column) and its fill was #111216, not black. Every logo file
// is now the official sheep (OFFICIAL_LOGO_REFERENCE.png) downscaled as it is, with a margin on every side, plus the
// word REASON. These read the PNG files themselves: nothing may touch an edge, the sheep is pure black, and the app
// icons are square with the sheep inside the part a launcher keeps.

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

const PUBLIC = path.join(__dirname, '../../../../client/public');

interface Png { width: number; height: number; rgba: Buffer }

/** Decode an 8-bit RGBA or RGB, non-interlaced PNG (what the logo files are) into RGBA bytes. */
function readPng(name: string): Png {
  return decodePng(fs.readFileSync(path.join(PUBLIC, name)));
}

/** The frames of an .ico whose images are stored as PNG (how favicon.ico is written). */
function readIcoFrames(name: string): Png[] {
  const file = fs.readFileSync(path.join(PUBLIC, name));
  expect(file.readUInt16LE(2)).toBe(1); // an icon, not a cursor
  const frames: Png[] = [];
  for (let i = 0; i < file.readUInt16LE(4); i++) {
    const entry = 6 + i * 16;
    const size = file.readUInt32LE(entry + 8);
    const offset = file.readUInt32LE(entry + 12);
    frames.push(decodePng(file.subarray(offset, offset + size)));
  }
  return frames;
}

function decodePng(file: Buffer): Png {
  expect(file.subarray(1, 4).toString('ascii')).toBe('PNG');
  let offset = 8;
  let width = 0; let height = 0; let colorType = 0;
  const idat: Buffer[] = [];
  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.subarray(offset + 4, offset + 8).toString('ascii');
    const data = file.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      expect(data[8]).toBe(8); // bit depth
      colorType = data[9];
      expect(data[12]).toBe(0); // not interlaced
    } else if (type === 'IDAT') idat.push(data);
    offset += 12 + length;
  }
  expect([2, 6]).toContain(colorType);
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x];
      const left = x >= channels ? out[y * stride + x - channels] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const upLeft = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left); const pb = Math.abs(p - up); const pc = Math.abs(p - upLeft);
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      out[y * stride + x] = (value + predicted) & 0xff;
    }
  }
  if (channels === 4) return { width, height, rgba: out };
  const rgba = Buffer.alloc(width * height * 4, 255);
  for (let i = 0; i < width * height; i++) out.copy(rgba, i * 4, i * 3, i * 3 + 3);
  return { width, height, rgba };
}

const pixel = (png: Png, x: number, y: number) => {
  const i = (y * png.width + x) * 4;
  return { r: png.rgba[i], g: png.rgba[i + 1], b: png.rgba[i + 2], a: png.rgba[i + 3] };
};
/** Is this pixel part of the artwork: not transparent, and not the white ground of an icon. */
const isArt = (p: { r: number; g: number; b: number; a: number }) => p.a > 0 && !(p.r > 245 && p.g > 245 && p.b > 245);

/** How many artwork pixels lie on each edge. The bug was dozens; a clean file has none. */
function edgeArt(png: Png) {
  let top = 0; let bottom = 0; let left = 0; let right = 0;
  for (let x = 0; x < png.width; x++) { if (isArt(pixel(png, x, 0))) top++; if (isArt(pixel(png, x, png.height - 1))) bottom++; }
  for (let y = 0; y < png.height; y++) { if (isArt(pixel(png, 0, y))) left++; if (isArt(pixel(png, png.width - 1, y))) right++; }
  return { top, right, bottom, left };
}

/** The box the artwork fills. */
function artBox(png: Png) {
  let minX = png.width; let minY = png.height; let maxX = -1; let maxY = -1;
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
    if (!isArt(pixel(png, x, y))) continue;
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

const NONE = { top: 0, right: 0, bottom: 0, left: 0 };

describe('the in-app mark (reason-mark-small.png)', () => {
  const png = readPng('reason-mark-small.png');

  it('keeps its 480x365 shape (the 40x30 and 34x26 boxes)', () => {
    expect({ width: png.width, height: png.height }).toEqual({ width: 480, height: 365 });
  });

  it('is not cut at any edge: a transparent margin all round, and the sheep still fills the box', () => {
    expect(edgeArt(png)).toEqual(NONE);
    const box = artBox(png);
    expect(box.minX).toBeGreaterThanOrEqual(4);
    expect(box.minY).toBeGreaterThanOrEqual(4);
    expect(png.width - 1 - box.maxX).toBeGreaterThanOrEqual(4);
    expect(png.height - 1 - box.maxY).toBeGreaterThanOrEqual(4);
    expect((box.maxX - box.minX) / png.width).toBeGreaterThan(0.9);
  });

  it('is the official sheep: pure black, not the redrawn #111216', () => {
    const counts = new Map<string, number>();
    for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
      const p = pixel(png, x, y);
      if (p.a === 255 && isArt(p)) counts.set(`${p.r},${p.g},${p.b}`, (counts.get(`${p.r},${p.g},${p.b}`) ?? 0) + 1);
    }
    const commonest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    expect(commonest).toBe('0,0,0');
    expect(counts.get('17,18,22') ?? 0).toBe(0);
  });
});

describe('the lockup on the sign-in page and in every email (reason-logo.png)', () => {
  const png = readPng('reason-logo.png');

  it('keeps its 1056x228 shape, so the 204x44 sign-in box and the 160x35 email box still fit it', () => {
    expect({ width: png.width, height: png.height }).toEqual({ width: 1056, height: 228 });
  });

  it('is not cut at any edge', () => {
    expect(edgeArt(png)).toEqual(NONE);
  });
});

// 14 Nov 2026 (Stefan): the browser-tab icon has no white square behind the sheep. Only the ground outside the sheep is
// transparent; the face inside the outline stays white. The home-screen icons keep their white ground: iOS fills a
// transparent apple-touch-icon with black (a black sheep would vanish) and a maskable icon must fill its square.
const FACE = { x: 0.115, y: 0.47 }; // a point inside the sheep's white face, as a fraction of the square
const TRANSPARENT = { r: 0, g: 0, b: 0, a: 0 };

describe('the browser-tab favicons', () => {
  it.each([['favicon.png', 32], ['favicon-64.png', 64], ['favicon-192.png', 192]])(
    '%s is a %ipx square with a transparent ground, a white face, and the sheep clear of every edge',
    (name, size) => {
      const png = readPng(name);
      expect({ width: png.width, height: png.height }).toEqual({ width: size, height: size });
      for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) expect(pixel(png, x, y)).toEqual(TRANSPARENT);
      expect(edgeArt(png)).toEqual(NONE);
      if (size >= 64) {
        const face = pixel(png, Math.round(FACE.x * size), Math.round(FACE.y * size));
        expect(face.a).toBe(255);
        expect(Math.min(face.r, face.g, face.b)).toBeGreaterThanOrEqual(245);
      }
    },
  );

  it('favicon.ico holds 16, 32 and 48px frames, each with a transparent ground', () => {
    const frames = readIcoFrames('favicon.ico');
    expect(frames.map((f) => f.width).sort((a, b) => a - b)).toEqual([16, 32, 48]);
    for (const frame of frames) {
      expect(frame.height).toBe(frame.width);
      expect(pixel(frame, 0, 0)).toEqual(TRANSPARENT);
      expect(pixel(frame, frame.width - 1, frame.height - 1)).toEqual(TRANSPARENT);
    }
  });
});

describe('the app icons', () => {
  it.each([
    ['apple-touch-icon.png', 180],
    ['icon-192.png', 192], ['icon-512.png', 512], ['icon-maskable-192.png', 192], ['icon-maskable-512.png', 512],
  ])('%s is a %ipx square with a white ground, the sheep clear of every edge', (name, size) => {
    const png = readPng(name);
    expect({ width: png.width, height: png.height }).toEqual({ width: size, height: size });
    expect(pixel(png, 0, 0)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
    expect(edgeArt(png)).toEqual(NONE);
  });

  it.each(['icon-maskable-192.png', 'icon-maskable-512.png'])('%s keeps the whole sheep inside the circle a launcher keeps (80%%)', (name) => {
    const png = readPng(name);
    const c = (png.width - 1) / 2;
    const r = png.width * 0.4;
    for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
      if (isArt(pixel(png, x, y))) expect(Math.hypot(x - c, y - c)).toBeLessThanOrEqual(r);
    }
  });

  it('the link preview picture is 1200x630', () => {
    const png = readPng('og-image.png');
    expect({ width: png.width, height: png.height }).toEqual({ width: 1200, height: 630 });
    expect(edgeArt(png)).toEqual(NONE);
  });
});
