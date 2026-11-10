// ─── Admission per event: the D3 matrix (Part 2, Task 4, 10 Nov 2026) ────────────────────────────────────────
//
// Every row of D3 (visibility × admission_mode) for every viewer (organiser, admin, pod member, invitee, listed email,
// code holder, stranger, removed participant): the register decision (canRegister) and the live-room decision
// (eventRoomAdmission, given a place); an event guest's eligibility (Task 3's guestMayRegister, which admission widens).
// Then the dark-on-production proof: with admission_mode NULL, every rule answers
// exactly what it answered before this task, for every combination of facts. The oracle below is the rules as they
// stood on production main (082d8c68), copied verbatim, so a later edit to the live rules cannot move both sides.
// The SQL behind `entitled` and `admission_holds` runs for real in the task's probe (see the report).

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({ query: (...a: unknown[]) => mockQuery(...a), transaction: jest.fn(), __esModule: true }));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));
const mockGate = jest.fn();
jest.mock('../../../middleware/auth', () => ({ readAccountGate: (...a: unknown[]) => mockGate(...a), __esModule: true }));

import { ErrorCodes, UserRole, hasRoleAtLeast, type AdmissionMode, type EventVisibility } from '@rsn/shared';
import {
  EVENT_ADMISSION_REQUIRED_SENTENCE, admittedViaOf, autoRegisters, canRegister, canSeeEvent, effectiveAdmission,
  eventAccessMode, needsApproval, readEventAccessFacts, restrictedEntitlementSql, summariseEventAccess,
  type EventAccessFacts,
} from '../../../services/session/event-access';
import { eventRoomAdmission } from '../../../services/session/session-access';
import { eventRoomRefusal } from '../../../services/orchestration/event-room-entry';
import {
  assertGuestMayRegister, guestMayRegister, readGuestRegistrationFacts, type GuestRegistrationFacts,
} from '../../../services/session/guest-registration';

const M = UserRole.MEMBER;
const EVENT = '0c1d2e3f-4a5b-4c6d-8e7f-8a9b0c1d2e3f';
const ME = '1d2e3f4a-5b6c-4d7e-9f80-9b0c1d2e3f4a';

const base: EventAccessFacts = {
  visibility: null, podId: 'p', podVisibility: 'private', isHost: false, isCohost: false, isPodOrganiser: false,
  inAudience: false, isInvited: false, participantStatus: null, accountActive: true, myRequest: null,
  outsideClosedCircle: false, admissionMode: null, entitled: false, entitledVia: null,
};

type Viewer = 'organiser' | 'admin' | 'member' | 'invitee' | 'listed' | 'codeHolder' | 'stranger' | 'removed';
const VIEWERS: Viewer[] = ['organiser', 'admin', 'member', 'invitee', 'listed', 'codeHolder', 'stranger', 'removed'];

/** The facts readEventAccessFacts gives each viewer (entitlement read on an event with a mode only, as the SQL does). */
function viewer(v: Viewer, visibility: EventVisibility | null, mode: AdmissionMode | null): { f: EventAccessFacts; role: string } {
  const f: EventAccessFacts = { ...base, visibility, admissionMode: mode };
  let role: string = M;
  const entitle = (via: 'allow_list' | 'code' | 'invite') => { if (mode) { f.entitled = true; f.entitledVia = via; } };
  if (v === 'organiser') f.isHost = true;
  if (v === 'admin') role = UserRole.ADMIN;
  if (v === 'member') f.inAudience = true;
  if (v === 'invitee') { f.isInvited = true; entitle('invite'); }
  if (v === 'listed') entitle('allow_list');
  if (v === 'codeHolder') entitle('code');
  if (v === 'removed') f.participantStatus = 'removed';
  return { f, role };
}

