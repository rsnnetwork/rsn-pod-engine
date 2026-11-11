// server/src/__tests__/client/p3-waitlist.test.ts
// Part 3 Task 8 (10 Nov 2026 spec 03 "Registration: capacity limits, waiting list"; plan K3): the screens of Task 3's
// waiting list, on the preview client.
//
// 1. The words, verbatim from the brief: the event page's "This event is full." / "Join the waiting list" /
//    "On the waiting list · number {n}" / "Leave the waiting list", the 202 toast, the call link's waitlisted screen, the
//    organisers' "Waiting list" card and the approve toast when the approval queued the person.
// 2. Register sends `waitlist: true` only when the server says the event is full; a 202 is read as a place in the line.
// 3. Real time: the event read follows session:<id> and session:<id>:waitlist; the organisers' list follows the line and
//    the event's places; the call link follows the line once it knows the event. Nobody writes into a cached answer.
// 4. The call link's step 'waitlisted' is its own screen; the guest home names it.
// 5. Leaving the line, "Let in now" and "Remove" ask first.
// 6. Every control the new screens draw is at least 44px tall.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CallEntryState, CallLanding, WaitlistEntryCard } from '@rsn/shared';
import {
  CALL_API, CALL_WORDS, callScreenOf, progressIndexOf, waitlistedSentence,
} from '../../../../client/src/features/call/call-entry';
import {
  JOINED_VIA_LABEL, WAITLIST_COPY, approvedQueuedPosition, notForThisViewer, registerBody, showsWaitlistCard,
  waitlistRowLine, waitlistedPosition,
} from '../../../../client/src/features/sessions/waitlist/waitlist-text';
import { iconStandIns, loadClientModule, readClientSource } from './load-client-module';

const read = readClientSource;
const WAITLIST_DIR = 'features/sessions/waitlist';

// ─── 1. The words ──────────────────────────────────────────────────────────────────────────────────────────────────

describe('the waiting list says exactly the brief\'s words', () => {
  it('the event page', () => {
    expect(WAITLIST_COPY.full).toBe('This event is full.');
    expect(WAITLIST_COPY.join).toBe('Join the waiting list');
    expect(WAITLIST_COPY.onLine(3)).toBe('On the waiting list · number 3');
    expect(WAITLIST_COPY.leave).toBe('Leave the waiting list');
    expect(`${WAITLIST_COPY.leaveTitle} ${WAITLIST_COPY.leaveBody}`).toBe("Leave the waiting list? You'll lose your place in the line.");
    expect(WAITLIST_COPY.joinedToast(2)).toBe("This event is full. You're number 2 on the waiting list.");
    expect(WAITLIST_COPY.fullChip).toBe('Full');
  });

  it('the call link', () => {
    expect(waitlistedSentence('Founders evening', 1)).toBe("Founders evening is full. You're number 1 on the waiting list.");
    expect(CALL_WORDS.waitlistMore).toBe("We'll email you and ring your bell the moment a place opens, and it's yours.");
    expect(CALL_WORDS.leaveWaitlist).toBe(WAITLIST_COPY.leave);
    expect(CALL_WORDS.leaveWaitlistTitle).toBe(WAITLIST_COPY.leaveTitle);
    expect(CALL_WORDS.leaveWaitlistBody).toBe(WAITLIST_COPY.leaveBody);
    expect(CALL_API.leaveWaitlist('ab c')).toBe('/call-links/ab%20c/waitlist');
  });

  it('the organisers\' card and the approve toast', () => {
    expect(WAITLIST_COPY.cardTitle).toBe('Waiting list');
    expect(WAITLIST_COPY.count(4)).toBe('4 people waiting');
    expect(WAITLIST_COPY.count(1)).toBe('1 person waiting');
    expect(WAITLIST_COPY.empty).toBe('Nobody is waiting.');
    expect(WAITLIST_COPY.letIn).toBe('Let in now');
    expect(`${WAITLIST_COPY.letInTitle('Ana')} ${WAITLIST_COPY.letInBody}`).toBe('Let Ana in? This goes over the capacity you set.');
    expect(WAITLIST_COPY.remove).toBe('Remove');
    expect(WAITLIST_COPY.approvedQueued('Ana', 2)).toBe('Approved. The event is full, so Ana is number 2 on the waiting list.');
  });

  it('a row says the place in the line and how the person joined it, in words', () => {
    const row = entry({ position: 2, joinedVia: 'call_link', accountKind: 'event_guest' });
    expect(waitlistRowLine(row)).toBe(`Number 2 · ${JOINED_VIA_LABEL.call_link} · Guest`);
    expect(waitlistRowLine(entry({ position: 1, joinedVia: 'register' }))).toBe(`Number 1 · ${JOINED_VIA_LABEL.register}`);
    for (const label of Object.values(JOINED_VIA_LABEL)) expect(label).not.toMatch(/_/);
  });

  it('no screen of the waiting list says "session" or shows a raw id', () => {
    const files = [`${WAITLIST_DIR}/WaitlistCard.tsx`, `${WAITLIST_DIR}/waitlist-text.ts`, `${WAITLIST_DIR}/useWaitlist.ts`];
    for (const rel of files) {
      const strings = Array.from(read(rel).matchAll(/'([^'\n]*)'|`([^`\n]*)`/g)).map((m) => m[1] ?? m[2])
        .filter((s) => /\s/.test(s) && !s.startsWith('/') && !s.includes('${sessionId}'));
      for (const s of strings) expect({ rel, s, session: /\bsession\b/i.test(s) }).toEqual({ rel, s, session: false });
    }
  });
});

