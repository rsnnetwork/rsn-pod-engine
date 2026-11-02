// ─── T17: P2 polish on production's own client (1 Nov 2026) ──────────────────────────────────────────
//
// Items 2, 8, 9, 10, 11, 12 and 13 of the 25 Oct polish batch, on production's screens. The decisions
// are pure functions in their own files and are run here; what a component wires together is read
// from its source, the way the other pins in this folder do.

import { loadClientModule, readClientSource } from './load-client-module';

interface RoomRetry {
  ROOM_RETRY_DELAYS_MS: number[];
  planRoomRecovery: (attemptsMade: number) => { kind: 'retry'; delayMs: number } | { kind: 'lobby'; delayMs: number };
}
interface GuardState {
  RETRY_DELAYS_MS: number[];
  classifyGuardFailure: (status: number | undefined, attempt: number) => 'refused' | 'retry' | 'gone' | 'error';
  REFUSED_SENTENCE: string;
  UNREACHABLE_SENTENCE: string;
}
interface PokeAnswer {
  pokeAnswerView: (n: Record<string, unknown>) => { actions: boolean; label: { text: string; tone: 'accepted' | 'quiet' } | null };
}
interface RemindAll {
  remindAllToast: (answer: { reminded: number; total: number; recentlyReminded?: number }) => { message: string; type: 'success' | 'info' | 'error' };
  remindAllFailure: (serverMessage: string | undefined) => string;
}

const roomRetry = () => loadClientModule('features/live/room-retry.ts', {}) as unknown as RoomRetry;
const guard = () => loadClientModule('features/live/session-guard-state.ts', {}) as unknown as GuardState;
const poke = () => loadClientModule('components/ui/poke-answer.ts', {}) as unknown as PokeAnswer;
const remind = () => loadClientModule('features/sessions/remind-all-toast.ts', {}) as unknown as RemindAll;