/** 'ok' or the refusal code. 'row' marks a removed place canRegister passes on to registerParticipant's own check. */
function decision(f: EventAccessFacts, role: string): string {
  const d = canRegister(f, role);
  if (!d.ok) return d.code;
  return f.participantStatus === 'removed' ? 'row' : 'ok';
}

/** D3, the register column. */
function expected(mode: AdmissionMode, v: Viewer): string {
  if (v === 'removed') return 'row';
  if (mode === 'open') return 'ok';
  if (mode === 'approval') return v === 'stranger' ? ErrorCodes.EVENT_NEEDS_APPROVAL : 'ok';
  return v === 'member' || v === 'stranger' ? ErrorCodes.EVENT_ADMISSION_REQUIRED : 'ok';
}

/** What the live-room read returns for this viewer holding a place (a removed one for the removed viewer). */
function roomRow(v: Viewer, mode: AdmissionMode | null) {
  const entitled = v === 'invitee' || v === 'listed' || v === 'codeHolder';
  return {
    is_host: v === 'organiser',
    is_cohost: false,
    participant_status: v === 'removed' ? 'removed' : 'registered',
    account_closed: false,
    admission_holds: mode === 'restricted' ? entitled : true,
  };
}

function expectedRoom(mode: AdmissionMode | null, v: Viewer): string {
  if (v === 'removed') return 'removed';
  if (mode !== 'restricted') return 'admitted';
  return v === 'member' || v === 'stranger' ? 'refused' : 'admitted';
}

beforeEach(() => mockQuery.mockReset());

