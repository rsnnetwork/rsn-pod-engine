// ─── The one event-access rule, as pure decisions (T11, 1 Nov 2026; L17) ─────────────────────────────────
// Always runs (no database). The real-Postgres matrix is event-access-matrix.sql.test.ts (opt-in).

import { UserRole, defaultEventVisibility } from '@rsn/shared';
import {
  canRegister, canSeeEvent, needsApproval, summariseEventAccess, visibleEventsSql, publicEventsSql,
  eventAudienceSql, type EventAccessFacts,
} from '../../../services/session/event-access';
import { visibleEventSql } from '../../../services/session/session-access';

jest.mock('../../../db', () => ({ query: jest.fn(), transaction: jest.fn(), __esModule: true }));

const base: EventAccessFacts = {
  visibility: null, podId: 'p', podVisibility: 'private', isHost: false, isCohost: false, isPodOrganiser: false,
  inAudience: false, isInvited: false, participantStatus: null, accountActive: true, myRequest: null,
};
const f = (over: Partial<EventAccessFacts>): EventAccessFacts => ({ ...base, ...over });
const M = UserRole.MEMBER;

describe('defaultEventVisibility', () => {
  it('follows the pod: invite-only and private pods start private', () => {
    expect(defaultEventVisibility('public')).toBe('public');
    expect(defaultEventVisibility('public_with_approval')).toBe('public_with_approval');
    expect(defaultEventVisibility('invite_only')).toBe('private');
    expect(defaultEventVisibility('private')).toBe('private');
  });
});

describe('an event with its own visibility', () => {
  it('public: every active member sees and registers, and nobody is added to the pod', () => {
    const s = f({ visibility: 'public' });
    expect(canSeeEvent(s, M)).toBe(true);
    expect(canRegister(s, M)).toEqual({ ok: true, addToPod: false });
    expect(needsApproval(s, M)).toBe(false);
  });

  it('public with approval: everyone sees; the audience and invitees register; everyone else requests', () => {
    const stranger = f({ visibility: 'public_with_approval' });
    expect(canSeeEvent(stranger, M)).toBe(true);
    expect(needsApproval(stranger, M)).toBe(true);
    expect(canRegister(stranger, M)).toMatchObject({ ok: false, code: 'EVENT_NEEDS_APPROVAL' });
    expect(canRegister(stranger, M, { approvedRequest: true })).toEqual({ ok: true, addToPod: false });
    expect(canRegister(f({ visibility: 'public_with_approval', inAudience: true }), M).ok).toBe(true);
    expect(canRegister(f({ visibility: 'public_with_approval', isInvited: true }), M).ok).toBe(true);
    expect(canRegister(stranger, M, { viaInvite: true }).ok).toBe(true);
    expect(summariseEventAccess(stranger, M)).toMatchObject({ mode: 'request', autoRegister: false, canManageRequests: false });
  });

  it('private: only the audience, invitees and participants see it; others hear the private notice', () => {
    const stranger = f({ visibility: 'private' });
    expect(canSeeEvent(stranger, M)).toBe(false);
    expect(canRegister(stranger, M)).toMatchObject({ ok: false, code: 'EVENT_PRIVATE' });
    expect(summariseEventAccess(stranger, M).mode).toBe('private');
    expect(canSeeEvent(f({ visibility: 'private', inAudience: true }), M)).toBe(true);
    expect(canSeeEvent(f({ visibility: 'private', isInvited: true }), M)).toBe(true);
    expect(canSeeEvent(f({ visibility: 'private', participantStatus: 'registered' }), M)).toBe(true);
    expect(canSeeEvent(f({ visibility: 'private', participantStatus: 'removed' }), M)).toBe(false);
  });

  it('hosts, co-hosts and admins always see and manage; pod organisers manage requests', () => {
    for (const vis of ['public', 'public_with_approval', 'private'] as const) {
      expect(canSeeEvent(f({ visibility: vis, isHost: true }), M)).toBe(true);
      expect(canSeeEvent(f({ visibility: vis, isCohost: true }), M)).toBe(true);
      expect(canSeeEvent(f({ visibility: vis }), UserRole.ADMIN)).toBe(true);
      expect(summariseEventAccess(f({ visibility: vis, isPodOrganiser: true }), M).canManageRequests).toBe(true);
    }
  });

  it('auto-registers on open only the audience and invitees (L17)', () => {
    expect(summariseEventAccess(f({ visibility: 'public' }), M).autoRegister).toBe(false);
    expect(summariseEventAccess(f({ visibility: 'public', inAudience: true }), M).autoRegister).toBe(true);
    expect(summariseEventAccess(f({ visibility: 'public', isInvited: true }), M).autoRegister).toBe(true);
  });

  it('someone already holding a place is never asked to request again', () => {
    expect(needsApproval(f({ visibility: 'public_with_approval', participantStatus: 'left' }), M)).toBe(false);
  });
});

describe('a removed, suspended or banned account', () => {
  it('sees nothing and registers for nothing at every visibility', () => {
    for (const vis of [null, 'public', 'public_with_approval', 'private'] as const) {
      const closed = f({ visibility: vis, accountActive: false, inAudience: true, podVisibility: 'public' });
      expect(canSeeEvent(closed, M)).toBe(false);
      expect(canRegister(closed, M).ok).toBe(false);
      expect(needsApproval(closed, M)).toBe(false);
    }
  });
});

describe('a NULL event follows its pod, as today (T2 included)', () => {
  it('public pod: a stranger sees and registers and is added to the pod', () => {
    const s = f({ podVisibility: 'public' });
    expect(canSeeEvent(s, M)).toBe(true);
    expect(canRegister(s, M)).toEqual({ ok: true, addToPod: true });
  });
  it('approval pod (D2): an outsider is refused in words; an invitee and a held place go on', () => {
    const s = f({ podVisibility: 'public_with_approval' });
    expect(canSeeEvent(s, M)).toBe(false);
    expect(canRegister(s, M)).toMatchObject({ ok: false, code: 'AUTH_FORBIDDEN' });
    expect(canRegister(f({ podVisibility: 'public_with_approval', isInvited: true }), M).ok).toBe(true);
    expect(canRegister(f({ podVisibility: 'public_with_approval', participantStatus: 'left' }), M).ok).toBe(true);
    expect(needsApproval(s, M)).toBe(false);
  });
  it('invite-only and private pods: only active members', () => {
    for (const podVisibility of ['invite_only', 'private']) {
      expect(canSeeEvent(f({ podVisibility }), M)).toBe(false);
      expect(canRegister(f({ podVisibility }), M)).toMatchObject({ ok: false, code: 'AUTH_FORBIDDEN' });
      expect(canRegister(f({ podVisibility, inAudience: true }), M).ok).toBe(true);
    }
  });
});

describe('the list predicate', () => {
  it('keeps T2\'s legacy predicate verbatim for NULL rows and names the audience once', () => {
    const sql = visibleEventsSql('s', '$1');
    expect(sql).toContain(`(s.visibility IS NULL AND ${visibleEventSql('s', '$1')})`);
    expect(sql).toContain("s.visibility IN ('public', 'public_with_approval')");
    expect(sql).toContain(eventAudienceSql('s', '$1'));
    expect(publicEventsSql('s')).toContain("pe_p.visibility = 'public'");
  });
  it('refuses anything that is not an alias and a placeholder', () => {
    expect(() => visibleEventsSql('s; DROP', '$1')).toThrow();
    expect(() => visibleEventsSql('s', "'x'")).toThrow();
  });
});
