// ─── S16 — co-host management on the EVENT DETAIL page (Ali, 6 Jun) ────────
//
// The live drawer's co-host toggle (S12-C1) is socket-driven; the event
// detail page has no session socket, so co-host planning gets REST twins:
//   POST   /sessions/:id/cohosts/:userId   (assign)
//   DELETE /sessions/:id/cohosts/:userId   (remove)
// Same rules as the socket path: any acting host manages (canActAsHost);
// only the DIRECTOR may change a platform admin's status; assignment
// requires a real participant row. Side effects mirror the socket handlers
// (cohost:assigned/removed, permissions:updated, roster:changed, entity
// fanout, live-event plan repair) so any open live page flips instantly.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}
function readClient(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../client/src/', rel), 'utf8');
}

const routesSrc = () => readServer('routes/sessions.ts');
const detailSrc = () => readClient('features/sessions/SessionDetailPage.tsx');

function sliceFn(src: string, marker: string): string {
  const fnStart = src.indexOf(marker);
  expect(fnStart).toBeGreaterThan(-1);
  const fnEnd = src.indexOf('\nrouter.', src.indexOf('\n}', fnStart));
  return src.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
}

describe('S16 — REST cohost mutation routes', () => {
  it('POST and DELETE /:id/cohosts/:userId are registered', () => {
    const src = routesSrc();
    expect(src).toMatch(/router\.post\(\s*'\/:id\/cohosts\/:userId'/);
    expect(src).toMatch(/router\.delete\(\s*'\/:id\/cohosts\/:userId'/);
  });

  it('authorizes via canActAsHost (any acting host, not director-only)', () => {
    const fn = sliceFn(routesSrc(), 'async function mutateSessionCohost');
    expect(fn).toMatch(/canActAsHost\(req\.user!\.userId, req\.user!\.role, sessionId\)/);
    expect(fn).toMatch(/if \(!allowed\)/);
  });

  it('keeps the director-only guard for platform-admin targets (Bug J / Bug 2)', () => {
    const fn = sliceFn(routesSrc(), 'async function mutateSessionCohost');
    expect(fn).toMatch(/hasRoleAtLeast\(targetRes\.rows\[0\]\.role as UserRole, UserRole\.ADMIN\) && !isDirectorCaller/);
  });

  it('assignment requires a non-removed participant row', () => {
    const fn = sliceFn(routesSrc(), 'async function mutateSessionCohost');
    expect(fn).toMatch(/SELECT 1 FROM session_participants WHERE session_id = \$1 AND user_id = \$2 AND status != 'removed'/);
    expect(fn).toMatch(/NOT_A_PARTICIPANT/);
  });

  it('refuses to target the director', () => {
    const fn = sliceFn(routesSrc(), 'async function mutateSessionCohost');
    expect(fn).toMatch(/TARGET_IS_DIRECTOR/);
  });

  it('S16.1 — refuses co-host changes on a finished event (SESSION_OVER)', () => {
    const fn = sliceFn(routesSrc(), 'async function mutateSessionCohost');
    expect(fn).toMatch(/session\.status === SessionStatus\.COMPLETED \|\| session\.status === SessionStatus\.CANCELLED/);
    expect(fn).toMatch(/SESSION_OVER/);
  });

  it('mirrors the socket side effects: cohost event + permissions + roster + plan repair', () => {
    const fn = sliceFn(routesSrc(), 'async function mutateSessionCohost');
    expect(fn).toMatch(/'cohost:assigned'/);
    expect(fn).toMatch(/'cohost:removed'/);
    expect(fn).toMatch(/'permissions:updated'/);
    expect(fn).toMatch(/'roster:changed'/);
    expect(fn).toMatch(/maybeRepairFutureRounds/);
    expect(fn).toMatch(/fanoutSessionEntities/);
  });

  it('the same INSERT shape as the socket handler (ON CONFLICT upsert)', () => {
    const fn = sliceFn(routesSrc(), 'async function mutateSessionCohost');
    expect(fn).toMatch(/INSERT INTO session_cohosts \(session_id, user_id, role, granted_by\)/);
    expect(fn).toMatch(/ON CONFLICT \(session_id, user_id\) DO UPDATE/);
  });
});

describe('S16 — participants payload carries isCohost', () => {
  it('getSessionParticipants selects an EXISTS(session_cohosts) flag', () => {
    const src = readServer('services/session/session.service.ts');
    const i = src.indexOf('export async function getSessionParticipants');
    expect(i).toBeGreaterThan(-1);
    const fn = src.slice(i, src.indexOf('\nexport ', i + 1));
    expect(fn).toMatch(/EXISTS\(SELECT 1 FROM session_cohosts sc/);
    expect(fn).toMatch(/AS "isCohost"/);
  });
});

describe('S16 — host-actions exports the plan-repair wrapper for the REST path', () => {
  it('maybeRepairFutureRounds is exported', () => {
    const src = readServer('services/orchestration/handlers/host-actions.ts');
    expect(src).toMatch(/export async function maybeRepairFutureRounds\(io: SocketServer, sessionId: string\)/);
  });
});

describe('S16 — SessionDetailPage UI', () => {
  it('renders the Co-Host label/badge from p.isCohost', () => {
    const src = detailSrc();
    expect(src).toMatch(/p\.isCohost \? 'Co-Host' : statusLabel/);
    expect(src).toMatch(/<ShieldCheck/);
  });

  it('shield toggle calls the REST endpoints and invalidates the participants query', () => {
    const src = detailSrc();
    expect(src).toMatch(/api\.delete\(`\/sessions\/\$\{sessionId\}\/cohosts\/\$\{targetUserId\}`\)/);
    expect(src).toMatch(/api\.post\(`\/sessions\/\$\{sessionId\}\/cohosts\/\$\{targetUserId\}`\)/);
    expect(src).toMatch(/invalidateQueries\(\{ queryKey: \['session-participants', sessionId\] \}\)/);
  });

  it('toggle is gated on acting hosts, hidden on self, and hidden once the event is over (S16.1)', () => {
    const src = detailSrc();
    expect(src).toMatch(/canManageCohosts = !sessionOver && \(isHost \|\| user\?\.role === 'super_admin' \|\| viewerIsCohost\)/);
    expect(src).toMatch(/sessionOver = session\?\.status === 'completed' \|\| session\?\.status === 'cancelled'/);
    expect(src).toMatch(/canManageCohosts && p\.userId !== user\?\.id/);
  });

  it('mobile rule: the toggle is a ≥44px tap target with aria-labels', () => {
    const src = detailSrc();
    expect(src).toMatch(/min-w-\[44px\] min-h-\[44px\]/);
    expect(src).toMatch(/aria-label=\{p\.isCohost \? `Remove \$\{p\.displayName \|\| 'user'\} as co-host`/);
  });
});