describe('D3: every visibility × admission mode × viewer', () => {
  const visibilities: Array<EventVisibility | null> = [null, 'public', 'public_with_approval', 'private'];
  for (const visibility of visibilities) {
    for (const mode of ['open', 'approval', 'restricted'] as const) {
      // A mode never sits on a NULL-visibility event (sessions_admission_needs_visibility); the pure rule answers
      // the same anyway, so the row is held here too.
      it(`visibility ${visibility ?? 'NULL'}, admission ${mode}: register and room decisions`, async () => {
        for (const v of VIEWERS) {
          const { f, role } = viewer(v, visibility, mode);
          expect({ v, register: decision(f, role) }).toEqual({ v, register: expected(mode, v) });
          mockQuery.mockResolvedValueOnce({ rows: [roomRow(v, mode)] });
          const room = await eventRoomAdmission(EVENT, ME, role);
          expect({ v, room }).toEqual({ v, room: expectedRoom(mode, v) });
        }
      });
    }
  }

  it('restricted: a pod member who is not listed is refused, in the invited-guests words', () => {
    const { f } = viewer('member', 'public', 'restricted');
    expect(canRegister(f, M)).toEqual({
      ok: false, status: 403, code: ErrorCodes.EVENT_ADMISSION_REQUIRED, message: EVENT_ADMISSION_REQUIRED_SENTENCE,
    });
    expect(EVENT_ADMISSION_REQUIRED_SENTENCE)
      .toBe('This event is for invited guests. Enter the email you were invited with, or an admission code.');
    expect(summariseEventAccess(f, M)).toMatchObject({ mode: 'private', autoRegister: false, admission: 'restricted' });
  });

  it('restricted: a place already held does not admit by itself (an out-of-date list is corrected by revoking)', () => {
    const held = { ...viewer('member', 'public', 'restricted').f, participantStatus: 'left' };
    expect(canRegister(held, M)).toMatchObject({ ok: false, code: ErrorCodes.EVENT_ADMISSION_REQUIRED });
  });

  it('restricted: an organiser revokes a listed email after the person registered; the room refuses them, their row stays', async () => {
    // Before the revoke: listed, registered, admitted.
    mockQuery.mockResolvedValueOnce({ rows: [roomRow('listed', 'restricted')] });
    expect(await eventRoomAdmission(EVENT, ME, M)).toBe('admitted');
    // After: the entitlement no longer holds; the participant row is still 'registered' (nothing here writes).
    mockQuery.mockResolvedValueOnce({ rows: [{ ...roomRow('listed', 'restricted'), admission_holds: false }] });
    expect(await eventRoomAdmission(EVENT, ME, M)).toBe('refused');
    expect(mockQuery).toHaveBeenCalledTimes(2);
    for (const [sql] of mockQuery.mock.calls) expect(String(sql)).not.toMatch(/UPDATE|DELETE|INSERT/i);
    // The registration the socket join attempts first refuses them in the same words the room then shows.
    const revoked = { ...viewer('stranger', 'public', 'restricted').f, participantStatus: 'registered' };
    expect(canRegister(revoked, M)).toMatchObject({ code: ErrorCodes.EVENT_ADMISSION_REQUIRED });
    expect(eventRoomRefusal('lobby_open', ErrorCodes.EVENT_ADMISSION_REQUIRED)).toEqual({
      code: ErrorCodes.EVENT_ADMISSION_REQUIRED, message: EVENT_ADMISSION_REQUIRED_SENTENCE,
    });
  });

  it('the people who run it and admins are let into a restricted room whatever the list says', async () => {
    const runners: Array<[{ is_host: boolean; is_cohost: boolean }, string]> = [
      [{ is_host: true, is_cohost: false }, M], [{ is_host: false, is_cohost: true }, M],
      [{ is_host: false, is_cohost: false }, UserRole.ADMIN], [{ is_host: false, is_cohost: false }, UserRole.SUPER_ADMIN],
    ];
    for (const [row, role] of runners) {
      mockQuery.mockResolvedValueOnce({ rows: [{ ...row, participant_status: null, admission_holds: false }] });
      expect(await eventRoomAdmission(EVENT, ME, role)).toBe('admitted');
    }
    // A removal still wins over every role, and a closed account still enters nothing.
    mockQuery.mockResolvedValueOnce({ rows: [{ is_host: true, is_cohost: false, participant_status: 'removed', admission_holds: true }] });
    expect(await eventRoomAdmission(EVENT, ME, M)).toBe('removed');
    mockQuery.mockResolvedValueOnce({ rows: [{ is_host: false, is_cohost: false, participant_status: 'registered', account_closed: true, admission_holds: true }] });
    expect(await eventRoomAdmission(EVENT, ME, M)).toBe('refused');
  });

  it('the live-room read is still one parameterised query; restricted asks for the entitlement fragment, others never', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [roomRow('member', null)] });
    await eventRoomAdmission(EVENT, ME, M);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(params).toEqual([EVENT, ME]);
    const flat = String(sql).replace(/\s+/g, ' ');
    expect(flat).toContain(`CASE WHEN s.admission_mode = 'restricted' THEN ${restrictedEntitlementSql('s', '$2').replace(/\s+/g, ' ')} ELSE TRUE END AS admission_holds`);
    expect(flat).not.toContain(EVENT);
  });

  it('the entitlement is an unrevoked allowed email, an unrevoked redeemed code, or an invite, and refuses anything else', () => {
    const sql = restrictedEntitlementSql('s', '$2').replace(/\s+/g, ' ');
    expect(sql).toContain('ad_e.session_id = s.id AND ad_e.email = lower(btrim(ad_u.email)) AND ad_e.revoked_at IS NULL');
    expect(sql).toContain('ad_c.session_id = s.id AND ad_c.redeemed_by = $2 AND ad_c.revoked_at IS NULL');
    expect(sql).toContain('FROM invites ei_i');
    expect(() => restrictedEntitlementSql('s; DROP TABLE x', '$2')).toThrow();
    expect(() => restrictedEntitlementSql('s', "'x'")).toThrow();
  });
});

