// Pre-event hardening (2026-06-08 audit). Source pins for the loophole fixes —
// each is a pure guard, no functionality change for legit clients.
import * as nodeFs from 'fs';
import * as nodePath from 'path';

const serverSrc = (rel: string) =>
  nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
const clientSrc = (rel: string) =>
  nodeFs.readFileSync(nodePath.join(__dirname, '../../../../client/src', rel), 'utf8');

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

describe('Hardening #2 — HostControls is inside an error boundary', () => {
  it('a throw in host controls cannot white-screen the host mid-event', () => {
    const page = clientSrc('features/live/LiveSessionPage.tsx');
    expect(page).toMatch(/SectionErrorBoundary name="Host controls">[\s\S]{0,120}<HostControls/);
  });
});

describe('Hardening #4 — round start never aborts on the cosmetic name lookup', () => {
  it('the display-name batch is isolated so a transient failure falls back to labels', () => {
    const rl = serverSrc('services/orchestration/handlers/round-lifecycle.ts');
    expect(rl).toMatch(/let globalNameMap = new Map<string, string>\(\);\s*try \{/);
    expect(rl).toMatch(/Round-start name lookup failed — proceeding with fallback labels/);
  });
});
