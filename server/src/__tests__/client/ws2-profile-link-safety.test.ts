// ─── WS2/S3 (27 May remaining work) — name-click must never eject; L2 (25 Oct) — and must not strand ────
//
// Clicking another user's display name inside a live event must NEVER
// navigate the current tab away from /session/:id/live — a same-tab
// navigation tears down the socket + LiveKit connection and ejects the
// clicker from the event. Phase 0 (a0070bd) fixed the chat surface ad-hoc;
// the participant-list drawer still ejected (plain <a href="/profile/...">).
//
// The systematic fix: ONE shared component — components/ui/ProfileLink.tsx —
// and a pin that makes any future raw profile link inside the live-event
// surface a build failure, so the bug class cannot regress one surface at a time.
//
// 25 Oct 2026 (CON-01, Stefan and Claus on production): "View full profile" on a meeting request opened a NEW tab,
// and in that tab Back did nothing, because a tab has no history behind it. So ProfileLink now opens the profile
// in the SAME tab, where Back returns to what the member left (the request, in Messages), and only a link inside
// the live event, where a same-tab move would drop the call, opens a new tab, and then says so (a visible arrow
// and "(opens in a new tab)" for a screen reader). A profile that does land in a tab with nothing behind it (that
// new tab, or a link from an email) gets a Back that goes to the dashboard instead of doing nothing.

import { createElement, type ComponentType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as fs from 'fs';
import * as path from 'path';
import { loadClientModule, readClientSource } from './load-client-module';

const CLIENT_SRC = path.join(__dirname, '../../../../client/src');

const readClient = readClientSource;

function listFiles(dir: string): string[] {
  const abs = path.join(CLIENT_SRC, dir);
  return fs.readdirSync(abs)
    .filter(f => f.endsWith('.tsx') || f.endsWith('.ts'))
    .map(f => path.join(dir, f));
}

interface LinkProps { userId: string; className?: string; title?: string; newTab?: boolean; children?: ReactNode }

/** ProfileLink, run, with the router's Link standing in as the anchor it draws. */
function drawLink(props: Partial<LinkProps>): string {
  const mod = loadClientModule('components/ui/ProfileLink.tsx', {
    'react-router-dom': {
      Link: ({ to, children, ...rest }: { to: string; children?: ReactNode }) => createElement('a', { href: to, ...rest }, children),
    },
  });
  const ProfileLink = mod.default as ComponentType<LinkProps>;
  return renderToStaticMarkup(createElement(ProfileLink, { userId: 'u-1', className: 'name', ...props }, 'Dana Sender'));
}

describe('WS2/S3 + L2 — ProfileLink: the same tab by default, a marked new tab only inside the live event', () => {
  it('by default it is a plain same-tab link to the profile: no target, no rel, no arrow, nothing extra to say', () => {
    const html = drawLink({ title: "View Dana's profile" });
    expect(html).toBe('<a href="/profile/u-1" class="name" title="View Dana&#x27;s profile">Dana Sender</a>');
  });

  it('newTab opens a new tab, severs the opener, and says so: a visible arrow and "(opens in a new tab)" for a screen reader', () => {
    const html = drawLink({ newTab: true });
    expect(html).toContain('href="/profile/u-1"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    // The arrow is for the eye only; the words are for a screen reader only.
    expect(html).toMatch(/<span[^>]*aria-hidden="true"[^>]*>↗<\/span>/);
    expect(html).toMatch(/<span class="sr-only"> \(opens in a new tab\)<\/span>/);
    expect(html.indexOf('Dana Sender')).toBeLessThan(html.indexOf('↗'));
  });

  it('target and rel are in the source once, under newTab, so no same-tab link can ever carry them', () => {
    const src = readClient('components/ui/ProfileLink.tsx');
    expect(src.match(/target="_blank"/g)).toHaveLength(1);
    expect(src.match(/rel="noopener noreferrer"/g)).toHaveLength(1);
    expect(src).toMatch(/newTab = false/);
    expect(src).toMatch(/\/profile\/\$\{userId\}/);
  });

  it('NO live-event component hand-rolls a raw profile link or profile navigate()', () => {
    // Every file in features/live — the entire live-event surface. A raw
    // <a href="/profile/..."> (same-tab) or navigate('/profile/...') here
    // is exactly the eject bug. ProfileLink is the only sanctioned path.
    const offenders: string[] = [];
    for (const rel of listFiles('features/live')) {
      const src = readClient(rel);
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

  it('EVERY ProfileLink in the live event passes newTab: a same-tab one there would drop the call', () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const rel of listFiles('features/live')) {
      for (const tag of readClient(rel).match(/<ProfileLink\b[^>]*>/g) ?? []) {
        seen += 1;
        if (!/\bnewTab\b/.test(tag)) offenders.push(`${rel}: ${tag.replace(/\s+/g, ' ')}`);
      }
    }
    // The participant list, the chat, and the end screen's two lists.
    expect(seen).toBe(4);
    expect(offenders).toEqual([]);
  });

  it('outside the live event no ProfileLink asks for a new tab: from a meeting request the profile stays in the tab, and Back returns to it', () => {
    const offenders: string[] = [];
    for (const dir of ['features/messages', 'features/matches', 'features/agents', 'features/search', 'features/circles', 'features/pods', 'features/sessions']) {
      for (const rel of listFiles(dir)) {
        if (/<ProfileLink\b[^>]*\bnewTab\b/.test(readClient(rel))) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
    const requests = readClient('features/messages/MeetingRequests.tsx');
    expect(requests.match(/<ProfileLink\b/g)!.length).toBeGreaterThanOrEqual(5);
  });
});

describe('L2 — a profile\'s Back goes back, and goes somewhere when there is nothing behind it', () => {
  const page = readClient('features/profile/PublicProfilePage.tsx');

  it('Back and "Go Back" are one function: navigate(-1) when the tab has history, else the dashboard, replacing the entry', () => {
    // One place decides. No button calls navigate(-1) itself.
    expect(page).not.toMatch(/onClick=\{\(\) => navigate\(-1\)\}/);
    expect(page.match(/onClick=\{goBack\}/g)).toHaveLength(2);
    const fn = page.slice(page.indexOf('const goBack'), page.indexOf('};', page.indexOf('const goBack')));
    expect(fn).toMatch(/location\.key !== 'default'/);
    expect(fn).toMatch(/window\.history\.length > 1/);
    expect(fn).toMatch(/navigate\(-1\)/);
    expect(fn).toMatch(/navigate\('\/', \{ replace: true \}\)/);
  });

  it('a profile reached by a full page load from inside the app still goes back (its router key is "default" but the tab has history)', () => {
    // Pods, event pages, recaps and People link to /profile/:id with a raw <a href>, which reloads the document, so the
    // router starts with the key "default" there. Only a tab with a single entry has nowhere to go back to.
    const fn = page.slice(page.indexOf('const goBack'), page.indexOf('};', page.indexOf('const goBack')));
    expect(fn).toMatch(/location\.key !== 'default'\s*\|\|\s*window\.history\.length > 1/);
  });

  it('the page reads the router location, and the message button still opens the compose screen in this tab', () => {
    expect(page).toMatch(/useLocation/);
    expect(page).toMatch(/navigate\(`\/messages\/new\/\$\{userId\}`\)/);
  });
});
