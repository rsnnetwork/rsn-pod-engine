import { jest } from '@jest/globals';
import { UserRole } from '@rsn/shared';

const mockQuery = jest.fn<any>();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), __esModule: true }));

const mockAccess = jest.fn<any>();
jest.mock('../../../services/post-event-message/event-organisers', () => ({
  getEventOrganiserAccess: (...a: unknown[]) => mockAccess(...a),
  __esModule: true,
}));

const mockCountAudience = jest.fn<any>();
jest.mock('../../../services/post-event-message/post-event-message.service', () => ({
  countAudience: (...a: unknown[]) => mockCountAudience(...a),
  __esModule: true,
}));

import {
  computeEligibility,
  computeEligibilityV2,
  getEligibilityV2ForEvent,
  type EligibilityV2Inputs,
} from '../../../services/post-event-message/broadcast-eligibility';

// ─── Version 1: unchanged. Production's client still asks this question. ───────

describe('computeEligibility', () => {
  it('admin: enabled + visible', () => {
    expect(computeEligibility({ role: UserRole.ADMIN, isPro: false, isDirector: false }))
      .toEqual({ enabled: true, visible: true, reason: 'admin' });
  });
  it('super_admin: enabled', () => {
    expect(computeEligibility({ role: UserRole.SUPER_ADMIN, isPro: false, isDirector: false }).enabled).toBe(true);
  });
  it('pro (no subscription system yet): visible but disabled, coming soon', () => {
    expect(computeEligibility({ role: UserRole.PRO, isPro: true, isDirector: false }))
      .toEqual({ enabled: false, visible: true, reason: 'pro_coming_soon' });
  });
  it('pod director: visible but disabled, coming soon', () => {
    expect(computeEligibility({ role: UserRole.MEMBER, isPro: false, isDirector: true }))
      .toEqual({ enabled: false, visible: true, reason: 'director_coming_soon' });
  });
  it('plain member: not visible', () => {
    expect(computeEligibility({ role: UserRole.MEMBER, isPro: false, isDirector: false }))
      .toEqual({ enabled: false, visible: false, reason: 'not_allowed' });
  });
});

// ─── Version 2: organisers and admins, after the event ends ────────────────────

const NONE = { tookPart: 0, registeredNoShow: 0 };

/** An organiser of a finished event with two people to reach, nothing sent and nothing running. */
function inputs(over: Partial<EligibilityV2Inputs> = {}): EligibilityV2Inputs {
  return {
    isOrganiser: true,
    eventCompleted: true,
    audience: { tookPart: 2, registeredNoShow: 1 },
    activeJob: null,
    recentSends: [],
    lastSent: null,
    timeZone: null,
    ...over,
  };
}

