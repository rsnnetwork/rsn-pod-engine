// Phase May 19 (Bug 32) — client-side realtime bridge pin.
//
// Two CRITICAL client-side issues were blocking realtime from working
// reliably across the whole app:
//
//   1. Socket auth race on cold-open: a stale token triggered handshake
//      failure → socket.io entered retry-backoff → subsequent
//      `connect()` calls were no-ops → the rotated token kept being
//      stuck on the dead connection until the natural retry timer.
//   2. NotificationBell mounted only inside AppLayout: the bell's
//      legacy invalidation listeners (pod:membership_updated,
//      session:list_changed, notification:new) never registered on
//      pages that render OUTSIDE the layout — live-event pages,
//      /invite/:code, /login, onboarding.
//
// Fix shape pinned here:
//   - authStore exposes `isSessionChecked` and flips it true in every
//     checkSession() exit branch. App.tsx gates the socket handshake
//     on this flag.
//   - lib/socket.ts exports `reconnectSocket(token)` that force-cycles
//     the connection (disconnect → set auth → connect) to escape
//     socket.io's retry-backoff state.
//   - App.tsx uses `reconnectSocket` on token rotation, gates the
//     connect on `isSessionChecked`, and surfaces persistent
//     connect_error failures via the toast store.
//   - The invalidation listeners moved into a new
//     `realtime/useLegacyInvalidationBridge` hook mounted at the App
//     root. The bridge owns query-cache invalidation; the bell keeps
//     only its component-local listener for the dropdown UI.
//
// This is a static-text pin file (lives in server tests by repo
// convention even though it asserts on client files).

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readClient(rel: string): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../../client/src', rel),
    'utf8',
  );
}

