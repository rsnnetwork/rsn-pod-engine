// ─── P1 polish on the preview (T16, 1-2 Nov 2026): source pins for screens without a pure helper ─────────────────
//
// Each pin names the behaviour it protects; the measurements behind the layout ones are in task-T16-report.md.

import * as fs from 'fs';
import * as path from 'path';
import { REFUSED_DETAIL, refusalOf } from '../../../../client/src/features/live/session-guard-state';
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
        else if (/\.tsx?$/.test(f.name) && /=\s*'Former member'/.test(fs.readFileSync(p, 'utf8'))) defined.push(path.relative(CLIENT, p).split(path.sep).join('/'));
      }
    };
    walk(CLIENT);
    expect(defined).toEqual(['lib/former-member.ts']);
    const server = fs.readFileSync(path.join(__dirname, '../../services/users/active-member.ts'), 'utf8');
    expect(server).toMatch(/FORMER_MEMBER_NAME = 'Former member'/);
  });
});

describe('P1 item 9: a refused person\'s live page is final, and says T11\'s refusals in the server\'s words', () => {
  const refused = (code: string, message: string) => ({ response: { status: 403, data: { error: { code, message } } } });

  it('a private event or one that needs the host\'s approval says why; approval also points to the event page', () => {
    expect(refusalOf(refused('EVENT_PRIVATE', 'This event is private. It is for its pod\'s members and the people the host invites.')))
      .toEqual({ detail: 'This event is private. It is for its pod\'s members and the people the host invites.', requestOnEventPage: false });
    expect(refusalOf(refused('EVENT_NEEDS_APPROVAL', 'This event asks the host to approve each place. Request to join from the event page.')))
      .toEqual({ detail: 'This event asks the host to approve each place. Request to join from the event page.', requestOnEventPage: true });
  });

  it('any other refusal keeps the plain line, never a code or a raw server text', () => {
    expect(refusalOf(refused('AUTH_FORBIDDEN', 'Forbidden'))).toEqual({ detail: REFUSED_DETAIL, requestOnEventPage: false });
    expect(refusalOf(refused('EVENT_PRIVATE', ''))).toEqual({ detail: REFUSED_DETAIL, requestOnEventPage: false });
    expect(refusalOf(undefined)).toEqual({ detail: REFUSED_DETAIL, requestOnEventPage: false });
  });

  it('item 10: every format waits for the register answer, and a removed person gets the final screen, before any room', () => {
    const page = read('features/live/LiveSessionPage.tsx');
    const removed = page.indexOf("if (removedFromEvent) return <RemovedFromEvent onBack={() => navigate('/sessions')} />;");
    const known = page.indexOf('if (!registrationKnown) return <PageLoader />;');
    const meeting = page.indexOf('<MeetingRoom');
    expect(removed).toBeGreaterThan(-1);
    expect(known).toBeGreaterThan(removed);
    expect(meeting).toBeGreaterThan(known);
  });

  it('the guard keeps the refusal it read, on the first read and on the re-check when the tab comes back', () => {
    const guard = read('features/live/SessionGuard.tsx');
    expect(guard.match(/safeSetState\(\{ kind: 'refused', \.\.\.refusalOf\(err\) \}\)/g)).toHaveLength(2);
    expect(guard).toMatch(/\{state\.detail\}/);
    expect(guard).toMatch(/state\.requestOnEventPage && \(/);
  });
});
