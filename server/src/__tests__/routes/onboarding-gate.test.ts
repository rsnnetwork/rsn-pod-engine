// ─── There is exactly ONE way to finish onboarding ───────────────────────────
//
// This file used to test POST /auth/onboarding/complete, the chat flow's plain
// form fallback. That route was removed on 22 Sep 2026, and the tests went with
// it — but the reason it had to go is worth keeping, because it is the sort of
// thing that grows back.
//
// It set onboarding_completed and onboarding_status itself, with its own
// seven-field idea of a complete profile. It seeded no standing searches, ran
// no newcomer fan-out and emitted no entity tags, so a member who finished
// through it was marked done and landed on a Suggestions page that would stay
// empty for ever. By the end its only caller was a screen nothing imported,
// which left it reachable by direct request and by nothing else.
//
// Read as source rather than exercised, because the point is the ABSENCE of a
// route: there is nothing left to call.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

const read = (rel: string) =>
  nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8').replace(/\r\n/g, '\n');

describe('the second completion path is gone', () => {
  const auth = read('routes/auth.ts');

  it('auth.ts no longer serves an onboarding-complete route', () => {
    expect(auth).not.toMatch(/router\.post\(\s*['"]\/onboarding\/complete['"]/);
    expect(auth).not.toMatch(/onboardingCompleteSchema/);
  });

  it('and no longer marks anyone onboarded on its own', () => {
    expect(auth).not.toMatch(/onboarding_completed\s*=/);
    expect(auth).not.toMatch(/onboarding_status\s*=\s*'completed'/);
    expect(auth).not.toMatch(/fallback_form/);
  });

  it('leaves a note saying why, so it is not rebuilt by accident', () => {
    expect(auth).toMatch(/seeded no searches/i);
    expect(auth).toMatch(/onboarding\/answers\/confirm/);
  });
});

describe('the one that remains does the whole job', () => {
  const routes = read('routes/onboarding.ts');
  const repo = read('services/onboarding/answers.repo.ts');

  it('confirm is the only route that completes onboarding', () => {
    expect(routes).toMatch(/['"]\/answers\/confirm['"]/);
  });

  it('confirm marks them done AND writes what the matcher reads', () => {
    expect(repo).toMatch(/onboarding_status = 'completed'/);
    expect(repo).toMatch(/onboarding_completed = true/);
    // The columns the live-event matcher and the public card read. Setting the
    // flags without these is precisely what the removed route did.
    expect(repo).toMatch(/professional_role/);
    expect(repo).toMatch(/who_i_want_to_meet|wantsText|reasons_to_connect/);
    expect(repo).toMatch(/matching_intent/);
  });

  it('and seeds the standing searches, so Suggestions is never empty by design', () => {
    expect(routes).toMatch(/createAgentsFromAnswers/);
  });
});

describe('the client cannot reach the old flow either', () => {
  const clientDir = nodePath.join(__dirname, '../../../../client/src');

  it('the chat onboarding screens no longer exist', () => {
    for (const gone of ['features/onboarding/ChatbotOnboarding.tsx', 'features/onboarding/OnboardingPage.tsx']) {
      expect(nodeFs.existsSync(nodePath.join(clientDir, gone))).toBe(false);
    }
  });

  it('nothing imports them', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of nodeFs.readdirSync(dir, { withFileTypes: true })) {
        const full = nodePath.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const body = nodeFs.readFileSync(full, 'utf8');
        if (/ChatbotOnboarding|from '\.\/OnboardingPage'|onboarding\/OnboardingPage/.test(body)) {
          hits.push(nodePath.relative(clientDir, full));
        }
      }
    };
    walk(clientDir);
    expect(hits).toEqual([]);
  });

  it('and nothing calls the removed route', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of nodeFs.readdirSync(dir, { withFileTypes: true })) {
        const full = nodePath.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        if (/auth\/onboarding\/complete/.test(nodeFs.readFileSync(full, 'utf8'))) {
          hits.push(nodePath.relative(clientDir, full));
        }
      }
    };
    walk(clientDir);
    expect(hits).toEqual([]);
  });
});
