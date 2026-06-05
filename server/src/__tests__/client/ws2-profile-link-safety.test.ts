// ─── WS2/S3 (27 May remaining work) — name-click must never eject ──────────
//
// Clicking another user's display name inside a live event must NEVER
// navigate the current tab away from /session/:id/live — a same-tab
// navigation tears down the socket + LiveKit connection and ejects the
// clicker from the event. Phase 0 (a0070bd) fixed the chat surface ad-hoc;
// the participant-list drawer still ejected (plain <a href="/profile/...">).
//
// The systematic fix: ONE shared component — components/ui/ProfileLink.tsx —
// always opens the profile in a new tab. This pin makes any future raw
// profile link inside the live-event surface a build failure, so the bug
// class cannot regress one surface at a time.

import * as fs from 'fs';
import * as path from 'path';

const CLIENT_SRC = path.join(__dirname, '../../../../client/src');

function readClient(rel: string): string {
  return fs.readFileSync(path.join(CLIENT_SRC, rel), 'utf8');
}

function listFiles(dir: string): string[] {
  const abs = path.join(CLIENT_SRC, dir);
  return fs.readdirSync(abs)
    .filter(f => f.endsWith('.tsx') || f.endsWith('.ts'))
    .map(f => path.join(dir, f));
}

describe('WS2/S3 — ProfileLink is the only way to a profile from the live event', () => {
  it('ProfileLink exists and hard-codes the new-tab guarantee', () => {
    const src = readClient('components/ui/ProfileLink.tsx');
    expect(src).toMatch(/target="_blank"/);
    expect(src).toMatch(/rel="noopener noreferrer"/);
    expect(src).toMatch(/\/profile\/\$\{userId\}/);
  });

  it('NO live-event component hand-rolls a raw profile link or profile navigate()', () => {
    // Every file in features/live — the entire live-event surface. A raw
    // <a href="/profile/..."> (same-tab) or navigate('/profile/...') here
    // is exactly the eject bug. ProfileLink is the only sanctioned path.
    const offenders: string[] = [];
    for (const rel of listFiles('features/live')) {
      const src = readClient(rel);
      // Strip the sanctioned component's own name so usage lines don't trip.
      if (/<a[^>]*href=\{?[`'"]\/profile\//.test(src)) offenders.push(`${rel}: raw <a href="/profile/...">`);
      if (/navigate\(\s*[`'"]\/profile\//.test(src)) offenders.push(`${rel}: navigate('/profile/...')`);
      if (/<Link[^>]*to=\{?[`'"]\/profile\//.test(src)) offenders.push(`${rel}: <Link to="/profile/...">`);
    }
    expect(offenders).toEqual([]);
  });

  it('the surfaces that render clickable names use ProfileLink', () => {
    for (const rel of [
      'features/live/ParticipantList.tsx',
      'features/live/ChatPanel.tsx',
      'features/live/SessionComplete.tsx',
    ]) {
      expect(readClient(rel)).toMatch(/ProfileLink/);
    }
  });
});