describe('computeEligibilityV2', () => {
  it('an organiser of a finished event with people to reach can send, and has nothing to be told', () => {
    expect(computeEligibilityV2(inputs())).toEqual({
      enabled: true,
      visible: true,
      reason: 'ok',
      explanation: '',
      audience: { tookPart: 2, registeredNoShow: 1 },
    });
  });

  it('someone who does not run the event sees nothing at all, and learns nothing about who came', () => {
    expect(computeEligibilityV2(inputs({ isOrganiser: false }))).toEqual({
      enabled: false,
      visible: false,
      reason: 'not_organiser',
      explanation: '',
      audience: NONE,
    });
  });

  it('before the event ends an organiser is told when they can (verbatim), with no counts', () => {
    expect(computeEligibilityV2(inputs({ eventCompleted: false }))).toEqual({
      enabled: false,
      visible: true,
      reason: 'not_ended',
      explanation: 'You can message everyone after the event ends.',
      audience: NONE,
    });
  });

  it('nobody else took part: says so (verbatim) even when some people registered and never came', () => {
    expect(computeEligibilityV2(inputs({ audience: { tookPart: 0, registeredNoShow: 4 } }))).toEqual({
      enabled: false,
      visible: true,
      reason: 'no_recipients',
      explanation: 'Nobody else took part in this event.',
      audience: { tookPart: 0, registeredNoShow: 4 },
    });
  });

  describe('a send is running', () => {
    it('says how far it is (verbatim): the ones sent and the ones that failed are both done', () => {
      const result = computeEligibilityV2(inputs({ activeJob: { total: 40, sent: 11, failed: 1 } }));
      expect(result).toMatchObject({
        enabled: false, visible: true, reason: 'sending', explanation: 'Sending… 12 of 40.',
      });
    });

    it('starts at 0 of the total', () => {
      expect(computeEligibilityV2(inputs({ activeJob: { total: 7, sent: 0, failed: 0 } })).explanation)
        .toBe('Sending… 0 of 7.');
    });

    it('wins over the limit and over an empty audience: it is what is true right now', () => {
      const third = [new Date('2026-10-26T08:00:00Z'), new Date('2026-10-26T09:00:00Z'), new Date('2026-10-26T10:00:00Z')];
      expect(computeEligibilityV2(inputs({
        activeJob: { total: 5, sent: 1, failed: 0 }, recentSends: third, audience: NONE,
      })).reason).toBe('sending');
    });
  });

  describe('the limit of 3 sends per event per sender in 24 hours', () => {
    const t1 = new Date('2026-10-25T14:20:00Z');
    const t2 = new Date('2026-10-25T18:00:00Z');
    const t3 = new Date('2026-10-25T19:00:00Z');

    it('two sends still leave one', () => {
      expect(computeEligibilityV2(inputs({ recentSends: [t1, t2] })).reason).toBe('ok');
    });

    it('the third send uses the last one: the next may go 24 hours after the OLDEST (verbatim sentence, UTC without a zone)', () => {
      const result = computeEligibilityV2(inputs({ recentSends: [t1, t2, t3] }));
      expect(result).toMatchObject({
        enabled: false, visible: true, reason: 'limit',
        explanation: 'You can send another message at 14:20.',
        nextSendAt: '2026-10-26T14:20:00.000Z',
      });
    });

    it('writes the time in the sender\'s own zone, so the sentence is true on their clock', () => {
      // 26 Oct 2026 is after Europe's clocks went back (25 Oct): Berlin is UTC+1. New York is still on summer time.
      expect(computeEligibilityV2(inputs({ recentSends: [t1, t2, t3], timeZone: 'Europe/Berlin' })).explanation)
        .toBe('You can send another message at 15:20.');
      expect(computeEligibilityV2(inputs({ recentSends: [t1, t2, t3], timeZone: 'America/New_York' })).explanation)
        .toBe('You can send another message at 10:20.');
    });

    it('still gives the instant in UTC, whatever zone the sentence uses', () => {
      expect(computeEligibilityV2(inputs({ recentSends: [t1, t2, t3], timeZone: 'Europe/Berlin' })).nextSendAt)
        .toBe('2026-10-26T14:20:00.000Z');
    });

    it('falls back to UTC when the stored zone is not one the platform knows', () => {
      expect(computeEligibilityV2(inputs({ recentSends: [t1, t2, t3], timeZone: 'Not/AZone' })).explanation)
        .toBe('You can send another message at 14:20.');
    });

    it('writes midnight as 00:05, never 24:05', () => {
      const a = new Date('2026-10-25T00:05:00Z');
      expect(computeEligibilityV2(inputs({ recentSends: [a, t2, t3] })).explanation)
        .toBe('You can send another message at 00:05.');
    });

    it('with more than three on record (it cannot happen, but) it waits until only two remain', () => {
      const t0 = new Date('2026-10-25T10:00:00Z');
      const result = computeEligibilityV2(inputs({ recentSends: [t0, t1, t2, t3] }));
      expect(result.nextSendAt).toBe('2026-10-26T14:20:00.000Z'); // t1 + 24h, not t0 + 24h
    });

    it('is checked after an empty audience: with nobody to reach, the limit is not the news', () => {
      expect(computeEligibilityV2(inputs({ recentSends: [t1, t2, t3], audience: NONE })).reason).toBe('no_recipients');
    });
  });

  it('reports the latest send that reached anyone, as an ISO instant, whatever else is true', () => {
    const lastSent = { at: new Date('2026-10-25T16:45:00Z'), recipients: 12 };
    expect(computeEligibilityV2(inputs({ lastSent })).lastSent).toEqual({ at: '2026-10-25T16:45:00.000Z', recipients: 12 });
    expect(computeEligibilityV2(inputs({ lastSent, activeJob: { total: 3, sent: 0, failed: 0 } })).lastSent)
      .toEqual({ at: '2026-10-25T16:45:00.000Z', recipients: 12 });
  });

  it('leaves lastSent out when nothing was ever sent, and never shows it to a non-organiser', () => {
    expect(computeEligibilityV2(inputs())).not.toHaveProperty('lastSent');
    const lastSent = { at: new Date('2026-10-25T16:45:00Z'), recipients: 12 };
    expect(computeEligibilityV2(inputs({ isOrganiser: false, lastSent }))).not.toHaveProperty('lastSent');
  });
});