describe('item 8: the speed-networking room retries in a bounded, explicit way', () => {
  it('backs off and gives up after two retries, then goes back to the main room', () => {
    const { planRoomRecovery, ROOM_RETRY_DELAYS_MS } = roomRetry();
    expect(ROOM_RETRY_DELAYS_MS).toEqual([2000, 4000]);
    expect(planRoomRecovery(0)).toEqual({ kind: 'retry', delayMs: 2000 });
    expect(planRoomRecovery(1)).toEqual({ kind: 'retry', delayMs: 4000 });
    expect(planRoomRecovery(2)).toEqual({ kind: 'lobby', delayMs: 2000 });
    expect(planRoomRecovery(50)).toEqual({ kind: 'lobby', delayMs: 2000 });
  });

  // Review fix round 1: every retry clears the token, which makes the backup fetch run; that fetch used to set the
  // count back to 0, so a connection that never succeeds was retried every 2 s for the whole round.
  it('keeps counting through a failure that does not go away: retry at 2 s, retry at 4 s, then the main room', () => {
    const { planRoomRecovery } = roomRetry();
    let attempts = 0; // only a successful connect or a return to the foreground sets this back
    const steps: Array<{ kind: string; delayMs: number }> = [];
    for (let failure = 0; failure < 3; failure++) {
      const plan = planRoomRecovery(attempts);
      steps.push(plan);
      if (plan.kind === 'retry') attempts++; // the token fetch that follows must not reset it
    }
    expect(steps).toEqual([{ kind: 'retry', delayMs: 2000 }, { kind: 'retry', delayMs: 4000 }, { kind: 'lobby', delayMs: 2000 }]);
  });

  it('does not reset the count when the backup token arrives', () => {
    const src = readClientSource('features/live/VideoRoom.tsx');
    const effect = src.slice(src.indexOf('// Backup token fetch if not provided inline'), src.indexOf('const handleReturnToLobby'));
    expect(effect).toMatch(/setLiveKitToken\(token, url\)/);
    expect(effect).not.toMatch(/retryCountRef/);
    const resets = src.match(/retryCountRef\.current = 0/g) ?? [];
    expect(resets.length).toBe(2); // handleRoomConnected and reconnectRoom only
  });

  it("ends a refused press's server sentence with a full stop", () => {
    expect(remind().remindAllFailure('Only the host can send reminders'))
      .toBe('No reminders were sent. Only the host can send reminders.');
  });

  // LiveKitRoom reconnects whenever the identity of `onError` changes (its connect effect lists it as a
  // dependency), and VideoRoom re-renders every second for the timer: an inline `onError={() => ...}` was a
  // room.connect() once a second. A room that is up and stable must keep the very same callback.
  it('hands LiveKitRoom callbacks that keep their identity between renders', () => {
    const src = readClientSource('features/live/VideoRoom.tsx');
    const room = src.slice(src.indexOf('<LiveKitRoom'), src.indexOf('className="flex-1 flex flex-col"'));
    expect(room).toMatch(/onError=\{handleRoomError\}/);
    expect(room).toMatch(/onDisconnected=\{handleRoomDisconnected\}/);
    expect(room).toMatch(/onConnected=\{handleRoomConnected\}/);
    expect(room).not.toMatch(/on(Error|Disconnected|Connected)=\{\s*\(/);
    for (const name of ['handleRoomError', 'handleRoomDisconnected', 'handleRoomConnected']) {
      expect(src).toMatch(new RegExp(`const ${name} = useCallback\\(`));
    }
  });

  it('plans every recovery through planRoomRecovery, with one pending recovery at a time', () => {
    const src = readClientSource('features/live/VideoRoom.tsx');
    expect(src).toMatch(/planRoomRecovery\(retryCountRef\.current\)/);
    expect(src).toMatch(/recoveryTimerRef/);
    expect(src).not.toMatch(/retryCountRef\.current < 2/);
  });
});

describe('item 9: a refused person gets a final sentence from the event guard', () => {
  it('treats a 403 as final at once, with no retries', () => {
    const { classifyGuardFailure, RETRY_DELAYS_MS } = guard();
    expect(classifyGuardFailure(403, 0)).toBe('refused');
    expect(classifyGuardFailure(403, 2)).toBe('refused');
    expect(classifyGuardFailure(404, 0)).toBe('retry');
    expect(classifyGuardFailure(undefined, 1)).toBe('retry');
    expect(classifyGuardFailure(404, RETRY_DELAYS_MS.length)).toBe('gone');
    expect(classifyGuardFailure(500, RETRY_DELAYS_MS.length)).toBe('error');
  });

  it('says it in plain sentences, never the library text', () => {
    const { REFUSED_SENTENCE, UNREACHABLE_SENTENCE } = guard();
    expect(REFUSED_SENTENCE).toBe('This event is not open to you.');
    expect(UNREACHABLE_SENTENCE).toMatch(/^We couldn't reach this event/);
    const src = readClientSource('features/live/SessionGuard.tsx');
    expect(src).not.toMatch(/err\?\.message/);
    expect(src).toMatch(/kind: 'refused'/);
    // Final fix wave C4: the refused screen is EventRefusedScreen, which the live page draws too.
    expect(src).toMatch(/<EventRefusedScreen /);
    expect(readClientSource('features/live/EventRefusedScreen.tsx')).toMatch(/REFUSED_SENTENCE/);
  });
});

describe('item 10: the live shell waits for the registration answer', () => {
  it('draws a loader, never the top bar, until the register call has answered', () => {
    const page = readClientSource('features/live/LiveSessionPage.tsx');
    const loader = page.indexOf('!registrationKnown');
    const shell = page.indexOf('<TestModeBanner />');
    expect(loader).toBeGreaterThan(0);
    expect(loader).toBeLessThan(shell);
    expect(page).toMatch(/if \(removedFromEvent\) return/);
    expect(page.indexOf('removedFromEvent) return')).toBeLessThan(shell);
  });

  it('marks the answer known on every outcome of the register call, the refusal included', () => {
    const hook = readClientSource('hooks/useSessionSocket.ts');
    const register = hook.slice(hook.indexOf('api.post(`/sessions/${sessionId}/register`)'), hook.indexOf('connectSocket(token);'));
    // `finally` runs after the refusal handler has marked the person removed, and after every other outcome.
    expect(register).toMatch(/\}\)\.finally\(\(\) => \{[\s\S]*?setRegistrationKnown\(true\)/);
    expect(register.indexOf('setRemovedFromEvent(true)')).toBeLessThan(register.indexOf('setRegistrationKnown(true)'));
    const store = readClientSource('stores/sessionStore.ts');
    expect(store).toMatch(/registrationKnown: false/);
  });
});

describe('item 11: the bell says "No longer available" for a request that is gone', () => {
  const base = { type: 'poke', link: '/messages?poke=11111111-1111-4111-8111-111111111111' };

  it('reads pokeStatus gone (closed account or block)', () => {
    expect(poke().pokeAnswerView({ ...base, pokeStatus: 'gone', requestState: null }))
      .toEqual({ actions: false, label: { text: 'No longer available', tone: 'quiet' } });
  });

  it('reads a withdrawn request: no row any more, so requestState is null', () => {
    expect(poke().pokeAnswerView({ ...base, pokeStatus: null, requestState: null }))
      .toEqual({ actions: false, label: { text: 'No longer available', tone: 'quiet' } });
    expect(poke().pokeAnswerView({ ...base, pokeStatus: null, requestState: { status: 'withdrawn', conversationId: null } }).label?.text)
      .toBe('No longer available');
  });

  it('keeps Accepted and Declined, and the buttons for a request still waiting', () => {
    expect(poke().pokeAnswerView({ ...base, pokeStatus: 'accepted' }).label).toEqual({ text: 'Accepted', tone: 'accepted' });
    expect(poke().pokeAnswerView({ ...base, pokeStatus: 'declined' }).label).toEqual({ text: 'Declined', tone: 'quiet' });
    expect(poke().pokeAnswerView({ ...base, pokeStatus: null, requestState: { status: 'pending', conversationId: null } }))
      .toEqual({ actions: true, label: null });
  });

  it('keeps the buttons on a request that just arrived over the socket (no requestState yet)', () => {
    expect(poke().pokeAnswerView({ ...base })).toEqual({ actions: true, label: null });
  });

  it('shows nothing for other kinds of notification, or a link that carries no request', () => {
    expect(poke().pokeAnswerView({ type: 'pod_invite', link: '/invite/abc' })).toEqual({ actions: false, label: null });
    expect(poke().pokeAnswerView({ type: 'poke', link: '/messages' })).toEqual({ actions: false, label: null });
  });

  // Production's bell draws pokeAnswerView; the preview's bell has its own request screen (bellRequestView),
  // so the wiring pin lives on main and the preview's own pin belongs to T16.
});

describe('item 12: the admin email page labels every seeded template', () => {
  it('has a label and a sentence for the keys seeded by migrations 020, 082 and 117', () => {
    const src = readClientSource('features/admin/AdminEmailPage.tsx');
    const start = src.indexOf('const EMAIL_TYPE_LABELS');
    const table = src.slice(src.indexOf('= {', start) + 2, src.indexOf('\n};', start) + 3);
    const labels = new Function(`return ${table}`)() as Record<string, { label: string; description: string }>;
    for (const key of ['magic_link', 'invite_pod', 'invite_session', 'invite_platform', 'recap', 'join_request_approved', 'join_request_declined', 'poke_request', 'poke_accepted', 'meeting_reminder']) {
      expect(labels[key]?.label).toBeTruthy();
      expect(labels[key]?.description).toBeTruthy();
    }
    expect(labels.meeting_reminder.label).toBe('Meeting Reminder');
    expect(labels.poke_request.label).toBe('Meeting Request');
    expect(labels.poke_accepted.label).toBe('Meeting Request Accepted');
    expect(JSON.stringify(labels)).not.toMatch(/RSN/);
  });
});

describe('item 13: Remind all says what happened', () => {
  it('says nothing was sent, as a warning and not in the success colour', () => {
    const { remindAllToast } = remind();
    expect(remindAllToast({ reminded: 0, total: 0, recentlyReminded: 0 }))
      .toEqual({ message: 'No reminders were sent. Nobody is waiting for a reminder.', type: 'info' });
    expect(remindAllToast({ reminded: 0, total: 0, recentlyReminded: 4 }))
      .toEqual({ message: 'No reminders were sent. Everyone was reminded less than an hour ago.', type: 'info' });
    expect(remindAllToast({ reminded: 0, total: 7, recentlyReminded: 0 }))
      .toEqual({ message: 'No reminders were sent. Please try again in a moment.', type: 'error' });
  });

  it('says how many of how many when the 50-a-press cap leaves more waiting', () => {
    expect(remind().remindAllToast({ reminded: 50, total: 120, recentlyReminded: 0 }))
      .toEqual({ message: 'Reminders sent to 50 of 120. Press Remind all again for the rest.', type: 'info' });
  });

  it('keeps the success colour for a press that reached everyone', () => {
    expect(remind().remindAllToast({ reminded: 1, total: 1 })).toEqual({ message: 'Reminders sent to 1 pending invite.', type: 'success' });
    expect(remind().remindAllToast({ reminded: 12, total: 12, recentlyReminded: 0 })).toEqual({ message: 'Reminders sent to 12 pending invites.', type: 'success' });
  });

  it('adds the server\'s reason to a refused press, or a plain sentence when there is none', () => {
    const { remindAllFailure } = remind();
    expect(remindAllFailure('You have sent a lot of reminders this hour. Please try again later.'))
      .toBe('No reminders were sent. You have sent a lot of reminders this hour. Please try again later.');
    expect(remindAllFailure(undefined)).toBe('No reminders were sent. Please try again in a moment.');
  });

  // Production's event page toasts remindAllToast; the preview's event page has its own Invitations card
  // and its own remind sentence, so the wiring pin lives on main.
});

describe('item 2: a pod card shrinks and breaks a long unbroken word', () => {
  it('lets the text column shrink and break, and keeps the badges from squeezing it', () => {
    const src = readClientSource('features/pods/PodsPage.tsx');
    // The grid's one column is minmax(0, 1fr): an auto column grows to the longest unbroken word.
    expect(src).toMatch(/grid grid-cols-1 gap-4/);
    const card = src.slice(src.indexOf('<Card key={pod.id}'), src.indexOf('</Card>'));
    expect(card).toMatch(/break-words/);
    // The badges drop under the name on a phone instead of squeezing it to a few letters a line.
    expect(card).toMatch(/flex flex-wrap items-center justify-between/);
    expect(card.match(/min-w-0/g)!.length).toBeGreaterThanOrEqual(2);
  });
});
