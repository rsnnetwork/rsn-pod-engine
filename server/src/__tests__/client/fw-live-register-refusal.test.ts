// ─── A refused place on the live page is final, as a removal is (final fix wave C4, 2 Nov 2026) ──────────────────
//
// The live page registers the person as it opens. Only REMOVED_FROM_EVENT turned the answer into a final screen; an
// event that asks the host to approve each place (EVENT_NEEDS_APPROVAL) or is private (EVENT_PRIVATE) answered 403 and
// the page drew the live room anyway: the camera prompt, the top bar and an empty lobby, then a 5-second banner saying
// why. Such a refusal now draws the event guard's own refused screen ("This event is not open to you.", the server's
// reason, and "Open the event page" where the request is made) instead of the room. The rule is pure and runs here;
// the wiring is pinned by its source.

import * as fs from 'fs';
import * as path from 'path';
import { REFUSED_DETAIL, registerRefusal } from '../../../../client/src/features/live/session-guard-state';

const CLIENT = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(CLIENT, rel), 'utf8').replace(/\r\n/g, '\n');
const refused = (code: string, message: string) => ({ response: { status: 403, data: { error: { code, message } } } });

describe('which register answers are final on the live page', () => {
  it('an approval event: final, in the server words, with the way to the event page where the request is made', () => {
    expect(registerRefusal(refused('EVENT_NEEDS_APPROVAL', 'This event asks the host to approve each place. Request to join from the event page.')))
      .toEqual({ detail: 'This event asks the host to approve each place. Request to join from the event page.', requestOnEventPage: true });
  });

  it('a private event (or one of a closed circle): final, in the server words, with no request to make', () => {
    expect(registerRefusal(refused('EVENT_PRIVATE', 'This event is for the members of a closed circle. Ask to join the circle to take part.')))
      .toEqual({ detail: 'This event is for the members of a closed circle. Ask to join the circle to take part.', requestOnEventPage: false });
    expect(registerRefusal(refused('EVENT_PRIVATE', ''))).toEqual({ detail: REFUSED_DETAIL, requestOnEventPage: false });
  });

  it('anything else is not a final refusal here: already registered, a removal (its own screen), a network error', () => {
    expect(registerRefusal(refused('SESSION_ALREADY_REGISTERED', 'Already registered'))).toBeNull();
    expect(registerRefusal(refused('REMOVED_FROM_EVENT', 'You were removed'))).toBeNull();
    expect(registerRefusal(new Error('Network Error'))).toBeNull();
    expect(registerRefusal(undefined)).toBeNull();
  });
});

describe('the wiring', () => {
  it('the register call stores a final refusal before the answer is marked known, and holds the phase at complete', () => {
    const hook = read('hooks/useSessionSocket.ts');
    const register = hook.slice(hook.indexOf('api.post(`/sessions/${sessionId}/register`)'), hook.indexOf('connectSocket(token);'));
    expect(register).toMatch(/const refusal = registerRefusal\(err\);\s*if \(refusal\) \{\s*store\.setRefusedFromEvent\(refusal\);\s*store\.setLiveKitToken\(null, null\);\s*store\.setPhase\('complete'\);\s*return;\s*\}/);
    expect(register.indexOf('setRefusedFromEvent(refusal)')).toBeLessThan(register.indexOf('setRegistrationKnown(true)'));
    const store = read('stores/sessionStore.ts');
    expect(store).toMatch(/refusedFromEvent: null,/);
    expect(store).toMatch(/setPhase: \(phase\) => set\(\(s\) => \(\(s\.removedFromEvent \|\| s\.refusedFromEvent\) && phase !== 'complete'\) \? \{\} : \{ phase \}\),/);
    // A full reset (opening another event) clears it.
    expect(store.slice(store.indexOf('reset: () => set({'))).toMatch(/refusedFromEvent: null/);
  });

  it('the live page draws the refused screen before anything of the room, and the guard draws the same screen', () => {
    const page = read('features/live/LiveSessionPage.tsx');
    const refusedAt = page.indexOf('if (refusedFromEvent) return <EventRefusedScreen sessionId={sessionId} {...refusedFromEvent} />;');
    expect(refusedAt).toBeGreaterThan(0);
    expect(refusedAt).toBeLessThan(page.indexOf('if (!registrationKnown) return <PageLoader />;'));
    expect(refusedAt).toBeLessThan(page.indexOf('<TestModeBanner />'));
    const guard = read('features/live/SessionGuard.tsx');
    expect(guard).toMatch(/<EventRefusedScreen sessionId=\{sessionId\} detail=\{state\.detail\} requestOnEventPage=\{state\.requestOnEventPage\} \/>/);
    const screen = read('features/live/EventRefusedScreen.tsx');
    expect(screen).toContain('{REFUSED_SENTENCE}');
    expect(screen).toMatch(/Open the event page/);
    expect(screen).toMatch(/Back to events/);
  });
});
