// ─── The LinkedIn photo, offered — never applied for them (23 Sep 2026) ──────
//
// Shradha's deck: nothing reaches a profile unless the member confirms it. It
// came from Stefan's own test, where the LinkedIn match was the wrong person.
// So the scraped photo is only ever used when the member says "that's me".
//
// Two things these pin that matter more than they look:
//  - THE RACE. Ali's test account, 23 Sep: signed in 23s after approval, the
//    scrape took 25s, and the one-time copy onto the account found nothing.
//    The photo sat on the join request, never read again. It is looked for in
//    both places now, at the moment it is needed.
//  - NO CLIENT URL. The member only ever says yes. The server resolves their
//    OWN scraped photo, so this cannot put an arbitrary image — or somebody
//    else's face — on a profile.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), __esModule: true }));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockCapture = jest.fn();
jest.mock('../../../services/onboarding/avatar.service', () => ({
  captureAvatar: (...a: unknown[]) => mockCapture(...a),
  __esModule: true,
}));
const mockRecord = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../services/onboarding/stage-events.repo', () => ({
  record: (...a: unknown[]) => mockRecord(...a),
  __esModule: true,
}));

import { findLinkedinPhoto, useLinkedinPhoto } from '../../../services/onboarding/linkedin-photo';

const OWN = 'https://media.licdn.com/dms/image/own.jpg';
const PRELOAD = 'https://media.licdn.com/dms/image/preload.jpg';

beforeEach(() => { mockQuery.mockReset(); mockCapture.mockReset(); mockRecord.mockClear(); });

describe('findLinkedinPhoto — where the photo is looked for', () => {
  it('uses the photo already copied onto the member', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ url: OWN }] });
    await expect(findLinkedinPhoto('u1')).resolves.toBe(OWN);
    // Found on the account: the join request is not consulted.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('THE RACE: nothing on the account yet, so the approval-time scrape is used', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })             // copy-forward found nothing at sign-in
      .mockResolvedValueOnce({ rows: [{ url: PRELOAD }] }); // the scrape landed on the join request after
    await expect(findLinkedinPhoto('u1')).resolves.toBe(PRELOAD);
  });

  it('null when neither place has one', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await expect(findLinkedinPhoto('u1')).resolves.toBeNull();
  });

  it('only ever reads THIS member, and only a real match', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await findLinkedinPhoto('u1');
    const [ownSql, ownParams] = mockQuery.mock.calls[0];
    const [jrSql, jrParams] = mockQuery.mock.calls[1];
    expect(ownParams).toEqual(['u1']);
    expect(jrParams).toEqual(['u1']);
    // A zero-confidence scrape is "could not identify this person".
    expect(ownSql).toMatch(/confidence.*> 0/s);
    expect(jrSql).toMatch(/confidence.*> 0/s);
    // Only an APPROVED request, joined to this member by their own email.
    expect(jrSql).toMatch(/jr\.status = 'approved'/);
    expect(jrSql).toMatch(/lower\(u\.email\) = lower\(jr\.email\)/);
    expect(jrSql).toMatch(/u\.id = \$1/);
  });
});

describe('useLinkedinPhoto — "that\'s me"', () => {
  it('captures the photo WE resolved for them, and nothing else', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ url: PRELOAD }] });
    mockCapture.mockResolvedValue(true);
    await expect(useLinkedinPhoto('u1')).resolves.toBe('done');
    expect(mockCapture).toHaveBeenCalledWith('u1', PRELOAD);
    expect(mockRecord).toHaveBeenCalledWith('u1', 'photo_captured', { source: 'linkedin_confirmed' }, expect.any(Number));
  });

  it('it takes no URL at all — there is no way to pass one in', () => {
    // The signature is the guarantee: a member id and nothing else.
    expect(useLinkedinPhoto.length).toBe(1);
  });

  it("'none' when there is nothing to offer, and the photo is left untouched", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await expect(useLinkedinPhoto('u1')).resolves.toBe('none');
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("'failed' when the download does not work, recorded as such", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ url: OWN }] });
    mockCapture.mockResolvedValue(false);
    await expect(useLinkedinPhoto('u1')).resolves.toBe('failed');
    expect(mockRecord).toHaveBeenCalledWith('u1', 'photo_failed', { source: 'linkedin_confirmed' }, expect.any(Number));
  });
});
