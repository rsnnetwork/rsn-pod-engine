// ─── WS2/S3 (27 May remaining work) — name-click must never eject; CON-01 (25 Oct) — and must not strand ────
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
// new tab, or a link from an email) gets a Back that goes somewhere instead of doing nothing.
//
// The same tests as production's pin for this change (the live app has no Human Profile, so its ProfileLink
// has no `from` and opens /profile/:id), plus the REASON preview's: with `from` the link opens the Human Profile
// and says where it was opened from.

import { createElement, type ComponentType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import * as profileText from '../../../../client/src/features/reason/human/profile-text';

const CLIENT_SRC = path.join(__dirname, '../../../../client/src');

/** A client file's text. A Windows working tree is CRLF; normalised so a pattern matches either way. */
function readClient(rel: string): string {
  return fs.readFileSync(path.join(CLIENT_SRC, rel), 'utf8').replace(/\r\n/g, '\n');
}

/** A client file, transpiled and run, with the imports in `stand` (matched by their exact text) replaced by stand-ins. */
function loadClientModule(rel: string, stand: Record<string, unknown>): Record<string, unknown> {
  const { outputText } = ts.transpileModule(readClient(rel), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  });
  const load = (id: string): unknown => (id in stand ? stand[id] : require(id));
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  new Function('module', 'exports', 'require', outputText)(mod, mod.exports, load);
  return mod.exports;
}

function listFiles(dir: string): string[] {
  const abs = path.join(CLIENT_SRC, dir);
  return fs.readdirSync(abs)
    .filter(f => f.endsWith('.tsx') || f.endsWith('.ts'))
    .map(f => path.join(dir, f));
}

interface LinkProps { userId: string; from?: string; className?: string; title?: string; newTab?: boolean; children?: ReactNode }

/** ProfileLink, run, with the router's Link standing in as the anchor it draws. */
function drawLink(props: Partial<LinkProps>): string {
  const mod = loadClientModule('components/ui/ProfileLink.tsx', {
    'react-router-dom': {
      Link: ({ to, children, ...rest }: { to: string; children?: ReactNode }) => createElement('a', { href: to, ...rest }, children),
    },
    '@/features/reason/human/profile-text': profileText,
  });
  const ProfileLink = mod.default as ComponentType<LinkProps>;
  return renderToStaticMarkup(createElement(ProfileLink, { userId: 'u-1', className: 'name', ...props }, 'Dana Sender'));
}

describe('WS2/S3 + CON-01 — ProfileLink: the same tab by default, a marked new tab only inside the live event', () => {
  it('by default it is a plain same-tab link to the profile: no target, no rel, no arrow, nothing extra to say', () => {
    const html = drawLink({ title: "View Dana's profile" });
    expect(html).toBe('<a href="/profile/u-1" class="name" title="View Dana&#x27;s profile">Dana Sender</a>');
  });

  it('given where it was opened from, it opens the Human Profile in the same tab, and says so in the address', () => {
    const html = drawLink({ from: 'Messages', title: "View Dana's profile" });
    expect(html).toBe('<a href="/people/u-1?from=Messages" class="name" title="View Dana&#x27;s profile">Dana Sender</a>');
    expect(html).not.toMatch(/target=|rel=|↗|opens in a new tab/);
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

  it('the live event\'s link opens the Human Profile in a new tab, with the same words and arrow', () => {
    const html = drawLink({ newTab: true, from: 'Events' });
    expect(html).toContain('href="/people/u-1?from=Events"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toMatch(/<span class="sr-only"> \(opens in a new tab\)<\/span>/);
  });

  it('target and rel are in the source once, under newTab, so no same-tab link can ever carry them', () => {
    const src = readClient('components/ui/ProfileLink.tsx');
    expect(src.match(/target="_blank"/g)).toHaveLength(1);
    expect(src.match(/rel="noopener noreferrer"/g)).toHaveLength(1);
    expect(src).toMatch(/newTab = false/);
    expect(src).toMatch(/\/profile\/\$\{userId\}/);
    // The Human Profile (final review, 21 Oct 2026), saying where it was opened from.
    expect(src).toMatch(/personHref\(userId, from\)/);
    expect(src).toMatch(/from\?: KnownSource;/);
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

  it('EVERY ProfileLink in the live event passes newTab: a same-tab one there would drop the call', () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const rel of listFiles('features/live')) {
      for (const tag of readClient(rel).match(/<ProfileLink\b[^>]*>/g) ?? []) {
        seen += 1;
        if (!/\bnewTab\b/.test(tag)) offenders.push(`${rel}: ${tag.replace(/\s+/g, ' ')}`);
        // ...and, on the preview, says it was opened from an event.
        if (!/\bfrom="Events"/.test(tag)) offenders.push(`${rel}: no from="Events": ${tag.replace(/\s+/g, ' ')}`);
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

describe('CON-01 — a profile\'s Back goes back, and goes somewhere when there is nothing behind it', () => {
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
    // A raw <a href> reloads the document, so the router starts with the key "default" there. Only a tab with a single
    // entry has nowhere to go back to.
    const fn = page.slice(page.indexOf('const goBack'), page.indexOf('};', page.indexOf('const goBack')));
    expect(fn).toMatch(/location\.key !== 'default'\s*\|\|\s*window\.history\.length > 1/);
  });

  it('the page reads the router location, and the message button still opens the compose screen in this tab', () => {
    expect(page).toMatch(/useLocation/);
    expect(page).toMatch(/navigate\(`\/messages\/new\/\$\{userId\}`\)/);
  });

  it('the Human Profile\'s Back is the browser\'s own step back, and with nothing behind it goes to the screen the link was on, replacing the entry', () => {
    const human = readClient('features/reason/human/HumanProfilePage.tsx');
    const fn = human.slice(human.indexOf('const back = () =>'), human.indexOf('};', human.indexOf('const back = () =>')));
    expect(fn).toMatch(/location\.key === 'default'/);
    expect(fn).toMatch(/navigate\(backFallback\(source\), \{ replace: true \}\)/);
    expect(fn).toMatch(/navigate\(-1\)/);
    // It does not send everyone to For You any more.
    expect(fn).not.toMatch(/navigate\('\/', \{ replace: true \}\)/);
  });
});
