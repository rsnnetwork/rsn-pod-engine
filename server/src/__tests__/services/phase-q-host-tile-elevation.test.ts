// Phase Q — 12 May item 2, Ali's 13 May clarification.
//
// Hosts get the bigger tile in the lobby grid automatically — no manual
// big_speaker dropdown required. Pre-Phase-Q the bigger tile followed
// `isLocal` (Phase 8C.2 self-prominence rule from 8 May), which meant
// each viewer saw THEMSELVES as the big tile regardless of role —
// exactly the bug Stefan called out: "host needs to be the bigger tile,
// not myself".
//
// Phase Q:
//   • Tile size derives from `isActingHost` (in the hosts set: director
//     + cohorts + opt-ins, minus opt-outs).
//   • Sort puts director first, then other acting hosts, then local
//     non-host, then everyone else. #1 grid position is ALWAYS the
//     director's tile, regardless of viewer.
//   • The `big_speaker` visibility mode dropdown remains as a stronger
//     "I dominate the stage" override; default-host elevation is
//     automatic.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readClient(rel: string): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../../client/src', rel),
    'utf8',
  );
}

describe('Phase Q — host tile elevation in Lobby grid', () => {
  const src = readClient('features/live/Lobby.tsx');

  describe('hostsSet derivation', () => {
    it('reads cohosts + actingAsHostOverrides from the store', () => {
      expect(src).toMatch(/cohosts\s*=\s*useSessionStore\(/);
      expect(src).toMatch(/actingAsHostOverrides\s*=\s*useSessionStore\(/);
    });

    it('builds hostsSet as director + cohosts + opt-ins minus opt-outs', () => {
      // Find the LobbyMosaic-level hostsSet block (separate from the
      // HostParticipantPanel one further down).
      const mosaicIdx = src.indexOf('function LobbyMosaic');
      expect(mosaicIdx).toBeGreaterThan(-1);
      const tileIdx = src.indexOf('const renderTile', mosaicIdx);
      expect(tileIdx).toBeGreaterThan(-1);
      const mosaic = src.slice(mosaicIdx, tileIdx);

      // Initial seed: director.
      expect(mosaic).toMatch(/hostsSet[\s\S]{0,200}if\s*\(hostUserId\)\s*s\.add\(hostUserId\)/);
      // Cohorts loop adds.
      expect(mosaic).toMatch(/for\s*\(\s*const\s+c\s+of\s+cohosts\s*\)\s*s\.add\(c\)/);
      // Override loop: TRUE adds, FALSE deletes.
      expect(mosaic).toMatch(/v\s*===\s*true[\s\S]{0,40}s\.add\(uid\)/);
      expect(mosaic).toMatch(/v\s*===\s*false[\s\S]{0,40}s\.delete\(uid\)/);
    });
  });

  describe('Sort order — director first, then hosts, then local, then others', () => {
    it('director (hostUserId match) wins over non-director', () => {
      expect(src).toMatch(/aIsDirector\s*=\s*aId\s*===\s*hostUserId/);
      expect(src).toMatch(/if\s*\(aIsDirector\s*&&\s*!bIsDirector\)\s*return\s*-1/);
      expect(src).toMatch(/if\s*\(!aIsDirector\s*&&\s*bIsDirector\)\s*return\s*1/);
    });

    it('acting hosts (cohosts + opt-ins) win over non-hosts', () => {
      expect(src).toMatch(/aIsHost\s*=[\s\S]{0,80}hostsSet\.has\(aId\)/);
      expect(src).toMatch(/if\s*\(aIsHost\s*&&\s*!bIsHost\)\s*return\s*-1/);
      expect(src).toMatch(/if\s*\(!aIsHost\s*&&\s*bIsHost\)\s*return\s*1/);
    });

    it('within ties, local participant wins (last tiebreaker)', () => {
      expect(src).toMatch(/aIsLocal\s*=\s*a\.participant\.sid\s*===\s*localParticipant\.sid\s*\?\s*0\s*:\s*1/);
      expect(src).toMatch(/return\s+aIsLocal\s*-\s*bIsLocal/);
    });
  });

  describe('Tile size — isActingHost replaces isLocalTile', () => {
    it('renderTile derives isActingHost from hostsSet membership', () => {
      const renderIdx = src.indexOf('const renderTile = ');
      expect(renderIdx).toBeGreaterThan(-1);
      const block = src.slice(renderIdx, renderIdx + 1800);
      expect(block).toMatch(/isActingHost\s*=[\s\S]{0,150}hostsSet\.has\(trackRef\.participant\.identity\)/);
    });

    it('grid-span size className routes through the fitted grid (not isLocalTile)', () => {
      // Issue 12 (21 May Stefan re-test): hosts must REMAIN LARGER than
      // other participants AND sit adjacent. 15 Nov 2026 (tester, 13 Nov):
      // a host tile fixed at 2 x 2 pushed everyone else below the fold on a
      // phone. Now the acting hosts lead the grid together and keep the host
      // ring, and lobbyGrid.planLobbyGrid draws them 2 x 2 ('cell-large')
      // only on a wide area where everyone else still fits
      // (lobby-grid-fit.test.ts holds the geometry).
      expect(src).toMatch(/isActingHost && !isPinned \? hostRingClass : ''/);
      expect(src).toMatch(/hostRingClass = 'ring-2 ring-rsn-red\/30'/);
      expect(src).toMatch(/frame: grid\.span === 2 && isLargeHostTile\(trackRef\) \? 'cell-large' : 'cell'/);
      expect(src).toMatch(/'cell-large': 'h-full w-full col-span-2 row-span-2'/);
      // Forbid the pre-Phase-Q form that tied size to isLocalTile —
      // anyone re-introducing that regression would silently revert
      // Stefan's spec.
      expect(src).not.toMatch(/isLocalTile\s*\?\s*['"`]aspect-video\s+(?:sm:)?col-span-2/);
      // Forbid a fixed 2 x 2 host tile that ignores the space left (13 Nov).
      expect(src).not.toMatch(/aspect-video col-span-2 row-span-2/);
    });

    it('the larger host cells are the acting hosts, demoted tiles excluded, leading the grid (Issue 12)', () => {
      expect(src).toMatch(/isLargeHostTile = \(t: any\) => \{[\s\S]{0,120}hostsSet\.has\(id\) && !tileDemotedSet\.has\(id\)/);
      expect(src).toMatch(/const largeTracks = windowTracks\.filter\(isLargeHostTile\);/);
      expect(src).toMatch(/\[\.\.\.largeTracks, \.\.\.windowTracks\.filter\(t => !isLargeHostTile\(t\)\)\]/);
      expect(src).toMatch(/emphasized: largeTracks\.length,/);
    });

    it('data-acting-host attribute exposed for E2E selectors', () => {
      expect(src).toMatch(/data-acting-host=\{\s*isActingHost\s*\?\s*['"]true['"]\s*:\s*undefined\s*\}/);
    });

    it('data-self attribute still uses isLocal (overlays still tied to local)', () => {
      // The mute/kick buttons and self-overlay are correctly tied to
      // `isLocal` — that's the viewer's own tile, independent of role.
      // Pin so a future refactor doesn't accidentally rewire data-self
      // to hosts.
      expect(src).toMatch(/data-self=\{\s*isLocal\s*\?\s*['"]true['"]\s*:\s*undefined\s*\}/);
    });
  });

  describe('Cross-reference — Phase N visibility dropdown still works', () => {
    it('big_speaker mode still places track in the dedicated stage row', () => {
      // Phase N's stage row is still present; Phase Q does not remove it.
      // big_speaker is the "I dominate everything" override; default-host
      // elevation is the new automatic behaviour. Both coexist.
      expect(src).toMatch(/bigSpeakerTracks\.length\s*>\s*0/);
      expect(src).toMatch(/data-testid="lobby-big-speaker-stage"/);
    });
  });
});