describe('needsApproval, autoRegisters and what the page offers, with a mode', () => {
  it('approval: only someone with no direct tie requests; the audience, invitees, listed and code holders register', () => {
    expect(needsApproval(viewer('stranger', 'public', 'approval').f, M)).toBe(true);
    for (const v of ['organiser', 'member', 'invitee', 'listed', 'codeHolder', 'removed'] as const) {
      expect({ v, needs: needsApproval(viewer(v, 'public', 'approval').f, M) }).toEqual({ v, needs: false });
    }
    expect(needsApproval(viewer('stranger', 'public', 'approval').f, UserRole.ADMIN)).toBe(false);
    expect(needsApproval({ ...viewer('stranger', 'public', 'approval').f, myRequest: 'approved' }, M)).toBe(false);
    expect(needsApproval({ ...viewer('stranger', 'public', 'approval').f, participantStatus: 'left' }, M)).toBe(false);
    expect(canRegister(viewer('stranger', 'public', 'approval').f, M, { approvedRequest: true }).ok).toBe(true);
    expect(eventAccessMode(viewer('stranger', 'public', 'approval').f, M)).toBe('request');
  });

  it('open and restricted never ask anyone to request (approval with the visibility public_with_approval included)', () => {
    for (const mode of ['open', 'restricted'] as const) {
      for (const v of VIEWERS) expect(needsApproval(viewer(v, 'public_with_approval', mode).f, M)).toBe(false);
    }
  });

  it('open: any active account registers, at any visibility (private = unlisted, the link only); a closed account never', () => {
    for (const visibility of ['public', 'public_with_approval', 'private'] as const) {
      expect(canRegister(viewer('stranger', visibility, 'open').f, M)).toEqual({ ok: true, addToPod: false });
    }
    expect(canRegister({ ...viewer('stranger', 'public', 'open').f, accountActive: false }, M).ok).toBe(false);
    expect(canSeeEvent(viewer('stranger', 'private', 'open').f, M)).toBe(false);
  });

  it('a closed circle still hides its event from someone outside it, in every mode', () => {
    for (const mode of ['open', 'approval', 'restricted'] as const) {
      const outsider = { ...viewer('stranger', 'public', mode).f, outsideClosedCircle: true };
      expect(canRegister(outsider, M)).toMatchObject({ ok: false, code: ErrorCodes.EVENT_PRIVATE });
    }
  });

  it('restricted auto-registers on opening only the entitled and the people who run it, never the audience', () => {
    expect(autoRegisters(viewer('member', 'public', 'restricted').f, M)).toBe(false);
    expect(autoRegisters(viewer('listed', 'public', 'restricted').f, M)).toBe(true);
    expect(autoRegisters(viewer('codeHolder', 'public', 'restricted').f, M)).toBe(true);
    expect(autoRegisters(viewer('invitee', 'public', 'restricted').f, M)).toBe(true);
    expect(autoRegisters(viewer('organiser', 'public', 'restricted').f, M)).toBe(true);
    expect(autoRegisters(viewer('stranger', 'public', 'restricted').f, M)).toBe(false);
    expect(autoRegisters({ ...viewer('listed', 'public', 'restricted').f, participantStatus: 'removed' }, M)).toBe(false);
    expect(autoRegisters({ ...viewer('listed', 'public', 'restricted').f, accountActive: false }, M)).toBe(false);
    // approval and open keep L17: the audience and invitees.
    expect(autoRegisters(viewer('member', 'public', 'approval').f, M)).toBe(true);
    expect(autoRegisters(viewer('stranger', 'public', 'open').f, M)).toBe(false);
  });

  it('effectiveAdmission names what decides a place, and summariseEventAccess carries it', () => {
    expect(effectiveAdmission(base)).toBe('pod_rules');
    expect(effectiveAdmission({ ...base, visibility: 'public' })).toBe('members_only');
    for (const mode of ['open', 'approval', 'restricted'] as const) {
      expect(effectiveAdmission({ ...base, visibility: 'private', admissionMode: mode })).toBe(mode);
    }
    expect(summariseEventAccess(base, M).admission).toBe('pod_rules');
  });
});

