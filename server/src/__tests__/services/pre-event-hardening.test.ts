// Pre-event hardening (2026-06-08 audit). Source pins for the loophole fixes —
// each is a pure guard, no functionality change for legit clients.
import * as nodeFs from 'fs';
import * as nodePath from 'path';

const serverSrc = (rel: string) =>
  nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');

describe('Hardening #1 — LiveKit token grants only an authorized room', () => {
  const svc = serverSrc('services/session/session.service.ts');
  it('does not use the client roomId verbatim as the grant', () => {
    expect(svc).not.toMatch(/const roomName = roomId \|\| session\.lobbyRoomId/);
  });
  it('falls back to the lobby and authorizes breakout membership / host', () => {
    expect(svc).toMatch(/let roomName = lobbyRoomName/);
    expect(svc).toMatch(/isHostOrCohost/);
    // membership check is scoped to THIS session + the caller's slots/departed
    expect(svc).toMatch(/WHERE session_id = \$1 AND room_id = \$2[\s\S]{0,160}ANY\(departed_user_ids\)/);
  });
});
