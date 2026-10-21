// ─── The member banner: what is accepted, where it is kept, and its address (21 Oct 2026) ─────────────
// The profile page crops the picture to 1500x500 in the browser and sends it as a data URL. The server is
// the gate all the same: only a real JPEG, PNG or WebP of at most 3 MB is kept, whatever the client claims.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), __esModule: true }));
const mockConfig = { apiBaseUrl: 'https://api.example.test' };
jest.mock('../../../config', () => ({ default: mockConfig, __esModule: true }));

import {
  BANNER_MAX_BYTES, BANNER_TYPES, bannerUrlFor, getBannerBlob, parseBannerImage, removeBanner, saveBanner,
} from '../../../services/user/banner.service';
import { AppError } from '../../../middleware/errors';

const MAGIC: Record<string, number[]> = {
  'image/jpeg': [0xff, 0xd8, 0xff, 0xe0],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  // RIFF, a size, then WEBP
  'image/webp': [0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50],
};
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];

/** A file of `size` bytes that starts the way a real `kind` file does. */
const picture = (kind: string, size = 64) => {
  const head = MAGIC[kind] ?? GIF;
  const bytes = Buffer.alloc(Math.max(size, head.length), 7);
  Buffer.from(head).copy(bytes);
  return bytes;
};
const dataUrl = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString('base64')}`;

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
