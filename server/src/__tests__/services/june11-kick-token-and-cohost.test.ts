// ─── June-11 — kicked user still rejoined on refresh + co-host assign gap ─────
//
// (A) Kicked user re-entered the MAIN ROOM after a refresh (post round 1). The
//     kick set status='removed' (matching correctly excluded them) but their
//     LiveKit video pulled them back. Root cause: generateLiveKitToken gated on
//     ROW EXISTENCE only — a removed user keeps their session_participants row,
//     so the existence check passed and minted them a video token via every
//     rail (state:resync, the synthetic-resync path, and the REST /token
//     fallback). Also a security hole: a removed user could rejoin the SFU.
//     Fix: token minting requires an ACTIVE membership (status not removed/left)
//     or the event host; and the resync rail sends a terminal eviction to a
//     removed user instead of a token.
//
// (B) Co-host parity (Ali, June-11): a co-host may do everything a host can
//     EXCEPT end the event (already director-only, S19) and ASSIGN new co-hosts.
//     handleAssignCohost routed through verifyHost (accepts co-hosts), so a
//     co-host could mint more co-hosts. Fix: assigning a co-host is the
//     director's call alone (super_admin keeps the emergency override).

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../', rel), 'utf8');
}
function readClient(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../client/src/', rel), 'utf8');
}
function sliceFn(src: string, marker: string): string {
  const i = src.indexOf(marker);
  expect(i).toBeGreaterThan(-1);
  const end = src.indexOf('\nexport ', i + 1);
  return src.slice(i, end === -1 ? i + 6000 : end);
}

describe('June-11 (A) — a removed user can never mint a LiveKit token', () => {
  const svc = () => readServer('services/session/session.service.ts');

  it('generateLiveKitToken bars ONLY a removed (kicked) member, not a recoverable left one', () => {
    const fn = sliceFn(svc(), 'export async function generateLiveKitToken');
    // Gate on status so a kicked ('removed') member can't mint a token...
    expect(fn).toMatch(/status !== 'removed'/);
    // ...but a 'left' member is RECOVERABLE (leave-and-rejoin / stale leave after
    // a drop) and MUST still be able to mint a lobby token — June-12 regression
    // fix (Stefan's event). 'left' must NOT be in the bar.
    expect(fn).not.toMatch(/status !== 'left'/);
    // And still throw for a non-active, non-host caller.
    expect(fn).toMatch(/ForbiddenError\('User is not a participant in this event'\)/);
    // The old existence-only guard is gone.
    expect(fn).not.toMatch(/participantResult\.rows\.length === 0 && session\.hostUserId !== userId/);
  });
});

describe('June-11 (A) — resync sends a terminal eviction to a removed user', () => {
  const snap = () => readServer('services/orchestration/state/state-snapshot.ts');
  it('handleResync emits session:evicted{removed_from_event} for a removed user (no token)', () => {
    const fn = sliceFn(snap(), 'export async function handleResync');
    expect(fn).toMatch(/removed_from_event/);
    expect(fn).toMatch(/session:evicted/);
    // June-12 regression fix — evict ONLY a 'removed' member. A 'left' member is
    // recoverable and must NOT be bounced to the recap on resync.
    expect(fn).toMatch(/st === 'removed'/);
    expect(fn).not.toMatch(/st === 'removed' \|\| st === 'left'/);
    // The removed gate must run BEFORE the token-minting buildYou call.
    const guardIdx = fn.indexOf('removed_from_event');
    const buildIdx = fn.indexOf('buildYou(');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(buildIdx);
  });
});

describe('June-11 (B) — assigning a co-host is director-only', () => {
  const host = () => readServer('services/orchestration/handlers/host-actions.ts');
  it('handleAssignCohost refuses a non-director, non-super_admin caller', () => {
    const fn = sliceFn(host(), 'export async function handleAssignCohost');
    // A director/super_admin gate guards the INSERT.
    expect(fn).toMatch(/host_user_id/);
    expect(fn).toMatch(/super_admin/);
    expect(fn).toMatch(/FORBIDDEN/);
    // The gate sits before the session_cohosts INSERT.
    const gateIdx = fn.search(/FORBIDDEN/);
    const insertIdx = fn.indexOf('INSERT INTO session_cohosts');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(insertIdx);
  });

  it('client hides Make/Remove co-host from non-directors (RowActions isViewerDirector gate)', () => {
    const src = readClient('features/live/HostControlCenter.tsx');
    // The action row takes an isViewerDirector flag and gates the cohost
    // buttons on it; the call site passes the director identity check.
    expect(src).toMatch(/isViewerDirector/);
    expect(src).toMatch(/state !== 'left' && isViewerDirector &&/);
    expect(src).toMatch(/isViewerDirector=\{currentUserId === hostUserId\}/);
  });
});
