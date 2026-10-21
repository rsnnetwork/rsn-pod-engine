// ─── The member banner: what is accepted, where it is kept, and its address (21 Oct 2026) ─────────────
// The profile page crops the picture to 1500x500 in the browser and sends it as a data URL. The server is
// the gate all the same: only a real JPEG, PNG or WebP of at most 3 MB is kept, whatever the client claims.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), __esModule: true }));
const mockConfig = { apiBaseUrl: 'https://api.example.test' };
jest.mock('../../../config', () => ({ default: mockConfig, __esModule: true }));

import {
  BANNER_MAX_BYTES, BANNER_MAX_SIDE, BANNER_TYPES, bannerUrlFor, getBannerBlob, parseBannerImage, pictureSize,
  removeBanner, saveBanner,
} from '../../../services/user/banner.service';
import { AppError } from '../../../middleware/errors';
import { dataUrl, jpeg, jpegWithoutFrame, png, webpExtended, webpLossless, webpLossy } from '../../fixtures/pictures';

const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];

/** A banner-sized file of `size` bytes, with the header a real `kind` file has. Anything else is a GIF's start. */
const picture = (kind: string, size = 64) => {
  if (kind === 'image/png') return png(1500, 500, size);
  if (kind === 'image/jpeg') return jpeg(1500, 500, size);
  if (kind === 'image/webp') return webpLossy(1500, 500, size);
  const bytes = Buffer.alloc(Math.max(size, GIF.length), 7);
  Buffer.from(GIF).copy(bytes);
  return bytes;
};

/** What parseBannerImage refused with: the status and the member's sentence. */
function refusal(image: string): { status: number; message: string } {
  try {
    parseBannerImage(image);
  } catch (err) {
    if (err instanceof AppError) return { status: err.statusCode, message: err.message };
    throw err;
  }
  throw new Error('parseBannerImage accepted it');
}

const WRONG_TYPE = 'Choose a JPG, PNG or WebP picture for your banner.';
const TOO_BIG = 'Your banner must be 3 MB or smaller.';
const NOT_A_PICTURE = 'That file is not a picture we can use. Choose a JPG, PNG or WebP picture.';

beforeEach(() => {
  mockQuery.mockReset();
  mockConfig.apiBaseUrl = 'https://api.example.test';
});

describe('parseBannerImage: the types', () => {
  it('accepts exactly JPEG, PNG and WebP', () => {
    expect([...BANNER_TYPES]).toEqual(['image/jpeg', 'image/png', 'image/webp']);
  });

  it.each(['image/jpeg', 'image/png', 'image/webp'])('keeps a real %s with its bytes and its type', (mime) => {
    const bytes = picture(mime, 300);
    const parsed = parseBannerImage(dataUrl(mime, bytes));
    expect(parsed.mime).toBe(mime);
    expect(Buffer.compare(parsed.bytes, bytes)).toBe(0);
  });

  it.each(['image/gif', 'image/svg+xml', 'image/bmp', 'image/avif', 'text/html', 'application/octet-stream'])(
    'refuses %s with a sentence a member can act on',
    (mime) => {
      expect(refusal(dataUrl(mime, picture('image/gif')))).toEqual({ status: 400, message: WRONG_TYPE });
    },
  );

  it('refuses a type it only spells differently ("image/jpg", capitals): the browser sends image/jpeg', () => {
    expect(refusal(dataUrl('image/jpg', picture('image/jpeg'))).message).toBe(WRONG_TYPE);
    expect(refusal(dataUrl('IMAGE/JPEG', picture('image/jpeg'))).message).toBe(WRONG_TYPE);
  });

  it('refuses a file whose bytes are not the type it claims (a GIF or a page called a JPEG)', () => {
    expect(refusal(dataUrl('image/jpeg', picture('image/gif')))).toEqual({ status: 400, message: NOT_A_PICTURE });
    expect(refusal(dataUrl('image/png', Buffer.from('<html><script>alert(1)</script></html>')))).toEqual({ status: 400, message: NOT_A_PICTURE });
    expect(refusal(dataUrl('image/webp', picture('image/png')))).toEqual({ status: 400, message: NOT_A_PICTURE });
  });

  it('refuses anything that is not a base64 data URL, and an empty one', () => {
    for (const image of [
      'https://example.com/banner.jpg',
      'data:image/jpeg,not-base64',
      'data:image/jpeg;base64,',
      'data:image/jpeg;base64,@@@@',
      `data:image/jpeg;base64,${picture('image/jpeg').toString('base64')} `,
      '',
    ]) {
      expect({ image, ...refusal(image) }).toEqual({ image, status: 400, message: expect.any(String) });
    }
  });
});

