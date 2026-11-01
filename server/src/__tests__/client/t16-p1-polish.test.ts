// ─── P1 polish on the preview (T16, 1-2 Nov 2026): source pins for screens without a pure helper ─────────────────
//
// Each pin names the behaviour it protects; the measurements behind the layout ones are in task-T16-report.md.

import * as fs from 'fs';
import * as path from 'path';
import { CONNECTION_LOST, gotNoAnswer } from '../../../../client/src/features/reason/errors';
import { groupErrorSentence } from '../../../../client/src/features/messages/group-chat-text';
import { inviteErrorSentence } from '../../../../client/src/features/invites/invite-picker';
import { sendErrorSentence } from '../../../../client/src/features/sessions/post-event-panel';
import { onboardingError } from '../../../../client/src/features/onboarding/flow';
import { leaveEvent, leaveOnUnmount } from '../../../../client/src/features/live/leave-event';
import { REFUSED_DETAIL, refusalOf } from '../../../../client/src/features/live/session-guard-state';
import { RING_REPEAT_MS, chimeFromCall, keepsRinging, quietHere } from '../../../../client/src/lib/message-chime-policy';

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
    expect(hook).toMatch(/if \(ev\.ring\) ringUntilAnswered\(ev\);\s*else playMessageChime\(ev\.id\);/);
    expect(hook).toMatch(/playCallRing\(ev\.id\);/);
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