describe('admittedViaOf: what gave the place (session_participants.admitted_via)', () => {
  it('records nothing on an event without a mode', () => {
    for (const v of VIEWERS) expect(admittedViaOf(viewer(v, 'public', null).f, M)).toBeNull();
  });
  it('names the strongest tie', () => {
    expect(admittedViaOf(viewer('organiser', 'public', 'restricted').f, M)).toBe('admin');
    expect(admittedViaOf(viewer('stranger', 'public', 'restricted').f, UserRole.SUPER_ADMIN)).toBe('admin');
    expect(admittedViaOf(viewer('invitee', 'public', 'restricted').f, M)).toBe('invite');
    expect(admittedViaOf(viewer('stranger', 'public', 'restricted').f, M, { viaInvite: true })).toBe('invite');
    expect(admittedViaOf(viewer('listed', 'public', 'restricted').f, M)).toBe('allow_list');
    expect(admittedViaOf(viewer('codeHolder', 'public', 'restricted').f, M)).toBe('code');
    expect(admittedViaOf(viewer('member', 'public', 'approval').f, M)).toBe('audience');
    expect(admittedViaOf(viewer('stranger', 'public', 'approval').f, M, { approvedRequest: true })).toBe('approval');
    expect(admittedViaOf(viewer('stranger', 'public', 'open').f, M)).toBe('open');
    expect(admittedViaOf(viewer('member', 'public', 'open').f, M)).toBe('audience');
  });
});

describe('readEventAccessFacts reads the mode and the entitlement', () => {
  const row = {
    visibility: 'public', pod_id: 'p', pod_visibility: 'public', is_host: false, is_cohost: false, is_pod_organiser: false,
    in_audience: false, is_invited: false, participant_status: null, account_active: true, my_request: null,
    outside_closed_circle: false,
  };
  const read = (extra: Record<string, unknown>) => readEventAccessFacts(EVENT, ME, async () => ({ rows: [{ ...row, ...extra } as never] }));

  it('a NULL mode reads no entitlement, whatever the row says', async () => {
    expect(await read({ admission_mode: null, admission_listed: true, is_invited: true }))
      .toMatchObject({ admissionMode: null, entitled: false, entitledVia: null });
    // A row from before the migration (no admission columns at all) reads the same.
    expect(await read({})).toMatchObject({ admissionMode: null, entitled: false, entitledVia: null });
  });

  it('a mode reads the list first, then a code, then an invite', async () => {
    expect(await read({ admission_mode: 'restricted', admission_listed: true, admission_code_held: true }))
      .toMatchObject({ admissionMode: 'restricted', entitled: true, entitledVia: 'allow_list' });
    expect(await read({ admission_mode: 'approval', admission_code_held: true })).toMatchObject({ entitled: true, entitledVia: 'code' });
    expect(await read({ admission_mode: 'open', is_invited: true })).toMatchObject({ entitled: true, entitledVia: 'invite' });
    expect(await read({ admission_mode: 'restricted' })).toMatchObject({ entitled: false, entitledVia: null });
    expect(await read({ admission_mode: 'something else' })).toMatchObject({ admissionMode: null });
  });

  it('asks for the entitlement only on an event with a mode, in the same one read', async () => {
    const reader = jest.fn(async () => ({ rows: [row as never] }));
    await readEventAccessFacts(EVENT, ME, reader);
    expect(reader).toHaveBeenCalledTimes(1);
    const sql = String((reader.mock.calls[0] as unknown[])[0]).replace(/\s+/g, ' ');
    expect(sql).toContain('s.admission_mode,');
    expect(sql).toContain('(s.admission_mode IS NOT NULL AND EXISTS ( SELECT 1 FROM event_admission_entries ad_e');
    expect(sql).toContain('(s.admission_mode IS NOT NULL AND EXISTS ( SELECT 1 FROM event_admission_codes ad_c');
  });
});

