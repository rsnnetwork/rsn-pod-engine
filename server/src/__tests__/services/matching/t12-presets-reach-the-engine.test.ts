// ─── A preset changes who is likelier to meet, nothing else (30 Oct 2026, T12, L19, D5, D6) ──────
//
// "Speed networking types, e.g. founders and investors". An event names a preset (or an admin's template) in
// config.matchingTemplateId. The engine then pairs with that template's weights:
//   - in the pre-event plan made at Go Live too (it used the engine defaults whatever the event chose);
//   - as soft weights only: no hard constraint is added, so nobody is kept from meeting anybody;
//   - with the event's own matching rule, never the template's matching_policy or cooldown_months (D5);
//   - and a stored value that is not a UUID (written before ids were checked) is read as no template, so the plan
//     is made on the defaults instead of failing on the template read (D6), and is never written to matches.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: jest.fn(async (cb: (client: unknown) => unknown) => cb({ query: mockQuery })),
  __esModule: true,
}));

jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

const mockGetSessionById = jest.fn();
jest.mock('../../../services/session/session.service', () => ({
  getSessionById: (...args: unknown[]) => mockGetSessionById(...args),
  __esModule: true,
}));

jest.mock('../../../services/block/block.service', () => ({
  getBlockedPairsForUsers: jest.fn(async () => []),
  __esModule: true,
}));

const mockGenerateSchedule = jest.fn();
jest.mock('../../../services/matching/matching.registry', () => ({
  getMatchingEngine: () => ({ generateSchedule: (...args: unknown[]) => mockGenerateSchedule(...args) }),
  DEFAULT_ENGINE_ID: 'speed_networking_v1',
  __esModule: true,
}));

import { MATCHING_PRESET_IDS } from '@rsn/shared';
import { generateSessionSchedule } from '../../../services/matching/matching.service';

const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const POD_ID = '11111111-1111-4111-8111-111111111111';

/** The Founders and investors preset as migration 126 seeds it, with a template rule that must NOT be applied. */
const FOUNDERS_ROW = {
  id: MATCHING_PRESET_IDS.foundersInvestors,
  weights: {
    sharedInterests: 0.10, sharedReasons: 0.15, industryDiversity: 0.05, companyDiversity: 0.15, languageMatch: 0.10,
    encounterFreshness: 0.10, mutualPremiumRequest: 0.20, singlePremiumRequest: 0.10, premiumBoost: 0.03,
    mutualMeetAgainBoost: 0.05, intentAlignment: 0.30, designationDiversity: 0.25, avoidPenalty: 0.20,
    eventIntentionAlignment: 0.25,
  },
  matching_policy: 'none',
  cooldown_months: 1,
};

function event(config: Record<string, unknown>) {
  mockGetSessionById.mockResolvedValue({ id: SESSION_ID, podId: POD_ID, config: { numberOfRounds: 2, ...config } });
}

beforeEach(() => {
  mockQuery.mockReset();
  mockGetSessionById.mockReset();
  mockGenerateSchedule.mockReset();
  mockGenerateSchedule.mockResolvedValue({ rounds: [], durationMs: 1 });
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (/FROM session_participants sp\s+JOIN users u/.test(sql)) {
      return { rows: ['a', 'b', 'c', 'd'].map((id) => ({ userId: id, interests: [], reasonsToConnect: [], languages: [] })) };
    }
    if (/FROM matching_templates WHERE id = \$1/.test(sql)) {
      return { rows: params[0] === FOUNDERS_ROW.id ? [FOUNDERS_ROW] : [] };
    }
    if (/SELECT matching_template_id FROM pods/.test(sql)) return { rows: [{ matching_template_id: null }] };
    return { rows: [], rowCount: 0 };
  });
});

const engineInput = () => mockGenerateSchedule.mock.calls[0][0] as {
  config: { weights: Record<string, number>; hardConstraints: unknown[] };
};

describe('the pre-event plan pairs with the event\'s preset', () => {
  it('uses the preset\'s weights, and adds no hard constraint', async () => {
    event({ matchingTemplateId: FOUNDERS_ROW.id, matchingPolicy: 'within_event' });
    await generateSessionSchedule(SESSION_ID);
    const { config } = engineInput();
    expect(config.weights).toEqual(FOUNDERS_ROW.weights);
    expect(config.hardConstraints).toEqual([]);
  });

  it("follows the event's own rule, never the template's (platform-wide reads every past encounter)", async () => {
    event({ matchingTemplateId: FOUNDERS_ROW.id, matchingPolicy: 'platform_wide' });
    await generateSessionSchedule(SESSION_ID);
    // The template says 'none' (no history read at all); the event says platform_wide, which reads encounters.
    expect(mockQuery.mock.calls.some(([sql]) => /encounter_history/.test(sql as string))).toBe(true);
  });

  it('an event with no template plans on the engine defaults, as before', async () => {
    event({ matchingPolicy: 'within_event' });
    await generateSessionSchedule(SESSION_ID);
    expect(engineInput().config.weights).toMatchObject({ intentAlignment: 0.20, designationDiversity: 0.10 });
    expect(mockQuery.mock.calls.some(([sql]) => /FROM matching_templates/.test(sql as string))).toBe(false);
  });

  it('a stored value that is not a UUID is read as no template: the plan is made, nothing throws', async () => {
    event({ matchingTemplateId: 'Investor Day', matchingPolicy: 'within_event' });
    await expect(generateSessionSchedule(SESSION_ID)).resolves.toBeDefined();
    expect(mockQuery.mock.calls.some(([sql]) => /FROM matching_templates/.test(sql as string))).toBe(false);
    expect(engineInput().config.weights).toMatchObject({ intentAlignment: 0.20 });
  });
});
