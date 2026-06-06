// ─── S25 — grow a manual room (Ali, 6 Jun) ──────────────────────────────────
//
// Hosts can create a 1-person manual room and grow it afterwards: a new
// host:add_to_room action seats a MAIN-ROOM participant into an active
// manual room (1→2, 2→3). Hard cap 3 — the system is wired for pairs/trios
// (A/B/C slots, layouts, rating fan-out, recap). The joiner rides the same
// rails as room creation (slot UPDATE → setRoomAssignment → IN_ROUND →
// match:reassigned); existing occupants get the lightweight
// match:participant_joined (S23-symmetric banner + partner add, NO video
// remount).

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
}
function readClient(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../../client/src/', rel), 'utf8');
}

function sliceFn(src: string, marker: string): string {
  const fnStart = src.indexOf(marker);
  expect(fnStart).toBeGreaterThan(-1);
  const fnEnd = src.indexOf('\nexport ', fnStart + 1);
  return src.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
}

describe('S25 — server handleHostAddToRoom', () => {
  const fn = () => sliceFn(readServer('services/orchestration/handlers/breakout-bulk.ts'), 'export async function handleHostAddToRoom');

  it('targets only ACTIVE MANUAL rooms in the caller’s session', () => {
    expect(fn()).toMatch(/WHERE id = \$1 AND session_id = \$2 AND status = 'active' AND is_manual = TRUE/);
  });

  it('hard-caps at 3 members with a distinct ROOM_FULL error', () => {
    const f = fn();
    expect(f).toMatch(/members\.length >= 3/);
    expect(f).toMatch(/code: 'ROOM_FULL', message: 'Rooms support up to 3 people'/);
  });

  it('refuses people already seated in any active match (USER_BUSY)', () => {
    expect(fn()).toMatch(/code: 'USER_BUSY'/);
  });

  it('fills the slot with a guarded UPDATE (concurrent adds cannot stack)', () => {
    const f = fn();
    expect(f).toMatch(/WHERE id = \$2 AND status = 'active' AND \$\{slot\} IS NULL/);
    expect(f).toMatch(/code: 'ROOM_CHANGED'/);
  });

  it('joiner rides the creation rails; occupants get participant_joined (no re-assign)', () => {
    const f = fn();
    expect(f).toMatch(/setRoomAssignment\(sessionId, matchId, m\.room_id, \[userId\]\)/);
    expect(f).toMatch(/ParticipantStatus\.IN_ROUND/);
    expect(f).toMatch(/emit\('match:reassigned'/);
    expect(f).toMatch(/emit\('match:participant_joined'/);
    expect(f).toMatch(/timerState\.participantIds\.push\(userId\)/);
  });

  it('is registered as host:add_to_room', () => {
    const src = readServer('services/orchestration/orchestration.service.ts');
    expect(src).toMatch(/wrapHandler\('host:add_to_room', socket, handleHostAddToRoom\)/);
  });
});

describe('S25 — the dashboard builder survives 1-person rooms (bb root #2)', () => {
  it('the name-collection loop guards every slot (no NULL into placeholderName)', () => {
    const src = readServer('services/orchestration/handlers/matching-flow.ts');
    const i = src.indexOf('const allUserIds = new Set<string>()');
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i, i + 1400);
    expect(block).toMatch(/if \(m\.participantAId\) allUserIds\.add\(m\.participantAId\)/);
    expect(block).toMatch(/if \(m\.participantBId\) allUserIds\.add\(m\.participantBId\)/);
    expect(block).toMatch(/if \(m\.participantCId\) allUserIds\.add\(m\.participantCId\)/);
  });

  it('placeholderName degrades on null/undefined instead of throwing', () => {
    const src = nodeFs.readFileSync(
      nodePath.join(__dirname, '../../../../../shared/src/identity/displayName.ts'), 'utf8',
    );
    expect(src).toMatch(/placeholderName\(userId: string \| null \| undefined\)/);
    expect(src).toMatch(/userId \? `Participant \$\{userId\.slice\(0, 6\)\}` : 'Participant'/);
  });
});

describe('S25 — client', () => {
  it('participant_joined handler adds the partner and raises the banner', () => {
    const src = readClient('hooks/useSessionSocket.ts');
    const i = src.indexOf("socket.on('match:participant_joined'");
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i, i + 900);
    expect(block).toMatch(/store\.addPartner\(\{ userId: data\.joinedUserId, displayName: data\.joinedDisplayName \}\)/);
    expect(block).toMatch(/joined the room/);
  });

  it('the room card offers Add person (≥cap shows Room full) and the picker emits host:add_to_room', () => {
    const src = readClient('features/live/HostRoundDashboard.tsx');
    expect(src).toMatch(/room\.participants\.length >= 3/);
    expect(src).toMatch(/Room full \(3\)/);
    expect(src).toMatch(/Add person/);
    expect(src).toMatch(/data-testid="add-person-picker"/);
    expect(src).toMatch(/emit\('host:add_to_room' as any, \{ sessionId, userId: p\.userId, matchId: room\.matchId \}\)/);
    // Picker excludes the director and anyone already seated.
    expect(src).toMatch(/p\.userId !== hostUserId && !seated\.has\(p\.userId\)/);
  });
});