// ─── Dark on production: admission_mode NULL answers exactly as before ─────────────────────────────────────

// The rules as they stood on production main (082d8c68, server/src/services/session/event-access.ts), verbatim but for
// names. APPROVAL_POD_EVENT_REFUSAL and the sentences are compared by code only.
namespace Before {
  type F = EventAccessFacts;
  const isAdminRole = (role: string | undefined) => !!role && hasRoleAtLeast(role as UserRole, UserRole.ADMIN);
  const holdsPlace = (f: F) => f.participantStatus !== null && f.participantStatus !== 'removed';
  const runsEvent = (f: F, role: string | undefined) => f.isHost || f.isCohost || isAdminRole(role);
  const hidden = (f: F, role: string | undefined, viaInvite = false) =>
    f.outsideClosedCircle && !runsEvent(f, role) && !f.inAudience && !f.isInvited && !viaInvite && !holdsPlace(f);
  export function needsApproval(f: F, role: string | undefined): boolean {
    if (f.visibility !== 'public_with_approval') return false;
    if (!f.accountActive || runsEvent(f, role) || hidden(f, role)) return false;
    return !f.inAudience && !f.isInvited && f.participantStatus === null && f.myRequest !== 'approved';
  }
  export function canRegister(f: F, role: string | undefined, o: { viaInvite?: boolean; approvedRequest?: boolean } = {}): string {
    if (!f.accountActive) return 'AUTH_FORBIDDEN';
    if (isAdminRole(role)) return 'ok';
    if (hidden(f, role, !!o.viaInvite)) return 'EVENT_PRIVATE';
    const invited = f.isInvited || !!o.viaInvite;
    if (f.visibility === null) {
      if (f.inAudience) return 'ok';
      if (f.podVisibility === 'public') return 'ok+pod';
      if (f.podVisibility === 'invite_only' || f.podVisibility === 'private') return 'AUTH_FORBIDDEN';
      if (f.podVisibility === 'public_with_approval') {
        const outsider = !f.isHost && !f.isCohost && !invited && f.participantStatus === null;
        if (outsider) return 'AUTH_FORBIDDEN';
      }
      return 'ok';
    }
    if (runsEvent(f, role) || f.inAudience || invited || holdsPlace(f) || f.participantStatus === 'removed') return 'ok';
    if (f.visibility === 'private') return 'EVENT_PRIVATE';
    if (f.visibility === 'public_with_approval' && !o.approvedRequest && f.myRequest !== 'approved') return 'EVENT_NEEDS_APPROVAL';
    return 'ok';
  }
  export function autoRegisters(f: F): boolean {
    if (f.participantStatus === 'removed') return false;
    return f.accountActive && (f.inAudience || f.isInvited || f.isHost || f.isCohost);
  }
}

