// server/src/__tests__/client/f3-one-tab-enters-the-call.test.ts
// Finding F3 (T19, 2 Nov 2026): a caller with a second tab of REASON open was put out of the call they rang from.
// The ring reaches every tab of the caller (user:<id>:calls reads the outgoing call again, so "Calling …" shows in
// each), and call:accepted sent EVERY such tab into /meet. Two connections with one identity joined the room and
// LiveKit put the first out ("client leave request reason: 2"), so the tab the member rang from fell back to the chat.
// Now the call remembers whether THIS tab placed it (placedHere): only that tab enters, every other tab just ends its
// Calling card. The callee side has no equivalent: only the tab whose Accept was pressed enters.
//
// EXECUTED, not read: the real callStore.ts is loaded once per "tab" (each load is its own store, with the real
// zustand), and the real call:* handlers (call-signals.ts) run against it. Only the router's navigate is a spy.
import * as fs from 'fs';
import * as path from 'path';
import type { LiveCallRequest } from '@rsn/shared';
import { loadClientModule } from './load-client-module';
import { fromLive, fromRung, reconcile, type RingingCall } from '../../../../client/src/features/calls/call-ring';

const CLIENT = path.join(__dirname, '../../../../client/src');
/** A client file, comments stripped, so a word in a comment is never read as code. */
const src = (rel: string) => fs.readFileSync(path.join(CLIENT, rel), 'utf8')
  .replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

interface CallState {
  incoming: RingingCall | null;
  outgoing: RingingCall | null;
  setIncoming: (call: RingingCall | null) => void;
  setOutgoing: (call: RingingCall | null) => void;
  end: (requestId: string) => void;
}
interface Handlers {
  onRequest: (d: { requestId: string; conversationId: string; fromUserId: string; fromName: string; kind: 'audio' | 'video'; durationMin: number }) => void;
  onAccepted: (d: { requestId: string; conversationId: string; kind: 'audio' | 'video' }) => void;
  onDeclined: (d: { requestId: string; byName: string }) => void;
  onCancelled: (d: { requestId: string }) => void;
}

/** One browser tab: its own call store, its own router, the app's call:* handlers. */
function openTab() {
  const { useCallStore } = loadClientModule('stores/callStore.ts', {}) as { useCallStore: { getState: () => CallState } };
  const { callSignalHandlers } = loadClientModule('features/calls/call-signals.ts', {}) as {
    callSignalHandlers: (deps: { store: () => CallState; navigate: (to: string) => void; toast: (message: string) => void }) => Handlers;
  };
  const navigate = jest.fn();
  const toast = jest.fn();
  const on = callSignalHandlers({ store: useCallStore.getState, navigate, toast });
  return { state: useCallStore.getState, navigate, toast, on };
}

const live: LiveCallRequest = {
  id: 'rq-1', conversationId: 'conv-1', fromUserId: 'u-pat', toUserId: 'u-quin', partnerName: 'Quin', kind: 'video',
  durationMin: 15, createdAt: '2026-11-02T10:00:00.000Z', expiresAt: '2026-11-02T10:02:00.000Z',
};
const rung = { id: 'rq-1', conversationId: 'conv-1', fromUserId: 'u-pat', toUserId: 'u-quin', kind: 'video' as const, durationMin: 15, createdAt: '2026-11-02T10:00:00.000Z' };
const accepted = { requestId: 'rq-1', conversationId: 'conv-1', kind: 'video' as const };