describe('parseBannerImage: the size, after decoding', () => {
  it('keeps a picture of exactly 3 MB', () => {
    expect(BANNER_MAX_BYTES).toBe(3 * 1024 * 1024);
    const parsed = parseBannerImage(dataUrl('image/jpeg', picture('image/jpeg', BANNER_MAX_BYTES)));
    expect(parsed.bytes.length).toBe(BANNER_MAX_BYTES);
  });

  it('refuses one byte more, though its base64 text is only a third longer', () => {
    expect(refusal(dataUrl('image/jpeg', picture('image/jpeg', BANNER_MAX_BYTES + 1)))).toEqual({ status: 400, message: TOO_BIG });
  });

  it('says it is too big before it says what is wrong with the bytes', () => {
    expect(refusal(dataUrl('image/png', picture('image/gif', BANNER_MAX_BYTES + 10))).message).toBe(TOO_BIG);
  });
});

// A 3 MB PNG or WebP can state an enormous size, and every phone that opens the profile would have to decode it.
// The size is read from the file's own header, without decoding anything.
describe('pictureSize: the width and height a picture states in its own header', () => {
  it('reads a PNG\'s IHDR', () => {
    expect(pictureSize(png(1500, 500), 'image/png')).toEqual({ width: 1500, height: 500 });
    expect(pictureSize(png(70_000, 3), 'image/png')).toEqual({ width: 70_000, height: 3 });
  });

  it('reads a JPEG\'s frame header past the segments before it (APP0 and a Huffman table, which is not a frame), whichever frame kind it is', () => {
    expect(pictureSize(jpeg(1500, 500), 'image/jpeg')).toEqual({ width: 1500, height: 500 });
    for (const sof of [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]) {
      expect({ sof, size: pictureSize(jpeg(640, 480, 64, { sof }), 'image/jpeg') }).toEqual({ sof, size: { width: 640, height: 480 } });
    }
  });

  it('steps over fill bytes between a JPEG\'s segments', () => {
    const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
    expect(pictureSize(jpeg(800, 600, 64, { before: [Buffer.from([0xff, 0xff]), app0] }), 'image/jpeg')).toEqual({ width: 800, height: 600 });
  });

  it('reads all three kinds of WebP: lossy, lossless and extended', () => {
    expect(pictureSize(webpLossy(1500, 500), 'image/webp')).toEqual({ width: 1500, height: 500 });
    expect(pictureSize(webpLossless(1500, 500), 'image/webp')).toEqual({ width: 1500, height: 500 });
    expect(pictureSize(webpExtended(1500, 500), 'image/webp')).toEqual({ width: 1500, height: 500 });
    expect(pictureSize(webpExtended(16_000, 9_000), 'image/webp')).toEqual({ width: 16_000, height: 9_000 });
  });

  it('gives nothing for a header it cannot read', () => {
    expect(pictureSize(jpegWithoutFrame(), 'image/jpeg')).toBeNull();
    expect(pictureSize(jpeg(1500, 500).subarray(0, 30), 'image/jpeg')).toBeNull();
    expect(pictureSize(png(1500, 500).subarray(0, 20), 'image/png')).toBeNull();
    const notIhdr = png(1500, 500);
    notIhdr.write('IDAT', 12, 'latin1');
    expect(pictureSize(notIhdr, 'image/png')).toBeNull();
    const noStartCode = webpLossy(1500, 500);
    noStartCode[23] = 0;
    expect(pictureSize(noStartCode, 'image/webp')).toBeNull();
    const otherChunk = webpLossy(1500, 500);
    otherChunk.write('ALPH', 12, 'latin1');
    expect(pictureSize(otherChunk, 'image/webp')).toBeNull();
    expect(pictureSize(webpLossy(1500, 500).subarray(0, 24), 'image/webp')).toBeNull();
  });
});

