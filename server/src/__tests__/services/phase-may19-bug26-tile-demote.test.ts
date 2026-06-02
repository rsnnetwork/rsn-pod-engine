// Bug 26 (19 May Ali) — event director can shrink a cohost's lobby tile
// to participant size without revoking any cohost privilege. Extension
// of Bug 2's "director overrides platform role" principle, applied to
// visual hierarchy instead of action authority.
//
// Bug 27 (19 May Ali) — Bug 22's "Another Round" bump persisted to the
// DB and the plan strip but did NOT push the new round total into the
// client store's `totalRounds` field. Every UI surface that read
// `totalRounds` ("Round N of M" headers, breakout rooms, rating prompt
// last-round logic) stuck on the pre-bump number for the rating-window
// duration. Pin the missing setTotalRounds call here so the regression
// can't reappear.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}
function readClient(rel: string): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../../client/src', rel),
    'utf8',
  );
}
function readShared(rel: string): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../../shared/src', rel),
    'utf8',
  );
}

describe('Bug 26 — Director can shrink cohost tile (visual only)', () => {
  describe('Server — state, persistence, handler, broadcast, snapshot', () => {
    const stateSrc = readServer('services/orchestration/state/session-state.ts');
    const actionsSrc = readServer('services/orchestration/handlers/host-actions.ts');
    const snapshotSrc = readServer('services/session/session-state-snapshot.service.ts');
    const orchestrationSrc = readServer('services/orchestration/orchestration.service.ts');

    it('ActiveSession carries tileDemotedUserIds as a string array', () => {
      expect(stateSrc).toMatch(/tileDemotedUserIds\?:\s*string\[\]/);
    });

    it('persistToRedis serialises tileDemotedUserIds (survives restart)', () => {
      const fnIdx = stateSrc.indexOf('async function persistToRedis');
      expect(fnIdx).toBeGreaterThan(-1);
      const fn = stateSrc.slice(fnIdx, fnIdx + 3000);
      expect(fn).toMatch(/tileDemotedUserIds:\s*session\.tileDemotedUserIds\s*\?\?\s*\[\]/);
    });

    it('handleHostSetTileSize exists with director-only check, mutation, persist, broadcast', () => {
      const fnIdx = actionsSrc.indexOf('export async function handleHostSetTileSize');
      expect(fnIdx).toBeGreaterThan(-1);
      const fn = actionsSrc.slice(fnIdx, fnIdx + 4000);

      // Director-only — must compare callerId to activeSession.hostUserId,
      // NOT route through verifyHost (which would let cohosts/super_admin
      // through).
      expect(fn).toMatch(/callerId\s*!==\s*activeSession\.hostUserId/);
      // Issue 13 (20 May Stefan) — the director CAN now demote their own
      // tile. The old `targetUserId === activeSession.hostUserId` reject
      // guard was removed; tile demote is visual-only so it can't strip
      // any privilege. Stefan asked for "Host should be able to unpin"
      // in the 20 May doc and this is the server side of that. The new
      // comment in the handler references Issue 13 explicitly.
      expect(fn).toMatch(/Issue 13/);
      // Confirm the reject path is gone — no INVALID_TARGET error
      // anywhere in the handler tied to the hostUserId check.
      expect(fn).not.toMatch(/Director cannot demote their own tile/);
      // Mutates the in-memory state.
      expect(fn).toMatch(/activeSession\.tileDemotedUserIds\s*=/);
      // Persists so it survives restart (mirrors Bug 1 pin pattern).
      expect(fn).toMatch(/persistSessionState\(sessionId,\s*activeSession\)/);
      // Broadcasts to the whole session room — every viewer rerenders.
      expect(fn).toMatch(
        /io\.to\(sessionRoom\(sessionId\)\)\.emit\(\s*['"]tile:size_changed['"]/,
      );
      // Includes the full updated array in the broadcast payload.
      expect(fn).toMatch(/tileDemotedUserIds:\s*activeSession\.tileDemotedUserIds/);
    });

    it('rejects invalid size values', () => {
      const fnIdx = actionsSrc.indexOf('export async function handleHostSetTileSize');
      const fn = actionsSrc.slice(fnIdx, fnIdx + 4000);
      expect(fn).toMatch(/size\s*!==\s*['"]participant['"]\s*&&\s*size\s*!==\s*['"]host['"]/);
    });

    it('orchestration wires host:set_tile_size via wrapHandler', () => {
      expect(orchestrationSrc).toMatch(
        /wrapHandler\(\s*['"]host:set_tile_size['"]\s*,\s*socket\s*,\s*handleHostSetTileSize\s*\)/,
      );
    });

    it('SessionStateSnapshot declares tileDemotedUserIds in its interface', () => {
      expect(snapshotSrc).toMatch(/tileDemotedUserIds:\s*string\[\]/);
    });

    it('snapshot builder bundles activeSession.tileDemotedUserIds (empty array fallback)', () => {
      expect(snapshotSrc).toMatch(
        /tileDemotedUserIds:\s*activeSession\?\.tileDemotedUserIds\s*\?\?\s*\[\]/,
      );
    });
  });

  describe('Shared types — new event signatures', () => {
    const eventsSrc = readShared('types/events.ts');

    it("server-to-client 'tile:size_changed' event is declared", () => {
      expect(eventsSrc).toMatch(
        /'tile:size_changed':\s*\(\s*data:\s*\{[^}]*tileDemotedUserIds:\s*string\[\]/,
      );
    });

    it("client-to-server 'host:set_tile_size' event is declared", () => {
      expect(eventsSrc).toMatch(
        /'host:set_tile_size':\s*\(\s*data:\s*\{[^}]*targetUserId:\s*string[^}]*size:\s*'participant'\s*\|\s*'host'/,
      );
    });
  });

  describe('Client — store hydrate, socket listen, Lobby override, HCC button', () => {
    const storeSrc = readClient('stores/sessionStore.ts');
    const socketSrc = readClient('hooks/useSessionSocket.ts');
    const lobbySrc = readClient('features/live/Lobby.tsx');
    const hccSrc = readClient('features/live/HostControlCenter.tsx');

    it('SessionLiveState declares tileDemotedUserIds: string[]', () => {
      expect(storeSrc).toMatch(/tileDemotedUserIds:\s*string\[\]/);
    });

    it('store initial state and reset() use empty array for tileDemotedUserIds', () => {
      // initial state
      expect(storeSrc).toMatch(/tileDemotedUserIds:\s*\[\]/);
      // setter
      expect(storeSrc).toMatch(/setTileDemotedUserIds:\s*\(ids\)\s*=>/);
    });

    it('snapshot hydrator pulls tileDemotedUserIds from snapshot.tileDemotedUserIds', () => {
      expect(storeSrc).toMatch(
        /tileDemotedUserIds:\s*Array\.isArray\(\(snapshot as any\)\.tileDemotedUserIds\)/,
      );
    });

    it("useSessionSocket subscribes to 'tile:size_changed' and updates the store", () => {
      // Listed in the trackedEvents array.
      expect(socketSrc).toMatch(/'tile:size_changed'/);
      // Has an active handler that reads the array and pushes it into
      // the store via setTileDemotedUserIds.
      expect(socketSrc).toMatch(
        /socket\.on\(\s*['"]tile:size_changed['"]\s*,[\s\S]{0,400}store\.setTileDemotedUserIds\(/,
      );
    });

    it('Lobby tile-sizing line respects tileDemotedSet override', () => {
      // Pull a window around the isActingHost decision and pin both the
      // hostsSet check AND the tileDemotedSet negation.
      const isActingHostIdx = lobbySrc.indexOf('isActingHost');
      expect(isActingHostIdx).toBeGreaterThan(-1);
      const window = lobbySrc.slice(isActingHostIdx, isActingHostIdx + 600);
      expect(window).toMatch(/hostsSet\.has\([^)]+\)/);
      expect(window).toMatch(/!tileDemotedSet\.has\([^)]+\)/);
    });

    it('HCC defines setCohostTileSize that emits host:set_tile_size', () => {
      expect(hccSrc).toMatch(/const\s+setCohostTileSize/);
      expect(hccSrc).toMatch(
        /socket\?\.emit\(\s*['"]host:set_tile_size['"]\s*,\s*\{\s*sessionId\s*,\s*targetUserId[^}]*size\s*\}/,
      );
    });

    it('HCC small-tile button is gated to director on cohost rows only', () => {
      // The button must be rendered ONLY when:
      //   • the row is a cohost
      //   • the viewer is the actual event director (currentUserId === hostUserId)
      //   • the row isn't the director themselves
      // All three gates appear together in the JSX.
      const btnLabel = hccSrc.indexOf("'Small tile'");
      expect(btnLabel).toBeGreaterThan(-1);
      const window = hccSrc.slice(btnLabel - 2000, btnLabel + 200);
      expect(window).toMatch(/p\.role\s*===\s*['"]cohost['"]/);
      expect(window).toMatch(/currentUserId\s*===\s*hostUserId/);
      expect(window).toMatch(/p\.userId\s*!==\s*hostUserId/);
    });

    it("button label toggles 'Small tile' ⇄ 'Restore tile' based on tileDemotedSet", () => {
      expect(hccSrc).toMatch(/tileDemotedSet\.has\(p\.userId\)\s*\?\s*['"]Restore tile['"]\s*:\s*['"]Small tile['"]/);
    });
  });
});

describe('Bug 27 — host:event_plan_repaired pushes new total into totalRounds store', () => {
  const socketSrc = (() => {
    return nodeFs.readFileSync(
      nodePath.join(__dirname, '../../../../client/src/hooks/useSessionSocket.ts'),
      'utf8',
    );
  })();

  it("'host:event_plan_repaired' handler calls store.setTotalRounds when roundCount is set", () => {
    const fnIdx = socketSrc.indexOf("socket.on('host:event_plan_repaired'");
    expect(fnIdx).toBeGreaterThan(-1);
    const fn = socketSrc.slice(fnIdx, fnIdx + 3000);
    // The handler must call setTotalRounds with the freshly-bumped rc.
    expect(fn).toMatch(/store\.setTotalRounds\(rc\)/);
    // And only when rc is a real number, mirroring the eventPlanSummary
    // guard on the line above.
    expect(fn).toMatch(/if\s*\(\s*rc\s*!==\s*null\s*\)\s*\{[\s\S]*?store\.setTotalRounds\(rc\)/);
  });
});