describe('P1 item 7: Leave tells the server once', () => {
  const socket = () => {
    const sent: string[] = [];
    return { sent, emit: (_e: 'session:leave', d: { sessionId: string }) => { sent.push(d.sessionId); } };
  };

  it('Leave then the clean-up: one session:leave; the clean-up alone (going away without Leave): one', () => {
    const s = socket();
    leaveEvent(s, 'e-1');
    leaveOnUnmount(s, 'e-1');
    expect(s.sent).toEqual(['e-1']);
    leaveOnUnmount(s, 'e-1');
    expect(s.sent).toEqual(['e-1', 'e-1']);
  });

  it('a Leave from another event does not quiet this one', () => {
    const s = socket();
    leaveEvent(s, 'e-2');
    leaveOnUnmount(s, 'e-3');
    expect(s.sent).toEqual(['e-2', 'e-3']);
    leaveOnUnmount(s, 'e-2');
    expect(s.sent).toEqual(['e-2', 'e-3']);
  });

  it('both Leave buttons and the live hook go through it, and nothing else sends session:leave', () => {
    expect(read('features/live/LiveSessionPage.tsx')).toMatch(/leaveEvent\(getSocket\(\), sessionId!\);/);
    expect(read('features/live/meeting/MeetingControlBar.tsx')).toMatch(/leaveEvent\(getSocket\(\), sessionId\);/);
    expect(read('hooks/useSessionSocket.ts')).toMatch(/leaveOnUnmount\(socket, sessionId\);/);
    for (const f of ['features/live/LiveSessionPage.tsx', 'features/live/meeting/MeetingControlBar.tsx', 'hooks/useSessionSocket.ts']) {
      expect(read(f)).not.toMatch(/emit\('session:leave'/);
    }
  });
});

describe('P1 item 7: a message taken down during a socket gap leaves the open live panel', () => {
  it('the reconnect reads the chat page once, through the same reconcile the chat tag runs', () => {
    const live = read('hooks/useSessionSocket.ts');
    expect(live).toMatch(/if \(Array\.isArray\(data\?\.entities\) && data\.entities\.includes\(chatTag\)\) reconcileChat\(\);/);
    const reconnect = live.slice(live.indexOf('const onReconnect = () => {'), live.indexOf('const onReconnectAttempt'));
    expect(reconnect).toMatch(/reconcileChat\(\);/);
  });

  it('the message-everyone panel has no whitespace-only lines', () => {
    expect(read('features/sessions/MessageParticipantsPanel.tsx')).not.toMatch(/\n[ \t]+\n/);
  });
});

describe('the sweep of the screens T16 touched: every tap target 44px', () => {
  it('the pod page\'s circle chips are app links with a 44px tap, the pods filters and the admin pods controls are 44px', () => {
    const pod = read('features/pods/PodDetailPage.tsx');
    expect(pod).toMatch(/<Link key=\{c\.id\} to=\{`\/circles\/\$\{c\.id\}`\} className="inline-flex min-h-\[44px\]/);
    expect(pod).not.toMatch(/href=\{`\/circles\//);
    expect(read('features/pods/PodsPage.tsx')).toMatch(/size="sm"\s*className="min-h-\[44px\]"\s*onClick=\{\(\) => setFilter\(key\)\}/);
    const admin = read('features/admin/AdminPodsPage.tsx');
    expect(admin).toMatch(/className=\{`min-h-\[44px\] px-3 py-1\.5 rounded-lg/);
    expect(admin.match(/size="sm"\s*className="min-h-\[44px\]"/g)?.length).toBe(2);
  });
});

describe('one "no answer" rule for every failed-request sentence (review T16, Important 2; item 18)', () => {
  // A timeout carries a code and may carry no request; it is still a lost connection, never the caller's own words.
  const timedOut = { code: 'ECONNABORTED' };
  const fault = new TypeError('x is undefined');

  it('gotNoAnswer is the one check: the axios mark, a request that went out, or a no-answer code', () => {
    expect(gotNoAnswer(timedOut)).toBe(true);
    expect(gotNoAnswer({ code: 'ERR_NETWORK' })).toBe(true);
    expect(gotNoAnswer({ isAxiosError: true })).toBe(true);
    expect(gotNoAnswer({ request: {} })).toBe(true);
    expect(gotNoAnswer(fault)).toBe(false);
    expect(gotNoAnswer(null)).toBe(false);
  });

  it('the group chat, invites, message-everyone and onboarding sentences all say Connection lost for a timeout', () => {
    expect(groupErrorSentence(timedOut, 'fallback')).toBe(CONNECTION_LOST);
    expect(inviteErrorSentence(timedOut, 'fallback')).toBe(CONNECTION_LOST);
    expect(sendErrorSentence(timedOut)).toBe(CONNECTION_LOST);
    expect(onboardingError(timedOut, 'fallback')).toBe(CONNECTION_LOST);
    expect(groupErrorSentence(fault, 'fallback')).toBe('fallback');
    expect(inviteErrorSentence(fault, 'fallback')).toBe('fallback');
    expect(onboardingError(fault, 'fallback')).toBe('fallback');
  });

  it('no screen keeps its own copy of the check', () => {
    for (const f of ['features/messages/group-chat-text.ts', 'features/invites/invite-picker.ts', 'features/sessions/post-event-panel.ts', 'features/onboarding/flow.ts']) {
      expect(read(f)).not.toMatch(/isAxiosError === true/);
      expect(read(f)).toMatch(/gotNoAnswer\(/);
    }
  });
});

describe('X3, fix round 1: the ring repeats in the one tab until the call stops ringing', () => {
  const ringing = { requestId: 'r-1', expiresAt: 1_000_000 };
  const here = { pathname: '/for-you', visible: false, soundOn: true };
  const ev = { id: 'call:r-1', path: '/messages/c-1', ring: true as const };

  it('every few seconds, while the same call still rings, before it lapses, and while this device may sound', () => {
    expect(RING_REPEAT_MS).toBe(4000);
    expect(keepsRinging(ev, ringing, 'r-1', 900_000, here)).toBe(true);
    // Answered, declined, withdrawn or answered elsewhere: the call layer no longer holds it, or holds another.
    expect(keepsRinging(ev, null, 'r-1', 900_000, here)).toBe(false);
    expect(keepsRinging(ev, { requestId: 'r-2', expiresAt: 1_000_000 }, 'r-1', 900_000, here)).toBe(false);
    // Lapsed.
    expect(keepsRinging(ev, ringing, 'r-1', 1_000_000, here)).toBe(false);
    // The sound switched off meanwhile, or the member walked into a meeting or a live event.
    expect(keepsRinging(ev, ringing, 'r-1', 900_000, { ...here, soundOn: false })).toBe(false);
    expect(keepsRinging(ev, ringing, 'r-1', 900_000, { ...here, pathname: '/meet/c-9' })).toBe(false);
  });

  it('the chime hook repeats the ring through keepsRinging, reading the call layer, and clears its timer', () => {
    const hook = read('hooks/useMessageChime.ts');
    expect(hook).toMatch(/useCallStore\.getState\(\)\.incoming/);
    expect(hook).toMatch(/keepsRinging\(ev, /);
    expect(hook).toMatch(/window\.setInterval\(/);
    expect(hook).toMatch(/window\.clearInterval\(/);
  });
});
