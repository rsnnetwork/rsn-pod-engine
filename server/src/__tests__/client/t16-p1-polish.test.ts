// ─── P1 polish on the preview (T16, 1-2 Nov 2026): source pins for screens without a pure helper ─────────────────
//
// Each pin names the behaviour it protects; the measurements behind the layout ones are in task-T16-report.md.

import * as fs from 'fs';
import * as path from 'path';
import { chimeFromCall, quietHere } from '../../../../client/src/lib/message-chime-policy';

const CLIENT = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(CLIENT, rel), 'utf8').replace(/\r\n/g, '\n');

describe('X4: the event form does not move under a person while the matching choices load', () => {
  const src = read('features/sessions/MatchingSection.tsx');

  it('the loading rows are shaped like the loaded choices: a card per preset (and the admin\'s Other), a name over a line', () => {
    expect(src).toMatch(/data-testid="matching-presets-loading"/);
    expect(src).toMatch(/Array\.from\(\{ length: isAdmin \? 5 : 4 \}/);
    expect(src).toMatch(/<div key=\{i\} className=\{card\(false\)\}>/);
    // Measured: below 400px three of the four presets' lines wrap once, so their placeholders take a second line there.
    expect(src).toMatch(/\{i < 3 && <span className="[^"]*min-\[400px\]:hidden" \/>\}/);
    expect(src).not.toMatch(/h-11 animate-pulse rounded-xl bg-gray-100/);
  });
});

describe('X2: tap targets measured under 44px are 44px at every width', () => {
  it('the pod row link in "Pods in this circle" (42px from 390)', () => {
    expect(read('features/circles/CirclePodsSection.tsx')).toMatch(/<Link to=\{`\/pods\/\$\{p\.podId\}`\} className="flex min-h-\[44px\][^"]*"/);
  });

  it('the host\'s and each participant\'s picture-and-name link on the event page (under 44px from 768)', () => {
    const page = read('features/sessions/SessionDetailPage.tsx');
    expect(page).toMatch(/<Link to=\{personHref\(hostRow\.userId, 'Events'\)\} className="flex min-h-\[44px\] /);
    expect(page).toMatch(/<Link to=\{personHref\(p\.userId \|\| p\.id, 'Events'\)\} className="flex min-h-\[44px\] /);
  });

  it('the profile\'s Video call holds a fixed 44px and never shrinks in its row (36.5px seen in headless WebKit)', () => {
    expect(read('features/calls/CallButton.tsx')).toMatch(/hero: 'inline-flex h-11 min-h-\[44px\] shrink-0 /);
  });
});

// ─── X3: the incoming call rings through the message chime's one sound path ──────────────────────────────────────

describe('X3: an incoming call rings once, in one tab, under the device\'s sound setting', () => {
  const ring = chimeFromCall({ requestId: 'r-1', conversationId: 'c-1' });

  it('a call is a ring event of its own, keyed by its request, pointing at its conversation', () => {
    expect(ring).toEqual({ id: 'call:r-1', path: '/messages/c-1', ring: true });
    expect(chimeFromCall({ requestId: '', conversationId: 'c-1' })).toBeNull();
  });

  it('it rings even in the open conversation, but never with the sound off, in a live event or in a meeting', () => {
    expect(quietHere(ring!, { pathname: '/messages/c-1', visible: true, soundOn: true })).toBe(false);
    expect(quietHere(ring!, { pathname: '/messages/c-1', visible: true, soundOn: false })).toBe(true);
    expect(quietHere(ring!, { pathname: '/session/s-1/live', visible: true, soundOn: true })).toBe(true);
    expect(quietHere(ring!, { pathname: '/meet/c-2', visible: true, soundOn: true })).toBe(true);
    // A message in the open conversation is still quiet there.
    expect(quietHere({ id: 'dm:m', path: '/messages/c-1' }, { pathname: '/messages/c-1', visible: true, soundOn: true })).toBe(true);
  });

  it('the app\'s chime hook hears call:request and plays the ring, not the message chime, past the message cooldown', () => {
    const hook = read('hooks/useMessageChime.ts');
    expect(hook).toMatch(/socket\.on\('call:request', onCall\);/);
    expect(hook).toMatch(/socket\.off\('call:request', onCall\);/);
    expect(hook).toMatch(/if \(ev\.ring\) playCallRing\(ev\.id\);\s*else playMessageChime\(ev\.id\);/);
    expect(hook).toMatch(/lastPlayedAt: ev\.ring \? null : lastPlayedAt/);
    expect(read('features/calls/useCallSignals.ts')).not.toMatch(/playCallRing|AudioContext/);
  });
});

describe('X3: one "Former member" on the client', () => {
  it('is defined once (lib/former-member.ts), the same words as the server\'s FORMER_MEMBER_NAME, and every screen reads it', () => {
    const defined: string[] = [];
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f.name) && /=\s*'Former member'/.test(fs.readFileSync(p, 'utf8'))) defined.push(path.relative(CLIENT, p).replace(/\/g, '/'));
      }
    };
    walk(CLIENT);
    expect(defined).toEqual(['lib/former-member.ts']);
    const server = fs.readFileSync(path.join(__dirname, '../../services/users/active-member.ts'), 'utf8');
    expect(server).toMatch(/FORMER_MEMBER_NAME = 'Former member'/);
  });
});