describe('F3: the caller has two tabs open; only the tab that rang enters the room', () => {
  it('a call this tab rang is placed here; the same call read from the server is not', () => {
    expect(fromRung(rung, 'Quin', 1).placedHere).toBe(true);
    expect(fromLive(live, 'outgoing', 1).placedHere).toBe(false);
    expect(fromLive(live, 'incoming', 1).placedHere).toBe(false);
    // A tab that remembers it rang this call (a refresh while it rings) reads it back as its own.
    expect(fromLive(live, 'outgoing', 1, true).placedHere).toBe(true);
  });

  it('the read that follows the ring in the tab that rang leaves its call (and the mark) as it was', () => {
    const mine = fromRung(rung, 'Quin', 1000);
    expect(reconcile(mine, fromLive(live, 'outgoing', 2000), 2000)).toBeUndefined();
  });

  it('call:accepted takes the tab that rang into the room; the other tab only ends its Calling card', () => {
    const rang = openTab();
    const other = openTab();
    expect(rang.state).not.toBe(other.state); // two tabs, two stores
    rang.state().setOutgoing(fromRung(rung, 'Quin', 1000));
    other.state().setOutgoing(fromLive(live, 'outgoing', 1500)); // the read that the ring's tag set off
    for (const tab of [rang, other]) tab.on.onAccepted(accepted);
    expect(rang.navigate).toHaveBeenCalledTimes(1);
    expect(rang.navigate).toHaveBeenCalledWith('/meet/conv-1?kind=video');
    expect(other.navigate).not.toHaveBeenCalled();
    expect(rang.state().outgoing).toBeNull();
    expect(other.state().outgoing).toBeNull();
  });

  it('whichever order the tabs hear it in, and however many there are, exactly one enters', () => {
    const tabs = [openTab(), openTab(), openTab()];
    tabs[0].state().setOutgoing(fromLive(live, 'outgoing', 1));
    tabs[1].state().setOutgoing(fromRung(rung, 'Quin', 1));
    tabs[2].state().setOutgoing(fromLive(live, 'outgoing', 1));
    for (const tab of [tabs[2], tabs[0], tabs[1]]) tab.on.onAccepted(accepted);
    expect(tabs.map((t) => t.navigate.mock.calls.length)).toEqual([0, 1, 0]);
  });

  it('a call rung on another device enters no tab here, and an answer to some other call is ignored', () => {
    const tab = openTab();
    tab.state().setOutgoing(fromLive(live, 'outgoing', 1));
    tab.on.onAccepted({ ...accepted, requestId: 'rq-other' });
    expect(tab.state().outgoing?.requestId).toBe('rq-1');
    tab.on.onAccepted(accepted);
    expect(tab.navigate).not.toHaveBeenCalled();
    expect(tab.state().outgoing).toBeNull();
  });

  it('a decline is said in every tab that shows the call, and ends it there', () => {
    const rang = openTab();
    const other = openTab();
    rang.state().setOutgoing(fromRung(rung, 'Quin', 1));
    other.state().setOutgoing(fromLive(live, 'outgoing', 1));
    for (const tab of [rang, other]) tab.on.onDeclined({ requestId: 'rq-1', byName: 'Quin' });
    for (const tab of [rang, other]) {
      expect(tab.toast).toHaveBeenCalledWith("Quin can't take the call right now.");
      expect(tab.state().outgoing).toBeNull();
      expect(tab.navigate).not.toHaveBeenCalled();
    }
  });

  it('Cancel that the server answers "accepted" enters the room only from the tab that rang', () => {
    const card = src('features/calls/OutgoingCallCard.tsx');
    expect(card).toMatch(/if \(outcome\.status === 'accepted' && call\.placedHere\) navigate\(callRoomPath\(outcome\.conversationId, outcome\.kind\)\);/);
  });

  it('the ring marks the call as placed here, in the store and for a refresh of this tab; reads ask that mark', () => {
    const hook = src('features/calls/useCallRequest.ts');
    expect(hook).toMatch(/rememberPlacedHere\(rung\.id\);\s*useCallStore\.getState\(\)\.setOutgoing\(fromRung\(rung,/);
    expect(hook).toMatch(/setOutgoing\(fromLive\(mine, 'outgoing', askedAt, wasPlacedHere\(mine\.id\)\)\)/);
    const signals = src('features/calls/useCallSignals.ts');
    expect(signals).toMatch(/fromLive\(call, 'outgoing', askedAt, wasPlacedHere\(call\.id\)\)/);
    expect(signals).toMatch(/callSignalHandlers\(\{ store: useCallStore\.getState, navigate, toast: \(m\) => addToast\(m, 'info'\) \}\)/);
    expect(signals).not.toMatch(/navigate\(callRoomPath/); // the handlers decide; the hook only wires them
  });
});

describe('F3, the callee side: only the tab whose Accept was pressed enters', () => {
  const request = { requestId: 'rq-1', conversationId: 'conv-1', fromUserId: 'u-pat', fromName: 'Pat', kind: 'video' as const, durationMin: 15 };

  it('both of the callee\'s tabs ring; the answer on one closes the other\'s banner without entering the room', () => {
    const answered = openTab();
    const other = openTab();
    for (const tab of [answered, other]) tab.on.onRequest(request);
    expect(other.state().incoming).toMatchObject({ requestId: 'rq-1', partnerName: 'Pat', placedHere: false });
    // The server closes the callee's other banners with call:cancelled (closeCalleeBanners); call:accepted goes
    // to the caller only, and even if a callee tab heard it, a ringing banner is not a call this tab placed.
    other.on.onCancelled({ requestId: 'rq-1' });
    other.on.onAccepted(accepted);
    expect(other.state().incoming).toBeNull();
    expect(other.navigate).not.toHaveBeenCalled();
  });

  it('the banner enters the room only from its own Accept, after the server took the answer', () => {
    const banner = src('components/ui/IncomingCallBanner.tsx');
    expect(banner.match(/navigate\(/g)).toHaveLength(1);
    expect(banner).toMatch(/const accept = async \(\) => \{[\s\S]*?await answerCall\(req\.requestId\);\s*useCallStore\.getState\(\)\.end\(req\.requestId\);\s*navigate\(callRoomPath\(req\.conversationId, req\.kind\)\);/);
  });
});
