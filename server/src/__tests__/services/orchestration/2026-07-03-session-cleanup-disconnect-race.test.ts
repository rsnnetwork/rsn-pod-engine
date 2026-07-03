// 3 Jul live test (Stefan "THE TEST") — after the event ended, one
// participant (cs@…) was left in a non-terminal 'disconnected' state instead
// of 'left' ("the old live session did not close properly"). Root cause: a
// race. completeSession sweeps every participant to 'left' but the session
// stays in activeSessions during its 2–5s LiveKit-room cleanup; a socket that
// drops in that window hits handleDisconnect, which loops activeSessions,
// finds the (still-present) session and writes DISCONNECTED — AFTER the sweep
// set 'left'. Terminal state must win: a COMPLETED session's participant is
// never flipped back to a non-terminal status.
import * as fs from 'fs';
import * as path from 'path';
const readSrc = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../', rel), 'utf8');

describe('handleDisconnect does not resurrect a completed session', () => {
  it('gates the DISCONNECTED write on a non-completed session status', () => {
    const src = readSrc('services/orchestration/handlers/participant-flow.ts');
    const i = src.indexOf('export async function handleDisconnect');
    expect(i).toBeGreaterThan(-1);
    const fn = src.slice(i, src.indexOf('\nexport ', i + 10));
    // The DISCONNECTED status write must be preceded, within the same
    // function, by a guard against a COMPLETED session.
    const writeIdx = fn.indexOf('ParticipantStatus.DISCONNECTED');
    expect(writeIdx).toBeGreaterThan(-1);
    const before = fn.slice(0, writeIdx);
    expect(before).toMatch(/status !== SessionStatus\.COMPLETED|status === SessionStatus\.COMPLETED/);
  });
});