describe('admission_mode NULL: every rule answers as it did before this task (exhaustive)', () => {
  const bools = [false, true];
  const combos: EventAccessFacts[] = [];
  for (const visibility of [null, 'public', 'public_with_approval', 'private'] as const)
    for (const podVisibility of ['public', 'public_with_approval', 'invite_only', 'private', null])
      for (const isHost of bools) for (const isCohost of bools) for (const inAudience of bools) for (const isInvited of bools)
        for (const participantStatus of [null, 'registered', 'left', 'removed'])
          for (const accountActive of bools) for (const myRequest of [null, 'pending', 'approved'] as const)
            for (const outsideClosedCircle of bools)
              // entitled may be set by a stale row; with no mode it must change nothing.
              for (const entitled of bools) {
                combos.push({
                  ...base, visibility, podVisibility, isHost, isCohost, inAudience, isInvited, participantStatus,
                  accountActive, myRequest, outsideClosedCircle, admissionMode: null, entitled,
                  entitledVia: entitled ? 'allow_list' : null,
                });
              }

  const asCode = (f: EventAccessFacts, role: string, o: { viaInvite?: boolean; approvedRequest?: boolean }) => {
    const d = canRegister(f, role, o);
    return d.ok ? (d.addToPod ? 'ok+pod' : 'ok') : d.code;
  };

  it(`canRegister, needsApproval and autoRegisters agree with production main on all ${'combinations'}`, () => {
    let checked = 0;
    for (const f of combos) {
      for (const role of [M, UserRole.HOST, UserRole.ADMIN, UserRole.SUPER_ADMIN, undefined] as Array<string | undefined>) {
        for (const o of [{}, { viaInvite: true }, { approvedRequest: true }]) {
          const now = asCode(f, role as string, o);
          const before = Before.canRegister(f, role, o);
          if (now !== before) throw new Error(`canRegister moved for ${JSON.stringify({ f, role, o })}: ${before} → ${now}`);
          checked++;
        }
        if (needsApproval(f, role) !== Before.needsApproval(f, role)) throw new Error(`needsApproval moved for ${JSON.stringify({ f, role })}`);
        if (autoRegisters(f, role) !== Before.autoRegisters(f)) throw new Error(`autoRegisters moved for ${JSON.stringify({ f, role })}`);
        expect(admittedViaOf(f, role)).toBeNull();
      }
    }
    expect(checked).toBeGreaterThan(100_000);
  });

  it('the live-room gate admits exactly as before when the event has no mode (admission_holds is TRUE)', async () => {
    for (const participant_status of [null, 'registered', 'left', 'no_show', 'removed']) {
      for (const is_host of bools) for (const is_cohost of bools) for (const account_closed of bools) {
        for (const role of [M, UserRole.ADMIN, undefined]) {
          const facts = { is_host, is_cohost, participant_status, account_closed };
          const before = participant_status === 'removed' ? 'removed' : account_closed ? 'refused'
            : (is_host || is_cohost || (!!role && hasRoleAtLeast(role as UserRole, UserRole.ADMIN)) || participant_status !== null) ? 'admitted' : 'refused';
          mockQuery.mockResolvedValueOnce({ rows: [{ ...facts, admission_holds: true }] });
          expect({ facts, role, now: await eventRoomAdmission(EVENT, ME, role) }).toEqual({ facts, role, now: before });
          // A row without the new column (a mocked read, or a read that never names it) also answers as before.
          mockQuery.mockResolvedValueOnce({ rows: [facts] });
          expect({ facts, role, now: await eventRoomAdmission(EVENT, ME, role) }).toEqual({ facts, role, now: before });
        }
      }
    }
  });
});

// ─── An event guest's reach, widened only by admission (Task 3's guestMayRegister, extended here) ────────────────

