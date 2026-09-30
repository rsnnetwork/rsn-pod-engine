// server/src/__tests__/services/user/profile-visible-filter.test.ts
// 29 Sep 2026: Settings → Privacy "Profile visibility" was saved but never read.
// It now means: hidden members do not appear in search or suggestions, and a
// hidden newcomer triggers no "someone new matches" bells. People who already
// know them still see their profile and messages.
import * as fs from 'fs';
import * as path from 'path';

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: jest.fn(),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
jest.mock('../../../index', () => ({ io: { to: () => ({ emit: () => {} }) }, __esModule: true }));

import { searchMembers } from '../../../services/user/user-search.service';
import { notifyMatchesOfNewUser } from '../../../services/matching/platform-match.service';
import { listMatches, getAgent } from '../../../services/matching/agent.repo';
import { recomputeAgent } from '../../../services/matching/agent-matching.service';

const stripComments = (src: string) => src.replace(/^\s*\/\/.*$/gm, '').replace(/--[^\n`]*/g, '');
const read = (rel: string) => stripComments(fs.readFileSync(path.join(__dirname, '../../../services', rel), 'utf8'));

describe('profile visibility is honoured', () => {
  beforeEach(() => mockQuery.mockReset());

  it('Find people skips hidden members', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await searchMembers('u-viewer', 'claus', 20);
    expect(String(mockQuery.mock.calls[0][0])).toMatch(/u\.profile_visible = true/);
  });

  it('the platform suggestion pool skips hidden members; the agent scoring pool does not', () => {
    const platform = read('matching/platform-match.service.ts');
    const loadCandidates = platform.slice(platform.indexOf('async function loadCandidates'), platform.indexOf('export async function getPlatformMatches'));
    expect(loadCandidates).toMatch(/u\.profile_visible = true/);
    const agents = read('matching/agent-matching.service.ts');
    const pool = agents.slice(agents.indexOf('async function loadCandidatesFor'), agents.indexOf('export async function recomputeAgent'));
    expect(pool).toMatch(/u\.onboarding_completed = true/); // anchor: the slice is the real pool query
    // Stored results must survive a hidden period, so visibility is filtered when an agent is read, not when it is scored.
    expect(pool).not.toMatch(/profile_visible/);
  });

  it('a hidden newcomer sends nobody a "someone new matches" bell', async () => {
    // Fixtures mirror platform-match.test.ts: an investor newcomer and a founder
    // who wants investors score above MATCH_THRESHOLD, so without the fix a
    // bell IS inserted. The test therefore fails on today's code.
    const base = {
      avatarUrl: null, jobTitle: null, company: null, whatICanHelpWith: null, whatICareAbout: null,
      goals: null, interests: null, whyIWantToMeet: null, onboardingCompleted: true,
    };
    const newcomer = {
      ...base, id: 'u-new', displayName: 'Iqbal', professionalRole: ['Angel Investor'],
      expertiseText: 'early stage SaaS investing', myIntent: null, whoIWantToMeet: null,
    };
    const member = {
      ...base, id: 'u-member', displayName: 'Fatima', professionalRole: ['Founder'], expertiseText: null,
      whoIWantToMeet: 'investors and angels for my seed round', myIntent: 'raise funding for my SaaS startup',
    };
    mockQuery.mockImplementation((sql: string) => {
      if (/WHERE u\.id = \$1/.test(sql)) return Promise.resolve({ rows: [newcomer] });
      if (/SELECT profile_visible FROM users/.test(sql)) return Promise.resolve({ rows: [{ profile_visible: false }] });
      if (/WHERE u\.id <> \$1/.test(sql)) return Promise.resolve({ rows: [member] });
      if (/INSERT INTO notifications/.test(sql)) return Promise.resolve({ rows: [{ id: 'n1', created_at: new Date() }] });
      return Promise.resolve({ rows: [] });
    });
    const sent = await notifyMatchesOfNewUser('u-new');
    expect(sent).toBe(0);
    const inserts = mockQuery.mock.calls.map(c => String(c[0])).filter(s => /INSERT INTO notifications/.test(s));
    expect(inserts).toHaveLength(0);
  });

  // Agents rescore rarely (on create, on an edit, on resume), so the rows they
  // stored can outlive a member choosing to hide. The read side skips them too.
  // These call the real repo functions and read the SQL they send, so they do not
  // depend on where the text sits in the file. "\b" matters: "cu.profile_visible"
  // contains "u.profile_visible", and neither filter may satisfy the other's check.
  it('an agent\'s stored results skip members who have since hidden', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await listMatches('agent-1');
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(String(mockQuery.mock.calls[0][0])).toMatch(/\bu\.profile_visible = true/);
  });

  it('the match counts on the agent dashboard skip them too', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await getAgent('agent-1', 'u-owner');
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(String(mockQuery.mock.calls[0][0])).toMatch(/\bcu\.profile_visible = true/);
  });

  // An agent is filtered when it is READ, never when it is SCORED. A rescore replaces
  // the stored rows (replaceMatches deletes whatever the fresh set lacks), so a member
  // who was hidden at that moment was deleted from every search that rescored, and
  // un-hiding did not bring them back until each owner edited their search.
  // Seam: the real recomputeAgent, which runs loadCandidatesFor and then the real
  // replaceMatches, against a small fake of the users table and of this one agent's
  // stored rows. The fake applies the visibility condition only if the SQL it is sent
  // contains it, so a filter put back into the scoring pool fails here.
  it('rescoring an agent while a member is hidden keeps that member\'s stored row', async () => {
    const developer = (id: string, displayName: string) => ({
      id, displayName, avatarUrl: null, professionalRole: ['Developer'], jobTitle: 'Senior Engineer',
      company: 'Acme', expertiseText: 'react typescript node', whatICanHelpWith: 'building web apps',
      whatICareAbout: null, goals: null, interests: null, myIntent: null, whoIWantToMeet: null, whyIWantToMeet: null,
    });
    const users = [
      { row: developer('u-visible', 'Dana'), visible: true },
      { row: developer('u-hidden', 'Hamid'), visible: false },
    ];
    // Both were found by an earlier scoring, while both were visible.
    const stored = new Set(['u-visible', 'u-hidden']);
    mockQuery.mockImplementation((sql: string, params: unknown[] = []) => {
      if (/FROM users u\s+WHERE u\.id <> \$1/.test(sql)) {
        const skipsHidden = /\bu\.profile_visible = true/.test(sql);
        return Promise.resolve({ rows: users.filter(u => u.visible || !skipsHidden).map(u => u.row) });
      }
      if (/^\s*DELETE FROM agent_matches am/.test(sql)) {
        stored.clear(); // no live introductions in this scenario, so nothing is exempt from the delete
        return Promise.resolve({ rows: [] });
      }
      if (/INSERT INTO agent_matches/.test(sql)) {
        // After the agent id, each VALUES row is a (candidate, score, reason) triple.
        for (let i = 1; i < params.length; i += 3) stored.add(String(params[i]));
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const shown = await recomputeAgent({ id: 'agent-1', userId: 'u-owner', wantText: 'react developers to build my product', label: 'Developers' });

    expect(shown).toBe(2);
    expect([...stored].sort()).toEqual(['u-hidden', 'u-visible']);
  });
});