// ─── Reading the inputs for a real person and a real event ─────────────────────

const SESSION = 'aaaabbbb-0000-0000-0000-000000000001';

function access(over: Record<string, unknown> = {}) {
  return {
    status: 'completed',
    isHost: false, isCohost: false, isPodOrganiser: false, isAdmin: false,
    isOrganiser: true,
    timeZone: null,
    ...over,
  };
}

/** Answer the three job lookups by what they ask. */
function jobs(opts: {
  active?: Record<string, unknown> | null;
  recent?: Date[];
  last?: { sent_count: number; sent_at: Date } | null;
} = {}) {
  mockQuery.mockImplementation(async (sql: unknown) => {
    const s = String(sql).replace(/\s+/g, ' ');
    if (/status IN \('pending', 'processing'\)/.test(s)) return { rows: opts.active ? [opts.active] : [] };
    if (/created_by = \$2/.test(s)) return { rows: (opts.recent ?? []).map((created_at) => ({ created_at })) };
    if (/sent_count > 0/.test(s)) return { rows: opts.last ? [opts.last] : [] };
    throw new Error(`unexpected query: ${s}`);
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockAccess.mockReset();
  mockCountAudience.mockReset();
  mockCountAudience.mockResolvedValue({ tookPart: 1, registeredNoShow: 0 });
});

describe('getEligibilityV2ForEvent', () => {
  it('Claus on 25 Oct: a plain member who hosts the event and directs its pod can send once it has ended, to the one other person who took part', async () => {
    mockAccess.mockResolvedValue(access({ isHost: true, isPodOrganiser: true }));
    jobs();

    const result = await getEligibilityV2ForEvent('claus', UserRole.MEMBER, SESSION);

    expect(result).toEqual({
      enabled: true, visible: true, reason: 'ok', explanation: '',
      audience: { tookPart: 1, registeredNoShow: 0 },
    });
    expect(mockAccess).toHaveBeenCalledWith('claus', UserRole.MEMBER, SESSION);
    expect(mockCountAudience).toHaveBeenCalledWith(SESSION, 'claus');
  });

  it('the pro plan is no longer part of the question: a free or pro member who organises is enabled alike', async () => {
    mockAccess.mockResolvedValue(access({ isCohost: true }));
    jobs();
    expect((await getEligibilityV2ForEvent('u', UserRole.FREE, SESSION)).enabled).toBe(true);
    expect((await getEligibilityV2ForEvent('u', UserRole.PRO, SESSION)).enabled).toBe(true);
  });

  it('a platform admin with no tie to the event can send', async () => {
    mockAccess.mockResolvedValue(access({ isAdmin: true }));
    jobs();
    expect((await getEligibilityV2ForEvent('stefan', UserRole.SUPER_ADMIN, SESSION)).reason).toBe('ok');
  });

  it('a plain participant is invisible, and nothing about the audience or the sends is read for them', async () => {
    mockAccess.mockResolvedValue(access({ isOrganiser: false }));
    jobs();

    const result = await getEligibilityV2ForEvent('guest', UserRole.MEMBER, SESSION);

    expect(result).toMatchObject({ enabled: false, visible: false, reason: 'not_organiser' });
    expect(mockCountAudience).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('before the event ends nothing else is read either', async () => {
    mockAccess.mockResolvedValue(access({ status: 'round_active' }));
    jobs();

    const result = await getEligibilityV2ForEvent('host', UserRole.MEMBER, SESSION);

    expect(result.reason).toBe('not_ended');
    expect(mockCountAudience).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it.each(['scheduled', 'lobby_open', 'round_active', 'round_rating', 'round_transition', 'closing_lobby', 'cancelled'])(
    'an event that is "%s" has not ended',
    async (status) => {
      mockAccess.mockResolvedValue(access({ status }));
      expect((await getEligibilityV2ForEvent('host', UserRole.MEMBER, SESSION)).reason).toBe('not_ended');
    },
  );

  it('an event that does not exist is a 404, not an answer', async () => {
    mockAccess.mockResolvedValue(null);
    await expect(getEligibilityV2ForEvent('host', UserRole.MEMBER, SESSION)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('nobody else took part: no_recipients', async () => {
    mockAccess.mockResolvedValue(access({ isHost: true }));
    mockCountAudience.mockResolvedValue({ tookPart: 0, registeredNoShow: 0 });
    jobs();
    expect(await getEligibilityV2ForEvent('host', UserRole.MEMBER, SESSION)).toMatchObject({
      enabled: false, reason: 'no_recipients', explanation: 'Nobody else took part in this event.',
    });
  });

  it('a send is running: says how far, from the job row', async () => {
    mockAccess.mockResolvedValue(access({ isHost: true }));
    jobs({ active: { total_recipients: 40, sent_count: 11, failed_count: 1 } });
    expect(await getEligibilityV2ForEvent('host', UserRole.MEMBER, SESSION)).toMatchObject({
      reason: 'sending', explanation: 'Sending… 12 of 40.',
    });
  });

  it('three sends by this person in the last 24 hours: limit, in their own zone', async () => {
    mockAccess.mockResolvedValue(access({ isHost: true, timeZone: 'Europe/Berlin' }));
    jobs({
      recent: [
        new Date('2026-10-25T14:20:00Z'), new Date('2026-10-25T18:00:00Z'), new Date('2026-10-25T19:00:00Z'),
      ],
    });
    expect(await getEligibilityV2ForEvent('host', UserRole.MEMBER, SESSION)).toMatchObject({
      reason: 'limit', explanation: 'You can send another message at 15:20.',
    });
  });

  it('counts only THIS person\'s sends for THIS event, inside the window, and never a job that failed before sending anyone', async () => {
    mockAccess.mockResolvedValue(access({ isHost: true }));
    jobs();
    await getEligibilityV2ForEvent('host', UserRole.MEMBER, SESSION);

    const call = mockQuery.mock.calls
      .map((c) => [String(c[0]).replace(/\s+/g, ' '), c[1]] as [string, unknown[]])
      .find(([sql]) => /created_by = \$2/.test(sql))!;
    expect(call[1]).toEqual([SESSION, 'host']);
    expect(call[0]).toMatch(/session_id = \$1/);
    expect(call[0]).toMatch(/created_at > NOW\(\) - INTERVAL '24 hours'/);
    expect(call[0]).toMatch(/NOT \(status = 'failed' AND sent_count = 0\)/);
    expect(call[0]).toMatch(/ORDER BY created_at ASC/);
  });

  it('reports the last send that reached anyone', async () => {
    mockAccess.mockResolvedValue(access({ isHost: true }));
    jobs({ last: { sent_count: 12, sent_at: new Date('2026-10-25T16:45:00Z') } });
    expect((await getEligibilityV2ForEvent('host', UserRole.MEMBER, SESSION)).lastSent)
      .toEqual({ at: '2026-10-25T16:45:00.000Z', recipients: 12 });
  });

  it('asks only about finished jobs for the last send, never one that is still running', async () => {
    mockAccess.mockResolvedValue(access({ isHost: true }));
    jobs();
    await getEligibilityV2ForEvent('host', UserRole.MEMBER, SESSION);
    const sql = mockQuery.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' ')).find((s) => /sent_count > 0/.test(s))!;
    expect(sql).toMatch(/status IN \('completed', 'completed_with_errors', 'failed'\)/);
    expect(sql).toMatch(/LIMIT 1/);
  });
});
