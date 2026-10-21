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
    // The Human Profile (final review, 21 Oct 2026), saying where it was opened from; never the old /profile/ page.
    expect(src).toMatch(/href=\{personHref\(userId, from\)\}/);
    expect(src).toMatch(/from: KnownSource;/);
    expect(src).not.toMatch(/\/profile\/\$\{userId\}/);
  });

  it('NO live-event component hand-rolls a raw profile link or profile navigate()', () => {
    // Every file in features/live — the entire live-event surface. A raw
    // <a href="/profile/..."> or "/people/..." (same-tab), a navigate() to
    // either, or a personHref outside ProfileLink here is exactly the eject
    // bug. ProfileLink is the only sanctioned path.
    const offenders: string[] = [];
    for (const rel of listFiles('features/live')) {
      const src = readClient(rel);
      for (const page of ['profile', 'people']) {
        if (new RegExp(`<a[^>]*href=\\{?[\`'"]\\/${page}\\/`).test(src)) offenders.push(`${rel}: raw <a href="/${page}/...">`);
        if (new RegExp(`navigate\\(\\s*[\`'"]\\/${page}\\/`).test(src)) offenders.push(`${rel}: navigate('/${page}/...')`);
        if (new RegExp(`<Link[^>]*to=\\{?[\`'"]\\/${page}\\/`).test(src)) offenders.push(`${rel}: <Link to="/${page}/...">`);
      }
      if (/personHref\(/.test(src)) offenders.push(`${rel}: personHref outside ProfileLink`);
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
