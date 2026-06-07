// P2 event-reliability programme (approved 2026-06-07, spec in
// docs/superpowers/plans/2026-06-07-bg-architectural-fix.md §3) — source pins
// for the no-functional-change perf fixes. Each pin encodes WHY so a future
// refactor can't silently reintroduce the cost.
import * as nodeFs from 'fs';
import * as nodePath from 'path';

const clientSrc = (rel: string) =>
  nodeFs.readFileSync(nodePath.join(__dirname, '../../../../client/src', rel), 'utf8');

describe('P2-1 — live components subscribe to FIELDS, never the whole store', () => {
  // A bare `useSessionStore()` re-renders its component on EVERY store write —
  // each 1s timer tick, every chat message, every presence change. In the
  // lobby that cascaded into the video grid; in useSessionSocket it re-rendered
  // the entire LiveSessionPage tree. Selectors (or a stable actions grab for
  // action-only consumers) make re-renders proportional to what actually
  // changed.
  it('no bare whole-store subscriptions remain in live-path files', () => {
    const files = [
      'features/live/Lobby.tsx',
      'features/live/VideoRoom.tsx',
      'features/live/LiveSessionPage.tsx',
      'hooks/useSessionSocket.ts',
    ];
    for (const f of files) {
      const src = clientSrc(f);
      expect(`${f}: ${/=\s*useSessionStore\(\);/.test(src)}`).toBe(`${f}: false`);
    }
  });

  it('useSessionSocket grabs stable actions without subscribing', () => {
    const src = clientSrc('hooks/useSessionSocket.ts');
    expect(src).toMatch(/useRef\(useSessionStore\.getState\(\)\)\.current/);
  });
});
