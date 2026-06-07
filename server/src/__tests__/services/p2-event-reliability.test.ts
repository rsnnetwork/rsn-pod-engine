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

describe('P2-5 — host-reconnect dashboard replay batches name lookups', () => {
  const serverSrc = (rel: string) =>
    nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');

  it('replay uses ONE ANY($1) lookup and guards every slot (no per-uid queries, no phantom NULL-B "User")', () => {
    const src = serverSrc('services/orchestration/handlers/participant-flow.ts');
    // scope to the host-reconnect replay block (a legitimate single-user
    // display-name lookup exists earlier in the file for the join path)
    const idx = src.indexOf('if (isHost && activeSession && hostDashboardStates)');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 3000);
    // the per-match getName round-trips are gone
    expect(block).not.toMatch(/WHERE id = \$1/);
    // replaced by the canonical builder's batched shape
    expect(block).toMatch(/SELECT id, display_name FROM users WHERE id = ANY\(\$1\)/);
    // every slot guarded — B is NULL for 1-person manual rooms (S25 lesson)
    expect(block).toMatch(/for \(const uid of \[m\.participantAId, m\.participantBId, m\.participantCId\]\) \{\s*if \(uid\) slotIds\.add\(uid\);/);
  });
});

describe('Bug B — waiting room converges on foreground (mobile stuck-at-start)', () => {
  // mobile browsers pause setInterval while backgrounded; the websocket is a
  // zombie — so a per-user must converge on visibilitychange/focus/online, not
  // only on the throttled 10s timer (else only a full refresh unblocks them).
  it('PreLobbyWaitingRoom re-runs convergence on return to foreground', () => {
    const src = clientSrc('features/live/Lobby.tsx');
    expect(src).toMatch(/const converge = async \(\)/);
    expect(src).toMatch(/document\.addEventListener\('visibilitychange', onForeground\)/);
    expect(src).toMatch(/window\.addEventListener\('focus', onForeground\)/);
    expect(src).toMatch(/window\.addEventListener\('online', onForeground\)/);
  });
});

describe('P2-3 — per-event SID markers are pruned on event exit', () => {
  it('LiveSessionPage clears the module-scope applied-prefs set on unmount', () => {
    expect(clientSrc('features/live/Lobby.tsx')).toMatch(/export function clearAppliedPrefMarkers/);
    expect(clientSrc('features/live/LiveSessionPage.tsx')).toMatch(/clearAppliedPrefMarkers\(\); \/\/ P2-3/);
  });
});

describe('P2-4 — host dashboard pushes only on change', () => {
  const serverSrc2 = (rel: string) =>
    nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');

  it('the immediate emit skips identical payloads, with a 30s heartbeat and audience-aware fingerprint', () => {
    const src = serverSrc2('services/orchestration/handlers/matching-flow.ts');
    // ticking field excluded (hosts render time from timerEndsAt — Bug 8.5)
    expect(src).toMatch(/timerSecondsRemaining: 0, _audience: hostIds/);
    // skip path + heartbeat belt
    expect(src).toMatch(/DASHBOARD_UNCHANGED_HEARTBEAT_MS = 30_000/);
    expect(src).toMatch(/fp === emitState\.lastPayloadFp && Date\.now\(\) - \(emitState\.lastSentAt \?\? 0\) < DASHBOARD_UNCHANGED_HEARTBEAT_MS/);
  });
});

describe('Bug② — a departed-but-was-matched person is not counted "not matched"', () => {
  const serverSrc3 = (rel: string) =>
    nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');

  it('host dashboard byeParticipants unions departed_user_ids', () => {
    const src = serverSrc3('services/orchestration/handlers/matching-flow.ts');
    expect(src).toMatch(/for \(const uid of \(m\.departedUserIds \?\? \[\]\)\) matchedUserIds\.add\(uid\)/);
  });
  it('match-preview bye list unions departed_user_ids', () => {
    const src = serverSrc3('services/orchestration/handlers/matching-flow.ts');
    expect(src).toMatch(/\.\.\.\(m\.departedUserIds \?\? \[\]\),/);
  });
  it('the /plan event-strip bye_count CTE unions departed_user_ids', () => {
    const src = serverSrc3('routes/sessions.ts');
    expect(src).toMatch(/UNION\s*SELECT m\.round_number, unnest\(m\.departed_user_ids\) AS user_id/);
  });
});

describe('P2-2 — notification poll pauses inside live events', () => {
  // ~240 useless /notifications requests per user per 2h event; the socket
  // listener keeps the badge live, and leaving the event resumes the poll.
  it('the 30s poll is gated off /session/*/live routes', () => {
    const src = clientSrc('components/ui/NotificationBell.tsx');
    expect(src).toMatch(/inLiveEvent = pathname\.startsWith\('\/session\/'\) && pathname\.includes\('\/live'\)/);
    expect(src).toMatch(/if \(inLiveEvent\) return;/);
    expect(src).toMatch(/\}, \[inLiveEvent\]\);/);
  });
});
