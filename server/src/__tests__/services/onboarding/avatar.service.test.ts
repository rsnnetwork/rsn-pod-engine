// ─── Avatar capture/serve — service tests ────────────────────────────────────
// captureAvatar downloads a LinkedIn CDN photo once and stores it so we never
// depend on LinkedIn's expiring URL again. Guards: 10s timeout, max 2MB
// (enforced while reading — a lying Content-Length header must not bypass
// it), content-type must be image/*. Any guard failure returns false, logs,
// and writes nothing (D2: avatar_url is only overwritten on a successful
// capture — a failed download must never clobber an existing avatar).
// getAvatarBlob is the read side the serving route (GET /users/:id/avatar)
// uses — null when nothing has been captured yet.

const mockQuery = jest.fn();
const mockConfig = { apiBaseUrl: 'https://api.example.com' };

jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  __esModule: true,
}));

jest.mock('../../../config', () => ({
  default: mockConfig,
  __esModule: true,
}));

jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import logger from '../../../config/logger';
import { avatarUrlFor, captureAvatar, getAvatarBlob } from '../../../services/onboarding/avatar.service';

const USER_ID = 'user-abc';
const PHOTO_URL = 'https://cdn.example.com/jane.jpg';

/** A minimal fetch-like Response whose body is a real web ReadableStream of
 *  the given bytes, chunked so the mid-stream size guard has something to
 *  enforce (a single chunk covering the whole payload wouldn't exercise it). */
function mockImageResponse(status: number, contentType: string | null, bytes: Uint8Array, chunkSize = 8192): Response {
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const next = bytes.slice(offset, offset + chunkSize);
      offset += chunkSize;
      controller.enqueue(next);
    },
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    body,
  } as unknown as Response;
}

describe('captureAvatar', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockConfig.apiBaseUrl = 'https://api.example.com';
  });

  it('happy path: stores the blob + content-type and sets avatar_url to an ABSOLUTE serving endpoint', async () => {
    const bytes = new TextEncoder().encode('fake-jpeg-bytes');
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockImageResponse(200, 'image/jpeg', bytes));

    const result = await captureAvatar(USER_ID, PHOTO_URL);

    expect(result).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE users/i);
    expect(sql).toMatch(/avatar_blob/i);
    expect(sql).toMatch(/avatar_blob_type/i);
    expect(sql).toMatch(/avatar_url/i);
    expect(params).toContain(USER_ID);
    expect(params).toContain('image/jpeg');
    // Absolute, not relative — a relative `/api/...` resolves against the
    // Vercel client origin (no API there) and renders a broken image.
    expect(params).toContain(`https://api.example.com/api/users/${USER_ID}/avatar`);
    const blobParam = params.find((p: unknown) => Buffer.isBuffer(p)) as Buffer;
    expect(blobParam.toString('utf8')).toBe('fake-jpeg-bytes');
  });

  it('D2: overwrites avatar_url unconditionally on success, even if a non-LinkedIn (e.g. Google) avatar_url already exists', async () => {
    // captureAvatar doesn't need to read the prior avatar_url at all — D2 says
    // LinkedIn wins on any successful capture, so the write is unconditional.
    const bytes = new TextEncoder().encode('jpeg');
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockImageResponse(200, 'image/jpeg', bytes));

    const result = await captureAvatar(USER_ID, PHOTO_URL);

    expect(result).toBe(true);
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toContain(`https://api.example.com/api/users/${USER_ID}/avatar`);
  });

  it('download failure (non-2xx status): returns false, logs, writes nothing', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
      headers: { get: () => null },
      body: null,
    } as unknown as Response);

    const result = await captureAvatar(USER_ID, PHOTO_URL);

    expect(result).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('network failure (fetch rejects): returns false, logs, writes nothing', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'));

    const result = await captureAvatar(USER_ID, PHOTO_URL);

    expect(result).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('non-image content-type is rejected: returns false, writes nothing', async () => {
    const bytes = new TextEncoder().encode('<html>not a photo</html>');
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockImageResponse(200, 'text/html', bytes));

    const result = await captureAvatar(USER_ID, PHOTO_URL);

    expect(result).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('missing content-type header is rejected (not image/*): returns false, writes nothing', async () => {
    const bytes = new TextEncoder().encode('bytes');
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockImageResponse(200, null, bytes));

    const result = await captureAvatar(USER_ID, PHOTO_URL);

    expect(result).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('>2MB is rejected mid-stream (enforced while reading, not just via a Content-Length header): returns false, writes nothing', async () => {
    const bytes = new Uint8Array(2 * 1024 * 1024 + 1024); // just over the 2MB guard
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockImageResponse(200, 'image/jpeg', bytes, 64 * 1024));

    const result = await captureAvatar(USER_ID, PHOTO_URL);

    expect(result).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('exactly at the 2MB boundary is accepted (guard is ">", not ">=")', async () => {
    const bytes = new Uint8Array(2 * 1024 * 1024); // exactly 2MB
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(mockImageResponse(200, 'image/jpeg', bytes, 64 * 1024));

    const result = await captureAvatar(USER_ID, PHOTO_URL);

    expect(result).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('timeout is mapped to false (no throw escapes captureAvatar)', async () => {
    // Mirrors what AbortSignal.timeout() produces on the real fetch: an
    // AbortError-shaped rejection once the signal fires.
    const timeoutErr = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(timeoutErr);

    const result = await captureAvatar(USER_ID, PHOTO_URL);

    expect(result).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('never throws even on a totally unexpected error shape', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue('not even an Error instance');

    await expect(captureAvatar(USER_ID, PHOTO_URL)).resolves.toBe(false);
  });
});

describe('avatarUrlFor', () => {
  afterEach(() => {
    mockConfig.apiBaseUrl = 'https://api.example.com';
  });

  it('joins an absolute base with no double slash, even when the base has a trailing slash', () => {
    mockConfig.apiBaseUrl = 'https://api.example.com/';
    expect(avatarUrlFor(USER_ID)).toBe(`https://api.example.com/api/users/${USER_ID}/avatar`);
  });

  it('joins an absolute base with no trailing slash cleanly', () => {
    mockConfig.apiBaseUrl = 'https://api.example.com';
    expect(avatarUrlFor(USER_ID)).toBe(`https://api.example.com/api/users/${USER_ID}/avatar`);
  });

  it('falls back to the relative path when the configured base is empty (local dev without API_BASE_URL set)', () => {
    mockConfig.apiBaseUrl = '';
    expect(avatarUrlFor(USER_ID)).toBe(`/api/users/${USER_ID}/avatar`);
  });
});

describe('getAvatarBlob', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('returns the blob + content-type when present', async () => {
    const blob = Buffer.from('jpeg-bytes');
    mockQuery.mockResolvedValueOnce({ rows: [{ avatar_blob: blob, avatar_blob_type: 'image/jpeg' }], rowCount: 1 });

    const result = await getAvatarBlob(USER_ID);

    expect(result).toEqual({ blob, contentType: 'image/jpeg' });
  });

  it('returns null when no row exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await getAvatarBlob(USER_ID);
    expect(result).toBeNull();
  });

  it('returns null when the row exists but no avatar has been captured yet', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ avatar_blob: null, avatar_blob_type: null }], rowCount: 1 });
    const result = await getAvatarBlob(USER_ID);
    expect(result).toBeNull();
  });
});
