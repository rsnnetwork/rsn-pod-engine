// ─── The Admin Events list follows every change to an event (10 Nov 2026, F7 fix round 1) ──────────────────────
//
// The Admin Events page listens on `admin:sessions`, and before F7 nothing sent it: the list only changed on a
// refresh. "Affected users" for a list of every event is every admin, so the tag is sent (fanoutAdminEntities, which
// addresses every admin and super admin) from the two shared fan-outs every change already runs:
//   - fanoutSessionCompleted: every completion (End Event, the natural end, the in-person ender, the abandoned-event
//     reaper, the REST end and the overdue job). Its behaviour is tested in fanout-session-completed.test.ts.
//   - fanoutSessionListEntities: an event created, edited, cancelled/deleted or permanently deleted.
// and from Go Live, which both start paths (the socket and POST /sessions/:id/host/start) share (openEventLobby).
// The caller-level emits F7 first added (REST end, the overdue job) are gone: the completion carries it.
// Pinned by source here; the fan-outs' emits themselves are tested with a fake database.

import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

/** The source of one function or route block, from its marker to the next top-level marker. */
function block(src: string, start: string, nextMarker: RegExp): string {
  const at = src.indexOf(start);
  expect(at).toBeGreaterThan(-1);
  const rest = src.slice(at + start.length);
  const end = rest.search(nextMarker);
  return start + (end === -1 ? rest : rest.slice(0, end));
}

describe('the shared fan-outs tell every admin', () => {
  const fanout = read('realtime/fanout.ts');

  it('fanoutSessionCompleted sends admin:sessions', () => {
    const fn = block(fanout, 'export async function fanoutSessionCompleted(', /\nexport /);
    expect(fn).toContain("fanoutAdminEntities('sessions')");
  });

  it('fanoutSessionListEntities sends admin:sessions', () => {
    const fn = block(fanout, 'export async function fanoutSessionListEntities(', /\nexport /);
    expect(fn).toContain("fanoutAdminEntities('sessions')");
  });

  it('fanoutAdminEntities addresses every admin and super admin', () => {
    const fn = block(fanout, 'export async function fanoutAdminEntities(', /\nexport /);
    expect(fn).toContain("SELECT id FROM users WHERE role IN ('admin', 'super_admin')");
    expect(fn).toContain('[`admin:${scope}`, ...extraEntities]');
  });
});

describe('every event route runs the list fan-out', () => {
  const routes = read('routes/sessions.ts');
  const ROUTE = /\n\/\/ ─── /;

  it.each([
    ['create', "router.post(\n  '/',"],
    ['update', "router.put(\n  '/:id',"],
    ['cancel / delete', "router.delete(\n  '/:id',"],
    ['permanent delete', "router.delete(\n  '/:id/permanent',"],
  ])('%s', (_name, marker) => {
    expect(block(routes, marker, ROUTE)).toMatch(/fanoutSessionListEntities\(/);
  });
});

describe('Go Live tells every admin, on both start paths', () => {
  const host = read('services/orchestration/handlers/host-actions.ts');

  it('openEventLobby sends admin:sessions after writing the live status', () => {
    const fn = block(host, 'async function openEventLobby(', /\n(export )?(async )?function /);
    const status = fn.indexOf('SessionStatus.LOBBY_OPEN');
    const admins = fn.indexOf("fanoutAdminEntities('sessions')");
    expect(status).toBeGreaterThan(-1);
    expect(admins).toBeGreaterThan(status);
  });

  it('the socket start and the REST start (POST /sessions/:id/host/start) both go through it', () => {
    expect(block(host, 'export async function handleHostStart(', /\nexport /)).toContain('await openEventLobby(data.sessionId)');
    expect(block(host, 'export async function startSession(', /\nexport /)).toContain('await openEventLobby(sessionId)');
    expect(read('routes/host.ts')).toContain('await orchestrationService.startSession(req.params.id, req.user!.userId)');
  });
});

describe('no caller sends it twice', () => {
  it('the REST end and the overdue job leave it to the completion', () => {
    const host = read('services/orchestration/handlers/host-actions.ts');
    expect(block(host, 'export async function endSession(', /\nexport /)).not.toContain('fanoutAdminEntities');
    expect(read('services/session/overdue-events.ts')).not.toContain('fanoutAdminEntities');
  });
});
