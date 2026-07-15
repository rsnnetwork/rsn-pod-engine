// Canonical-100% Ship C — token cutover. Legacy events stay as lifecycle
// notifications but STOP carrying LiveKit tokens; lobby:token retires
// entirely. The single token rail is: snapshot you.token (minted on location
// change + on every session:resync reply) + REST POST /sessions/:id/token
// fallback. Client pulls a resync on every session:status_changed so lobby
// returns / event start get their token within one round-trip.
import * as fs from 'fs';
import * as path from 'path';

// Line endings are normalised because these pins slice fixed-size windows out
// of the source (e.g. `hook.slice(i, i + 3600)`). A Windows checkout is CRLF,
// so every line costs one extra char and the window silently covers fewer
// lines than on CI's LF checkout — pins then fail locally while CI is green.
const read = (abs: string) => fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
const readSrc = (rel: string) => read(path.join(__dirname, '../../../', rel));
const readClient = (rel: string) => read(path.join(__dirname, '../../../../../client/src/', rel));
const readShared = (rel: string) => read(path.join(__dirname, '../../../../../shared/src/', rel));

const HANDLER_FILES = [
  'services/orchestration/handlers/round-lifecycle.ts',
  'services/orchestration/handlers/participant-flow.ts',
  'services/orchestration/handlers/host-actions.ts',
  'services/orchestration/handlers/breakout-bulk.ts',
  'services/orchestration/handlers/matching-flow.ts',
  'services/orchestration/handlers/chat-handlers.ts',
];

describe('Ship C — server: legacy events no longer carry tokens', () => {
  it("no handler emits 'lobby:token' anymore (event retired)", () => {
    for (const f of HANDLER_FILES) {
      const src = readSrc(f);
      expect({ file: f, emits: src.includes("emit('lobby:token'") })
        .toEqual({ file: f, emits: false });
    }
  });

  it('match:assigned emits carry NO token/livekitUrl (round start + reconnect)', () => {
    for (const f of HANDLER_FILES) {
      const src = readSrc(f);
      let i = src.indexOf("emit('match:assigned'");
      while (i !== -1) {
        const block = src.slice(i, src.indexOf('});', i) + 3);
        expect({ file: f, at: i, hasToken: /\btoken:/.test(block) || /livekitUrl:/.test(block) })
          .toEqual({ file: f, at: i, hasToken: false });
        i = src.indexOf("emit('match:assigned'", i + 1);
      }
    }
  });

  it('match:reassigned emits carry NO token/livekitUrl but KEEP lifecycle fields', () => {
    for (const f of HANDLER_FILES) {
      const src = readSrc(f);
      let i = src.indexOf("emit('match:reassigned'");
      while (i !== -1) {
        const block = src.slice(i, src.indexOf('});', i) + 3);
        expect({ file: f, at: i, hasToken: /\btoken:/.test(block) || /livekitUrl:/.test(block) })
          .toEqual({ file: f, at: i, hasToken: false });
        expect(block).toMatch(/matchId/); // lifecycle payload survives
        i = src.indexOf("emit('match:reassigned'", i + 1);
      }
    }
  });

  it('snapshot/resync/REST minting rails are untouched', () => {
    const snap = readSrc('services/orchestration/state/state-snapshot.ts');
    expect(snap).toMatch(/generateLiveKitToken|issueJoinToken/);
    const routes = readSrc('routes/sessions.ts');
    expect(routes).toMatch(/\/token/);
  });

  it("shared event types: 'lobby:token' removed", () => {
    const types = readShared('types/events.ts');
    expect(types).not.toMatch(/'lobby:token'/);
  });
});

describe('Ship C — client: room connection driven purely by snapshot + REST', () => {
  const hook = readClient('hooks/useSessionSocket.ts');

  it('no lobby:token listener remains', () => {
    expect(hook).not.toMatch(/on\('lobby:token'/);
    expect(hook).not.toMatch(/'lobby:token',/); // SOCKET_EVENTS cleanup list
  });

  it('match:assigned handler always REST-fetches the room token (no inline token branch)', () => {
    const i = hook.indexOf("socket.on('match:assigned'");
    const block = hook.slice(i, i + 3000);
    expect(block).toMatch(/fetchTokenWithRetry/);
    expect(block).not.toMatch(/data\.token/);
  });

  it('match:reassigned handler always REST-fetches the room token', () => {
    const i = hook.indexOf("socket.on('match:reassigned'");
    const block = hook.slice(i, i + 3000);
    expect(block).toMatch(/fetchTokenWithRetry/);
    expect(block).not.toMatch(/data\.token/);
  });

  it('session:status_changed pulls a resync (the lobby-token rail)', () => {
    const i = hook.indexOf("socket.on('session:status_changed'");
    const block = hook.slice(i, i + 1200);
    expect(block).toMatch(/emit\(\s*'session:resync',\s*\{\s*sessionId,\s*haveSeq/);
  });

  it('snapshot main-location branch arms the lobby token when in lobby phase', () => {
    const i = hook.indexOf("socket.on('state:snapshot'");
    const block = hook.slice(i, i + 3600);
    // Ship A heal (breakout→lobby) keeps its setLobbyToken; Ship C adds the
    // lobby-phase acceptance path so round transitions / event start get the
    // resync-minted token without any lobby:token event.
    const matches = block.match(/setLobbyToken\(you\.token, you\.livekitUrl/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