describe('parseBannerImage: at most 4096 pixels on a side', () => {
  const TOO_MANY_PIXELS = 'Your banner can be at most 4096 by 4096 pixels.';
  const kinds: Array<[string, string, (w: number, h: number) => Buffer]> = [
    ['a PNG', 'image/png', png], ['a JPEG', 'image/jpeg', jpeg], ['a lossy WebP', 'image/webp', webpLossy],
    ['a lossless WebP', 'image/webp', webpLossless], ['an extended WebP', 'image/webp', webpExtended],
  ];

  it('is 4096', () => {
    expect(BANNER_MAX_SIDE).toBe(4096);
  });

  it.each(kinds)('keeps %s of exactly 4096 by 4096, and refuses one pixel more either way, in a sentence', (_name, mime, make) => {
    expect(parseBannerImage(dataUrl(mime, make(4096, 4096))).mime).toBe(mime);
    expect(refusal(dataUrl(mime, make(4097, 500)))).toEqual({ status: 400, message: TOO_MANY_PIXELS });
    expect(refusal(dataUrl(mime, make(1500, 4097)))).toEqual({ status: 400, message: TOO_MANY_PIXELS });
  });

  it('refuses a picture whose size cannot be read, and one that says it has no pixels, as not a picture', () => {
    expect(refusal(dataUrl('image/jpeg', jpegWithoutFrame()))).toEqual({ status: 400, message: NOT_A_PICTURE });
    expect(refusal(dataUrl('image/png', png(0, 500)))).toEqual({ status: 400, message: NOT_A_PICTURE });
    expect(refusal(dataUrl('image/png', png(1500, 0)))).toEqual({ status: 400, message: NOT_A_PICTURE });
  });

  it('writes nothing for a picture that is too large', async () => {
    await expect(saveBanner('3f2b8a4e-1c9d-4e7a-b6f0-2a5c8d1e9f03', dataUrl('image/png', png(9000, 3000)))).rejects.toMatchObject({ statusCode: 400 });
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('bannerUrlFor: the address members load the banner from', () => {
  const ID = '3f2b8a4e-1c9d-4e7a-b6f0-2a5c8d1e9f03';
  const at = new Date('2026-10-21T09:30:00.123Z');

  it('is the API\'s own address with the time of the change, so a new banner is a new address', () => {
    expect(bannerUrlFor(ID, at)).toBe(`https://api.example.test/api/users/${ID}/banner?v=${at.getTime()}`);
    expect(bannerUrlFor(ID, new Date(at.getTime() + 1))).not.toBe(bannerUrlFor(ID, at));
  });

  it('is null when there is no banner', () => {
    expect(bannerUrlFor(ID, null)).toBeNull();
  });

  it('drops a trailing slash from the API address, and is relative when the API has no address set', () => {
    mockConfig.apiBaseUrl = 'https://api.example.test/';
    expect(bannerUrlFor(ID, at)).toBe(`https://api.example.test/api/users/${ID}/banner?v=${at.getTime()}`);
    mockConfig.apiBaseUrl = '';
    expect(bannerUrlFor(ID, at)).toBe(`/api/users/${ID}/banner?v=${at.getTime()}`);
  });
});

describe('saveBanner, removeBanner and getBannerBlob', () => {
  const ID = '3f2b8a4e-1c9d-4e7a-b6f0-2a5c8d1e9f03';

  it('keeps the bytes and the type, stamps the time in the database, and answers with the new address', async () => {
    const at = new Date('2026-10-21T10:00:00.000Z');
    mockQuery.mockResolvedValueOnce({ rows: [{ banner_updated_at: at }] });
    const bytes = picture('image/png', 500);
    const out = await saveBanner(ID, dataUrl('image/png', bytes));
    expect(out).toEqual({ bannerUrl: `https://api.example.test/api/users/${ID}/banner?v=${at.getTime()}` });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE users SET banner_blob = \$2, banner_mime = \$3, banner_updated_at = NOW\(\)/);
    expect(sql).toMatch(/WHERE id = \$1/);
    expect(sql).toMatch(/RETURNING banner_updated_at/);
    expect(params[0]).toBe(ID);
    expect(Buffer.compare(params[1], bytes)).toBe(0);
    expect(params[2]).toBe('image/png');
  });

  it('writes nothing for a refused picture', async () => {
    await expect(saveBanner(ID, dataUrl('image/gif', picture('image/gif')))).rejects.toThrow(WRONG_TYPE);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('says the member is gone when there is no row to keep it in', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(saveBanner(ID, dataUrl('image/jpeg', picture('image/jpeg')))).rejects.toMatchObject({ statusCode: 404 });
  });

  it('removes all three together, so "no banner" is one state', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: ID }] });
    await removeBanner(ID);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE users SET banner_blob = NULL, banner_mime = NULL, banner_updated_at = NULL WHERE id = \$1/);
    expect(params).toEqual([ID]);
  });

  it('a removal for a member who is gone is a 404', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(removeBanner(ID)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('reads the bytes and the type back, and nothing when either is missing', async () => {
    const blob = picture('image/webp', 40);
    mockQuery.mockResolvedValueOnce({ rows: [{ banner_blob: blob, banner_mime: 'image/webp' }] });
    expect(await getBannerBlob(ID)).toEqual({ blob, contentType: 'image/webp' });
    mockQuery.mockResolvedValueOnce({ rows: [{ banner_blob: null, banner_mime: null }] });
    expect(await getBannerBlob(ID)).toBeNull();
    mockQuery.mockResolvedValueOnce({ rows: [{ banner_blob: blob, banner_mime: null }] });
    expect(await getBannerBlob(ID)).toBeNull();
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getBannerBlob(ID)).toBeNull();
    expect(mockQuery.mock.calls[0][0]).toMatch(/SELECT banner_blob, banner_mime FROM users WHERE id = \$1/);
  });
});