// ─── 2. Register, and its answer ───────────────────────────────────────────────────────────────────────────────────

describe('Register asks for the waiting list only when the event is full', () => {
  it('registerBody: { waitlist: true } only when access.waitlist.full', () => {
    expect(registerBody({ waitlist: { full: true, position: null } })).toEqual({ waitlist: true });
    expect(registerBody({ waitlist: { full: false, position: null } })).toBeUndefined();
    // A server before Task 3 sends no waitlist block: the body is as today.
    expect(registerBody({})).toBeUndefined();
    expect(registerBody(undefined)).toBeUndefined();
  });

  it('the event page\'s Register sends that body, and reads a 202 as a place in the line', () => {
    const page = read('features/sessions/SessionDetailPage.tsx');
    // Part 3 Task 10: the same body, plus the group and answers a "Before you join" retry gave (registerBodyWith).
    expect(page).toContain('api.post(`/sessions/${sessionId}/register`, registerBodyWith(registerBody(access), choices))');
    expect(page).toContain('const position = waitlistedPosition(res);');
    expect(page).toContain('addToast(WAITLIST_COPY.joinedToast(position), \'info\')');
    // The auto-register on opening never asks for the line (the server never auto-registers onto a full event).
    expect(page).toContain('api.post(`/sessions/${sessionId}/register`).then(');
  });

  it('waitlistedPosition: only a 202 that says waitlisted', () => {
    expect(waitlistedPosition({ status: 202, data: { data: { waitlisted: true, position: 4 } } })).toBe(4);
    expect(waitlistedPosition({ status: 201, data: { data: { id: 'p', status: 'registered' } } })).toBeNull();
    expect(waitlistedPosition({ status: 202, data: { data: {} } })).toBeNull();
    expect(waitlistedPosition({ status: 200 })).toBeNull();
  });

  it('a double press joins the line once: the press is ignored while one is on its way', () => {
    const page = read('features/sessions/SessionDetailPage.tsx');
    expect(page).toContain('if (registerInFlight.current) return;');
    expect(page).toContain('registerInFlight.current = true;');
    expect(page).toMatch(/onSettled: \(\) => \{\s*registerInFlight\.current = false;/);
    expect(page).toContain('onRegister={register}');
  });

  it('SESSION_FULL on a plain Register reads the event again, so the page offers the line', () => {
    const page = read('features/sessions/SessionDetailPage.tsx');
    expect(page).toMatch(/errCode === 'SESSION_FULL'[^]*?qc\.invalidateQueries\(\{ queryKey: \['session', sessionId\] \}\)/);
  });

  it('approvedQueuedPosition: the approve answer\'s waitlistPosition, else null', () => {
    expect(approvedQueuedPosition({ id: 'r', status: 'approved', waitlistPosition: 3 })).toBe(3);
    expect(approvedQueuedPosition({ id: 'r', status: 'approved', waitlistPosition: null })).toBeNull();
    expect(approvedQueuedPosition(undefined)).toBeNull();
  });

  it('the requests card toasts the queued approval in the brief\'s words', () => {
    const card = read('features/sessions/EventJoinRequestsCard.tsx');
    expect(card).toContain('const queued = verb === \'approve\' ? approvedQueuedPosition(res.data?.data) : null;');
    expect(card).toContain('WAITLIST_COPY.approvedQueued(name, queued)');
  });
});

// ─── 3. Real time ──────────────────────────────────────────────────────────────────────────────────────────────────

describe('the waiting list follows the server without a refresh', () => {
  it('the event read (and its access block) follows session:<id> and session:<id>:waitlist', () => {
    const page = read('features/sessions/SessionDetailPage.tsx');
    expect(page).toContain('meta: { entities: sessionId ? [E.session(sessionId), E.sessionWaitlist(sessionId)] : [] },');
  });

  it('a promotion flips the page to Registered: the participants read follows session:<id> and its places', () => {
    const page = read('features/sessions/SessionDetailPage.tsx');
    expect(page).toContain('meta: { entities: sessionId ? [E.session(sessionId), E.sessionParticipants(sessionId)] : [] },');
    expect(page).toContain("const isRegistered = (participants || []).some((p: any) => p.userId === user?.id && p.status !== 'removed');");
  });

  it('the organisers\' list follows the line and the event\'s places', () => {
    const hook = read(`${WAITLIST_DIR}/useWaitlist.ts`);
    expect(hook).toContain("queryKey: ['session-waitlist', sessionId]");
    expect(hook).toContain('meta: { entities: [E.sessionWaitlist(sessionId), E.sessionParticipants(sessionId)] },');
    // Review I2 (11 Nov 2026): nor a 429, whose re-read waits for the limit's window (realtime/rate-limited-reads.ts).
    expect(hook).toContain('retry: (count, err: unknown) => !notForThisViewer(err) && !isRateLimited(err) && count < 2');
  });

  it('the call link follows the line once it knows the event', () => {
    const hook = read('features/call/useCallLink.ts');
    expect(hook).toContain('E.session(sessionId), E.sessionParticipants(sessionId), E.sessionGroups(sessionId), E.sessionWaitlist(sessionId)');
  });

  it('nothing writes into a cached answer', () => {
    for (const rel of [
      `${WAITLIST_DIR}/WaitlistCard.tsx`, `${WAITLIST_DIR}/useWaitlist.ts`, 'features/sessions/EventAccessActions.tsx',
      'features/sessions/SessionDetailPage.tsx', 'features/call/CallLinkPage.tsx', 'features/call/useCallLink.ts',
    ]) expect({ rel, sets: read(rel).includes('setQueryData') }).toEqual({ rel, sets: false });
  });
});

// ─── 3b. A person still waiting (server b836787e: the page opens, the attendee list and live state do not) ─────────

describe('the page of someone still on the line reads nothing that refuses them', () => {
  const page = read('features/sessions/SessionDetailPage.tsx');

  it('the attendee list is read only once they hold no number in the line, and a 403 is not retried', () => {
    expect(page).toContain('const waitingInLine = session?.access?.waitlist?.position != null;');
    expect(page).toContain('enabled: !!sessionId && !waitingInLine,');
    // Review I2: nor a 429 (its re-read waits for the limit's window).
    expect(page).toContain('(err as { response?: { status?: number } })?.response?.status !== 403 && !isRateLimited(err) && failureCount < 3,');
  });

  it('no people tile, no attendee list and no event chat while waiting; a plain line in their place', () => {
    expect(page).toContain('const tiles = facts.length + (waitingInLine ? 0 : 1);');
    expect(page).toMatch(/\{!waitingInLine && \(\s*<div className="text-center">\s*<div className="flex items-center justify-center gap-1 text-gray-500 mb-1">\s*<Users/);
    expect(page).toContain("{sessionId && (phase === 'done' || phase === 'live') && !waitingInLine && (");
    expect(page).toMatch(/\{!waitingInLine && \(\s*<div id="participants"/);
    expect(page).toContain('<Card data-testid="waitlist-people-later"');
    expect(WAITLIST_COPY.peopleLater).toBe("You'll see who's coming once a place is yours.");
  });

  it('nothing else on the page reads the live state', () => {
    expect(page).not.toMatch(/\/state[`'"]/);
  });

  it('the open-page registration meeting a full event reads the event again, with no error toast', () => {
    expect(page).toContain("if (code === 'SESSION_FULL') return void qc.invalidateQueries({ queryKey: ['session', sessionId] });");
  });
});

// ─── 4. The call link ──────────────────────────────────────────────────────────────────────────────────────────────

const LANDING = { lifecycle: 'upcoming', title: 'Founders evening' } as unknown as CallLanding;

function state(over: Partial<CallEntryState> = {}): CallEntryState {
  return {
    step: 'waitlisted', sessionId: 'e1', startsAt: null, livePath: null, refusal: null, waitlistPosition: 1,
    missing: { displayName: false, group: false, admissionCode: false },
    ...over,
  } as CallEntryState;
}

describe('the call link\'s waitlisted screen', () => {
  it('the step "waitlisted" is its own screen, on the last dot, whether or not they pressed Join', () => {
    expect(callScreenOf({ landing: LANDING, entry: state(), phase: 'summary', started: false })).toBe('waitlisted');
    expect(callScreenOf({ landing: LANDING, entry: state(), phase: 'summary', started: true })).toBe('waitlisted');
    expect(progressIndexOf('waitlisted')).toBe(3);
  });

  it('the guest home names it', () => {
    expect(read('features/call/GuestHome.tsx')).toContain("waitlisted: { label: 'On the waiting list', tone: 'wait' },");
  });

  const step = (over: Record<string, unknown> = {}) => {
    const mod = loadClientModule('features/call/CallWaitingStep.tsx', {
      'lucide-react': iconStandIns,
      'react-router-dom': { useNavigate: () => () => undefined },
      './useCallLink': { useMySchedule: () => ({ data: null }) },
      '@/hooks/useConfirm': { useConfirm: () => ({ ask: async () => true, confirmDialog: null }) },
    });
    return renderToStaticMarkup(createElement(mod.default as never, {
      landing: LANDING, kind: 'waitlisted', sessionId: 'e1', startsAt: null, guest: true, position: 2,
      onLeave: async () => undefined, leaving: false, ...over,
    } as never));
  };

  it('draws "{title} is full. You\'re number {n} …", the promise, and Leave the waiting list', () => {
    const html = step();
    expect(html).toContain('data-testid="call-waitlisted"');
    expect(html).toContain('Founders evening is full. You&#x27;re number 2 on the waiting list.');
    expect(html).toContain('We&#x27;ll email you and ring your bell the moment a place opens, and it&#x27;s yours.');
    expect(html).toContain('data-testid="call-leave-waitlist"');
    expect(html).toContain('Leave the waiting list');
    const controls = Array.from(html.matchAll(/<(button|a)\b[^>]*>/g)).map((m) => m[0]);
    expect(controls.length).toBe(2);
    for (const c of controls) expect({ c, tall: /min-h-\[(44|48)px\]/.test(c) }).toEqual({ c, tall: true });
  });

  it('the page passes the position and leaves through the call link, then starts again from the summary', () => {
    const page = read('features/call/CallLinkPage.tsx');
    expect(page).toContain("case 'waitlisted':");
    expect(page).toContain('position={state?.waitlistPosition ?? null}');
    expect(page).toContain('await leaveWaitlist.mutateAsync();');
    const hook = read('features/call/useCallLink.ts');
    expect(hook).toContain('api.delete(CALL_API.leaveWaitlist(code))');
  });
});

// ─── 4b. Leaving the line never queues them again by itself (preview smoke, 11 Nov 2026) ───────────────────────────
//
// The leave's own refresh reads the entry again (step 'details', nothing missing) before mutateAsync resolves. With
// `started` still true that is the 'joining' screen, and its effect entered at once: the guest was back in line at the
// back. A guest who gave their name on the details step entered through giveDetails, so `autoTried` was still false.

describe('leaving the line on the call link never enters again by itself', () => {
  const page = read('features/call/CallLinkPage.tsx');
  const leaveFn = page.slice(page.indexOf('const leaveTheLine = async () => {'), page.indexOf('const joinAgain = () => {'));

  it('the hazard: a signed-in person with nothing missing who had pressed Join is on the joining screen', () => {
    const afterLeave = state({ step: 'details', waitlistPosition: null });
    expect(callScreenOf({ landing: LANDING, entry: afterLeave, phase: 'summary', started: true })).toBe('joining');
    expect(callScreenOf({ landing: LANDING, entry: afterLeave, phase: 'summary', started: false })).toBe('summary');
  });

  it('before the request: back to the summary and the automatic enter spent', () => {
    expect(leaveFn).toMatch(/const leaveTheLine = async \(\) => \{\s*setStarted\(false\);\s*setAutoTried\(true\);\s*try \{\s*await leaveWaitlist\.mutateAsync\(\);/);
  });

  it('nothing in the leave re-arms the automatic enter or starts again', () => {
    expect(leaveFn.length).toBeGreaterThan(100);
    expect(leaveFn).not.toContain('setAutoTried(false)');
    expect(leaveFn).not.toContain('setStarted(true)');
  });

  it('the automatic enter runs only on the joining screen and only once until re-armed', () => {
    expect(page).toContain("if (screen !== 'joining' || autoTried || enter.isPending) return;");
  });

  it('only the summary\'s Join press re-arms it', () => {
    expect(page).toMatch(/const joinAgain = \(\) => \{\s*setAutoTried\(false\);\s*setStarted\(true\);\s*\};/);
    expect(page).toContain("onClick={() => (userId ? joinAgain() : setPhase('email'))}");
    expect(page.match(/joinAgain\(\)/g)).toHaveLength(1);
  });

  it('"Not you?" re-arms it for whoever signs in next (a leave spent it; no endless joining spinner)', () => {
    expect(page).toMatch(/const signOut = async \(\) => \{\s*await logout\(\);\s*setStarted\(false\);[^}]*?setAutoTried\(false\);[^}]*?\};/);
  });
});

// ─── 5. Confirm first ──────────────────────────────────────────────────────────────────────────────────────────────

describe('leaving the line, Let in now and Remove ask first', () => {
  it('the event page\'s Leave the waiting list', () => {
    const src = read('features/sessions/EventAccessActions.tsx');
    expect(src).toMatch(/await askFirst\(\{ title: WAITLIST_COPY\.leaveTitle, body: WAITLIST_COPY\.leaveBody, confirmLabel: WAITLIST_COPY\.leave, tone: 'danger' \}\)[^]*?leave\.mutate\(\)/);
  });

  it('the call link\'s Leave the waiting list', () => {
    const src = read('features/call/CallWaitingStep.tsx');
    expect(src).toMatch(/await ask\(\{ title: CALL_WORDS\.leaveWaitlistTitle, body: CALL_WORDS\.leaveWaitlistBody, confirmLabel: CALL_WORDS\.leaveWaitlist, tone: 'danger' \}\)[^]*?await onLeave\(\)/);
  });

  it('the card\'s Let in now and Remove', () => {
    const src = read(`${WAITLIST_DIR}/WaitlistCard.tsx`);
    expect(src).toMatch(/await ask\(\{ title: WAITLIST_COPY\.letInTitle\(row\.displayName\), body: WAITLIST_COPY\.letInBody, confirmLabel: WAITLIST_COPY\.letIn \}\)[^]*?admit\.mutate\(row\)/);
    expect(src).toMatch(/await ask\(\{ title: WAITLIST_COPY\.removeTitle\(row\.displayName\), body: WAITLIST_COPY\.removeBody, confirmLabel: WAITLIST_COPY\.remove, tone: 'danger' \}\)[^]*?remove\.mutate\(row\)/);
    // No action runs straight from a click.
    expect(src).not.toMatch(/onClick=\{\(\) => (admit|remove)\.mutate/);
  });
});

// ─── The event page and the card, drawn ────────────────────────────────────────────────────────────────────────────

function entry(over: Partial<WaitlistEntryCard> = {}): WaitlistEntryCard {
  return {
    userId: 'u1', displayName: 'Ana', avatarUrl: null, position: 1, queuedAt: '2026-11-11T10:00:00.000Z',
    joinedVia: 'register', accountKind: 'member', ...over,
  };
}

const noop = () => undefined;
const mutation = { mutate: noop, mutateAsync: async () => undefined, isPending: false, variables: undefined };

function accessActions(access: Record<string, unknown>) {
  const mod = loadClientModule('features/sessions/EventAccessActions.tsx', {
    'lucide-react': iconStandIns,
    // Part 3 Task 10: the request sheet reads the event's questions (none here).
    '@tanstack/react-query': { useMutation: () => mutation, useQuery: () => ({ data: undefined, isLoading: false }), useQueryClient: () => ({ invalidateQueries: noop }) },
    '@/stores/toastStore': { useToastStore: (pick: (s: { addToast: () => void }) => unknown) => pick({ addToast: noop }) },
    '@/lib/api': { __esModule: true, default: {} },
    '@/hooks/useConfirm': { useConfirm: () => ({ ask: async () => true, confirmDialog: null }) },
    './waitlist/useWaitlist': { useLeaveWaitlist: () => mutation },
  });
  return renderToStaticMarkup(createElement(mod.default as never, {
    sessionId: 'e1', registerLabel: 'Register', onRegister: noop, registering: false,
    access: { visibility: 'public', mode: 'register', myRequest: null, autoRegister: false, canManageRequests: false, ...access },
  } as never));
}

describe('the event page offers the line when the event is full', () => {
  it('full, not on the line: "This event is full." and "Join the waiting list", no Register', () => {
    const html = accessActions({ waitlist: { full: true, position: null } });
    expect(html).toContain('data-testid="event-full"');
    expect(html).toContain('This event is full.');
    expect(html).toContain('data-testid="event-join-waitlist"');
    expect(html).toContain('Join the waiting list');
    expect(html).not.toContain('data-testid="event-register"');
  });

  it('on the line: "On the waiting list · number {n}" and Leave the waiting list, whatever the mode', () => {
    for (const mode of ['register', 'request']) {
      const html = accessActions({ mode, waitlist: { full: true, position: 2 } });
      expect(html).toContain('data-testid="event-on-waitlist"');
      expect(html).toContain('On the waiting list · number 2');
      expect(html).toContain('data-testid="event-leave-waitlist"');
      expect(html).not.toContain('Join the waiting list');
    }
  });

  it('not full: Register as today; a server with no waitlist block: Register as today', () => {
    expect(accessActions({ waitlist: { full: false, position: null } })).toContain('data-testid="event-register"');
    expect(accessActions({})).toContain('data-testid="event-register"');
  });

  it('an event that asks for approval keeps "Request to join" when full (the approval queues the person)', () => {
    const html = accessActions({ mode: 'request', waitlist: { full: true, position: null } });
    expect(html).toContain('data-testid="event-request-open"');
    expect(html).not.toContain('Join the waiting list');
  });

  it('the page shows a "Full" chip when the server says full, and hides "You can still join" from anyone it cannot take', () => {
    const page = read('features/sessions/SessionDetailPage.tsx');
    expect(page).toContain('data-testid="event-full-chip"');
    expect(page).toContain('{WAITLIST_COPY.fullChip}');
    expect(page).toContain('const cannotTakeMe = !!access?.waitlist && (access.waitlist.full || access.waitlist.position !== null);');
    expect(page).toMatch(/!isRegistered && !cannotTakeMe && \(/);
  });

  it('the organisers\' card sits on the page for the people running the event, before and during it', () => {
    const page = read('features/sessions/SessionDetailPage.tsx');
    expect(page).toContain("{mayRunEvent && (phase === 'pre' || phase === 'live') && sessionId && (");
    expect(page).toContain('<WaitlistCard sessionId={sessionId} full={!!access?.waitlist?.full} />');
  });
});

function waitlistCard(line: Record<string, unknown>, full: boolean) {
  const mod = loadClientModule(`${WAITLIST_DIR}/WaitlistCard.tsx`, {
    'lucide-react': iconStandIns,
    './useWaitlist': {
      useWaitlistLine: () => ({ isLoading: false, isError: false, error: null, data: [], refetch: noop, ...line }),
      useWaitlistActions: () => ({ admit: mutation, remove: mutation }),
    },
    '@/hooks/useConfirm': { useConfirm: () => ({ ask: async () => true, confirmDialog: null }) },
  });
  return renderToStaticMarkup(createElement(mod.default as never, { sessionId: 'e1', full } as never));
}

describe('the organisers\' Waiting list card', () => {
  it('lists the line in order with Let in now and Remove', () => {
    const html = waitlistCard({ data: [entry(), entry({ userId: 'u2', displayName: 'Ben', position: 2, joinedVia: 'approval' })] }, true);
    expect(html).toContain('data-testid="waitlist-card"');
    expect(html).toContain('Waiting list');
    expect(html).toContain('2 people waiting');
    expect(html.indexOf('Ana')).toBeLessThan(html.indexOf('Ben'));
    expect(html).toContain(`Number 2 · ${JOINED_VIA_LABEL.approval}`);
    expect(html.match(/data-testid="waitlist-row"/g)).toHaveLength(2);
    expect(html.match(/data-testid="waitlist-let-in"/g)).toHaveLength(2);
    expect(html.match(/data-testid="waitlist-remove"/g)).toHaveLength(2);
  });

  it('full with nobody waiting: "Nobody is waiting."', () => {
    expect(waitlistCard({ data: [] }, true)).toContain('Nobody is waiting.');
  });

  it('an event with room and nobody waiting draws nothing; nor does a refusal (403/404)', () => {
    expect(showsWaitlistCard(false, 0)).toBe(false);
    expect(showsWaitlistCard(false, 1)).toBe(true);
    expect(showsWaitlistCard(true, 0)).toBe(true);
    expect(waitlistCard({ data: [] }, false)).toBe('');
    expect(waitlistCard({ isError: true, error: { response: { status: 403 } } }, true)).toBe('');
    expect(waitlistCard({ isError: true, error: { response: { status: 404 } } }, true)).toBe('');
    expect(notForThisViewer({ response: { status: 403 } })).toBe(true);
    expect(notForThisViewer({ response: { status: 500 } })).toBe(false);
  });

  it('another failure says so with Try again; loading a full event is a skeleton', () => {
    expect(waitlistCard({ isError: true, error: { response: { status: 500 } } }, true)).toContain(WAITLIST_COPY.error);
    expect(waitlistCard({ isLoading: true, data: undefined }, true)).toContain('aria-busy="true"');
  });
});

// ─── 6. Tap targets ────────────────────────────────────────────────────────────────────────────────────────────────

describe('every control the waiting list draws is at least 44px tall', () => {
  it('the card, the event page\'s states and the call link screen', () => {
    const html = [
      waitlistCard({ data: [entry(), entry({ userId: 'u2', displayName: 'Ben', position: 2 })] }, true),
      waitlistCard({ isError: true, error: { response: { status: 500 } } }, true),
      accessActions({ waitlist: { full: true, position: null } }),
      accessActions({ waitlist: { full: true, position: 1 } }),
    ].join('');
    const controls = Array.from(html.matchAll(/<(button|a)\b[^>]*>/g)).map((m) => m[0]);
    expect(controls.length).toBe(4 + 1 + 1 + 1);
    for (const c of controls) expect({ c, tall: /min-h-\[(44|48)px\]/.test(c) }).toEqual({ c, tall: true });
  });
});