describe('Phase May 19 — client realtime bridge (Bug 32)', () => {
  describe('authStore — isSessionChecked gate', () => {
    const authSrc = readClient('stores/authStore.ts');

    it('declares isSessionChecked on the AuthState interface', () => {
      expect(authSrc).toMatch(/isSessionChecked:\s*boolean/);
    });

    it('initial state has isSessionChecked: false', () => {
      expect(authSrc).toMatch(/isSessionChecked:\s*false/);
    });

    it('flips isSessionChecked: true in every checkSession exit branch', () => {
      // Slice the implementation block — `checkSession: async () => {` up
      // to the next top-level method (`refreshAccessToken:` in the impl,
      // not the interface). Every set() call inside that slice should
      // include isSessionChecked: true — no-token, success, refresh-
      // success, refresh-fail, and the non-401 fall-through.
      const start = authSrc.indexOf('checkSession: async');
      expect(start).toBeGreaterThan(-1);
      const end = authSrc.indexOf('refreshAccessToken: async', start);
      expect(end).toBeGreaterThan(start);
      const block = authSrc.slice(start, end);
      const matches = block.match(/isSessionChecked:\s*true/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('lib/socket — reconnectSocket helper', () => {
    const socketSrc = readClient('lib/socket.ts');

    it('exports reconnectSocket(token: string): void', () => {
      expect(socketSrc).toMatch(
        /export\s+function\s+reconnectSocket\(\s*token:\s*string\s*\):\s*void/,
      );
    });

    it('forces a fresh handshake: disconnect, set auth, connect', () => {
      // Order matters — disconnect must come before connect, and auth must
      // be set before reconnect so the new token is what's sent.
      const fn = socketSrc.match(/export\s+function\s+reconnectSocket[\s\S]+?\n\}/);
      expect(fn).not.toBeNull();
      const body = fn![0];
      expect(body).toMatch(/s\.auth\s*=\s*\{\s*token\s*\}/);
      expect(body).toMatch(/s\.disconnect\(\)/);
      expect(body).toMatch(/s\.connect\(\)/);
      // disconnect appears before connect inside the function.
      const disconnectIdx = body.indexOf('s.disconnect()');
      const connectIdx = body.indexOf('s.connect()');
      expect(disconnectIdx).toBeGreaterThan(-1);
      expect(connectIdx).toBeGreaterThan(disconnectIdx);
    });
  });

  describe('App.tsx — wiring', () => {
    const appSrc = readClient('App.tsx');

    it('imports reconnectSocket from @/lib/socket', () => {
      expect(appSrc).toMatch(
        /import\s*\{[^}]*\breconnectSocket\b[^}]*\}\s*from\s*['"]@\/lib\/socket['"]/,
      );
    });

    it('imports and mounts useLegacyInvalidationBridge', () => {
      expect(appSrc).toMatch(
        /import\s*\{\s*useLegacyInvalidationBridge\s*\}\s*from\s*['"]@\/realtime\/useLegacyInvalidationBridge['"]/,
      );
      expect(appSrc).toMatch(/useLegacyInvalidationBridge\(\);/);
    });

    it('still mounts useEntityChangedHandler at the root next to the bridge', () => {
      expect(appSrc).toMatch(/useEntityChangedHandler\(\);/);
    });

    it('reads isSessionChecked from the auth store and gates the connect effect on it', () => {
      expect(appSrc).toMatch(/isSessionChecked\s*=\s*useAuthStore\(\s*\(s\)\s*=>\s*s\.isSessionChecked\s*\)/);
      // The connect effect must early-return when isSessionChecked is false.
      expect(appSrc).toMatch(/if\s*\(!isSessionChecked\)\s*return/);
      // And the effect's dependency array must include it.
    });

    it('uses reconnectSocket when the token rotates mid-session', () => {
      expect(appSrc).toMatch(/reconnectSocket\(accessToken\)/);
    });

    it('registers a connect_error handler that toasts after a failure threshold', () => {
      expect(appSrc).toMatch(/socket\.on\(\s*['"]connect_error['"]/);
      expect(appSrc).toMatch(/connect_error/);
      // Threshold-gated toast call.
      expect(appSrc).toMatch(/addToast\([^)]*disconnected/i);
    });
  });

  describe('realtime/useLegacyInvalidationBridge — hook shape', () => {
    const bridgeSrc = readClient('realtime/useLegacyInvalidationBridge.ts');

    it('exports the hook', () => {
      expect(bridgeSrc).toMatch(/export\s+function\s+useLegacyInvalidationBridge\(\s*\):\s*void/);
    });

    it('subscribes to the three legacy events with .on and unsubscribes with .off', () => {
      for (const ev of ['notification:new', 'pod:membership_updated', 'session:list_changed']) {
        const onRe = new RegExp(`socket\\.on\\(\\s*['"]${ev}['"]`);
        const offRe = new RegExp(`socket\\.off\\(\\s*['"]${ev}['"]`);
        expect(bridgeSrc).toMatch(onRe);
        expect(bridgeSrc).toMatch(offRe);
      }
    });

    it('subscribes to the forward-looking stub events (admin/user/notification list)', () => {
      // Stubs ride through `socket as any` because the typed contract
      // doesn't include them yet. The pin asserts the listener registration
      // is there.
      for (const ev of ['admin:list_changed', 'user:profile_changed', 'notification:list_changed']) {
        const onRe = new RegExp(`\\.on\\(\\s*['"]${ev}['"]`);
        const offRe = new RegExp(`\\.off\\(\\s*['"]${ev}['"]`);
        expect(bridgeSrc).toMatch(onRe);
        expect(bridgeSrc).toMatch(offRe);
      }
    });

    it('membership handler invalidates the full pod + user + admin + chat surface', () => {
      // A representative slice of the keys the spec called out. If any of
      // these go missing the legacy bridge silently regresses to "only
      // pods refresh".
      const requiredKeys = [
        // pod surfaces
        'my-pods', 'pod', 'pod-members', 'pod-pending-members',
        'pod-pending-invites', 'pod-sessions', 'pod-members-for-invite',
        // invite surfaces
        'received-invites', 'my-invites',
        // user-derived
        'user-block-status', 'blocked-users', 'can-message',
        'notification-prefs', 'my-support-tickets',
        // realtime-adjacent
        'encounters', 'dm-conversations', 'dm-groups', 'dm-unread-count',
        'host-state',
      ];
      // Bug 41 (19 May Ali) — bridge expanded to ~40 listeners; keys
      // now live in scoped const arrays (POD_QUERY_KEYS, etc.) instead
      // of inline qc.invalidateQueries calls. Pin the keys-as-strings
      // anywhere in the file so the test survives further refactors.
      for (const key of requiredKeys) {
        const re = new RegExp(`['"]${key}['"]`);
        expect(bridgeSrc).toMatch(re);
      }
    });

    it('admin-key inventory covers every admin-* surface from the spec', () => {
      const adminKeys = [
        'admin-users', 'admin-pods', 'admin-sessions', 'admin-violations',
        'admin-join-requests', 'admin-support-tickets', 'admin-stats',
        'admin-recent-matches', 'admin-analytics',
      ];
      for (const key of adminKeys) {
        const re = new RegExp(`['"]${key}['"]`);
        expect(bridgeSrc).toMatch(re);
      }
    });

    it('user:profile_changed handler invalidates [user, userId] keyed by payload', () => {
      // The dynamic-userId key is the cleanest test for "this handler
      // actually reads the payload" — otherwise the stub would invalidate
      // the wrong thing.
      expect(bridgeSrc).toMatch(/queryKey:\s*\[\s*['"]user['"]\s*,\s*data\.userId\s*\]/);
    });

    it('session:list_changed handler invalidates the session + invite surfaces', () => {
      const sessionKeys = [
        'my-sessions', 'pod-sessions', 'session', 'session-detail',
        'session-participants', 'session-pending-invites',
      ];
      for (const key of sessionKeys) {
        const re = new RegExp(`['"]${key}['"]`);
        expect(bridgeSrc).toMatch(re);
      }
    });

    it('Bug 41 — role/permissions/cohost/host-transfer events are listened for', () => {
      // The exact gap that made Raja need to refresh after being promoted
      // to host. These listeners did not exist in the previous bridge.
      expect(bridgeSrc).toMatch(/socket\.on\(\s*['"]permissions:updated['"]/);
      expect(bridgeSrc).toMatch(/socket\.on\(\s*['"]cohost:assigned['"]/);
      expect(bridgeSrc).toMatch(/socket\.on\(\s*['"]cohost:removed['"]/);
      expect(bridgeSrc).toMatch(/socket\.on\(\s*['"]host:transferred['"]/);
    });

    it('Bug 41 — session lifecycle + round events are listened for', () => {
      expect(bridgeSrc).toMatch(/socket\.on\(\s*['"]session:status_changed['"]/);
      expect(bridgeSrc).toMatch(/socket\.on\(\s*['"]session:round_started['"]/);
      expect(bridgeSrc).toMatch(/socket\.on\(\s*['"]session:round_ended['"]/);
      expect(bridgeSrc).toMatch(/socket\.on\(\s*['"]session:completed['"]/);
      expect(bridgeSrc).toMatch(/socket\.on\(\s*['"]host:event_plan_generated['"]/);
      expect(bridgeSrc).toMatch(/socket\.on\(\s*['"]host:event_plan_repaired['"]/);
      expect(bridgeSrc).toMatch(/socket\.on\(\s*['"]roster:changed['"]/);
    });

    it('Bug 41 — match lifecycle events are listened for', () => {
      expect(bridgeSrc).toMatch(/socket\.on\(\s*['"]match:assigned['"]/);
      expect(bridgeSrc).toMatch(/socket\.on\(\s*['"]match:reassigned['"]/);
      expect(bridgeSrc).toMatch(/socket\.on\(\s*['"]match:partner_disconnected['"]/);
      expect(bridgeSrc).toMatch(/socket\.on\(\s*['"]match:partner_reconnected['"]/);
    });
  });

  describe('NotificationBell — duplicate handlers removed', () => {
    const bellSrc = readClient('components/ui/NotificationBell.tsx');

    it('no longer registers session:list_changed (moved to bridge)', () => {
      expect(bellSrc).not.toMatch(/socket\.on\(\s*['"]session:list_changed['"]/);
    });

    it('keeps the local-state notification:new listener (component state only)', () => {
      expect(bellSrc).toMatch(/socket\.on\(\s*['"]notification:new['"]/);
      // And the handler sets local state, not query cache.
      const handlerMatch = bellSrc.match(/const\s+handler\s*=\s*\([^)]*\)\s*=>\s*\{[\s\S]+?\};/);
      expect(handlerMatch).not.toBeNull();
      const body = handlerMatch![0];
      expect(body).toMatch(/setNotifications/);
      expect(body).toMatch(/setUnreadCount/);
      expect(body).not.toMatch(/qc\.invalidateQueries/);
    });

    it('keeps only the local-refetch handler for pod:membership_updated (no cache work)', () => {
      // The bell can still re-pull its own notification list on membership
      // flips — that's component state. The big invalidation block is gone.
      expect(bellSrc).toMatch(/socket\.on\(\s*['"]pod:membership_updated['"]/);
      // Bridge-style block (the >10 invalidateQueries) must not survive in
      // the bell.
      const podMembershipUpdates = bellSrc.match(/socket\.on\(\s*['"]pod:membership_updated['"][\s\S]{0,400}/);
      expect(podMembershipUpdates).not.toBeNull();
      const region = podMembershipUpdates![0];
      // The relocated block had 13+ queryKey invalidations inline. Pin
      // that they're gone from THIS region.
      const inlineInvalidates = region.match(/qc\.invalidateQueries/g) ?? [];
      expect(inlineInvalidates.length).toBe(0);
    });
  });
});