describe('guestMayRegister: an event with an admission mode lets in a guest it has entitled', () => {
  const EV2 = '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e';
  const facts = (over: Partial<GuestRegistrationFacts>): GuestRegistrationFacts =>
    ({ sessionId: EVENT, guestFirstSessionId: EV2, holdsPlace: false, ...over });

  it('Task 3 rules stand: a held place, or the event the guest came in through', () => {
    expect(guestMayRegister(facts({ holdsPlace: true }))).toBe(true);
    expect(guestMayRegister(facts({ guestFirstSessionId: EVENT }))).toBe(true);
    expect(guestMayRegister(facts({}))).toBe(false);
    expect(guestMayRegister(facts({ guestFirstSessionId: null }))).toBe(false);
  });

  it('an allowed email, a redeemed code, an invite or an approved request counts, only on an event with a mode', () => {
    for (const mode of ['open', 'approval', 'restricted'] as const) {
      expect(guestMayRegister(facts({ admissionMode: mode, admissionEntitled: true }))).toBe(true);
      expect(guestMayRegister(facts({ admissionMode: mode, approvedRequest: true }))).toBe(true);
      // A mode alone (open included) is not an entitlement: the link entry (Task 6) gives a guest its own.
      expect(guestMayRegister(facts({ admissionMode: mode }))).toBe(false);
    }
    expect(guestMayRegister(facts({ admissionMode: null, admissionEntitled: true }))).toBe(false);
    expect(guestMayRegister(facts({ admissionMode: null, approvedRequest: true }))).toBe(false);
  });

  it('reads the mode, the entitlement and an approved request in its one read, guarded by the mode', async () => {
    const run = jest.fn(async () => ({ rows: [{ guest_first_session_id: null, holds_place: false, admission_mode: 'restricted', admission_entitled: true, approved_request: false }] }));
    expect(await readGuestRegistrationFacts(run, EVENT, ME)).toEqual({
      sessionId: EVENT, guestFirstSessionId: null, holdsPlace: false, admissionMode: 'restricted', admissionEntitled: true, approvedRequest: false,
    });
    expect(run).toHaveBeenCalledTimes(1);
    const sql = String((run.mock.calls[0] as unknown[])[0]).replace(/\s+/g, ' ');
    expect(sql).toContain(`(s.admission_mode IS NOT NULL AND ${restrictedEntitlementSql('s', '$2').replace(/\s+/g, ' ')}) AS admission_entitled`);
    expect(sql).toContain("gr.status = 'approved'");
    expect(sql).toContain('LEFT JOIN sessions s ON s.id = $1');
    // A row from an event with no mode reads as none, whatever else it says.
    const plain = jest.fn(async () => ({ rows: [{ guest_first_session_id: null, holds_place: false, admission_mode: null, admission_entitled: false, approved_request: false }] }));
    expect(await readGuestRegistrationFacts(plain, EVENT, ME)).toMatchObject({ admissionMode: null, admissionEntitled: false });
  });

  it('the approve route\'s say-so counts before the request is marked approved', async () => {
    mockGate.mockResolvedValue({ status: 'active', kind: 'event_guest' });
    const run = jest.fn(async () => ({ rows: [{ guest_first_session_id: null, holds_place: false, admission_mode: 'approval', admission_entitled: false, approved_request: false }] }));
    await expect(assertGuestMayRegister(run, EVENT, ME)).rejects.toMatchObject({ statusCode: 403, code: 'GUEST_MEMBERSHIP_REQUIRED' });
    await expect(assertGuestMayRegister(run, EVENT, ME, { approvedRequest: true })).resolves.toEqual({ isGuest: true });
    mockGate.mockResolvedValue({ status: 'active', kind: 'member' });
    await expect(assertGuestMayRegister(run, EVENT, ME)).resolves.toEqual({ isGuest: false });
  });
});

describe('no admission path makes anyone a circle or pod member (a guest above all)', () => {
  it('the admission service, its routes, the CSV reader, the guest rule and registerParticipant never write a membership', () => {
    const fs = jest.requireActual('fs') as typeof import('fs');
    const path = jest.requireActual('path') as typeof import('path');
    const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../../..', rel), 'utf8');
    for (const rel of [
      'services/session/event-admission.service.ts', 'routes/event-admission.ts', 'services/session/admission-csv.ts',
      'services/session/guest-registration.ts',
    ]) {
      const src = read(rel).split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
      expect({ rel, writes: /INSERT INTO (circle_members|pod_members)|UPDATE (circle_members|pod_members)|joinCircle|addMember/.test(src) })
        .toEqual({ rel, writes: false });
    }
    // registerParticipant's only membership write is the public pod's auto-add, which Task 3 skips for a guest.
    const service = read('services/session/session.service.ts');
    const body = service.slice(service.indexOf('export async function registerParticipant('), service.indexOf('export async function unregisterParticipant('));
    expect(body).not.toMatch(/circle_members|joinCircle/);
    expect(body.match(/INSERT INTO pod_members/g)).toHaveLength(1);
    expect(body).toMatch(/if \(!isGuest\) \{\s*try \{\s*await client\.query\(\s*`INSERT INTO pod_members/);
  });
});
