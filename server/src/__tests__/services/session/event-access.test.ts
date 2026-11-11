// ─── The one event-access rule, as pure decisions (T11, 1 Nov 2026; L17) ─────────────────────────────────
// Always runs (no database). The real-Postgres matrix is event-access-matrix.sql.test.ts (opt-in).

import { UserRole, defaultEventVisibility } from '@rsn/shared';
import {
  canRegister, canSeeEvent, needsApproval, summariseEventAccess, visibleEventsSql, publicEventsSql,
  eventAudienceSql, closedCircleOutsiderSql, CLOSED_CIRCLE_EVENT_SENTENCE, type EventAccessFacts,
} from '../../../services/session/event-access';
import { visibleEventSql } from '../../../services/session/session-access';

jest.mock('../../../db', () => ({ query: jest.fn(), transaction: jest.fn(), __esModule: true }));

const base: EventAccessFacts = {
  visibility: null, podId: 'p', podVisibility: 'private', isHost: false, isCohost: false, isPodOrganiser: false,
  inAudience: false, isInvited: false, participantStatus: null, accountActive: true, myRequest: null,
  outsideClosedCircle: false,
  publication: 'published', archived: false, registrationOpensAt: null, eventTimezone: null, isPodAdmin: false, placesHeld: 0,
  admissionMode: null, entitled: false, entitledVia: null,
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

describe('fix round 1', () => {
  it('someone approved who then unregistered registers again and is never asked to request again', () => {
    const approved = f({ visibility: 'public_with_approval', myRequest: 'approved', participantStatus: null });
    expect(needsApproval(approved, M)).toBe(false);
    expect(canRegister(approved, M)).toEqual({ ok: true, addToPod: false });
    expect(summariseEventAccess(approved, M).mode).toBe('register');
    const pending = f({ visibility: 'public_with_approval', myRequest: 'pending' });
    expect(canRegister(pending, M)).toMatchObject({ ok: false, code: 'EVENT_NEEDS_APPROVAL' });
  });

  it('opening a NULL event registers only the pod\'s members, invitees, host and co-hosts (L17 for every event)', () => {
    expect(summariseEventAccess(f({ podVisibility: 'public' }), M).autoRegister).toBe(false);
    expect(summariseEventAccess(f({ podVisibility: 'public' }), M).mode).toBe('register');
    expect(summariseEventAccess(f({ podVisibility: 'public', inAudience: true }), M).autoRegister).toBe(true);
    expect(summariseEventAccess(f({ podVisibility: 'public_with_approval', isInvited: true }), M).autoRegister).toBe(true);
    expect(summariseEventAccess(f({ podVisibility: 'private', isHost: true }), M).autoRegister).toBe(true);
    expect(summariseEventAccess(f({ podVisibility: 'public' }), UserRole.ADMIN).autoRegister).toBe(false);
    expect(summariseEventAccess(f({ podVisibility: 'public', inAudience: true, accountActive: false }), M).autoRegister).toBe(false);
  });
});

describe('someone the host removed from the event (final fix wave SM2)', () => {
  it('is never told that opening the page registers them, whatever their ties (a kick is final)', () => {
    for (const vis of [null, 'public', 'public_with_approval', 'private'] as const) {
      for (const tie of [{ inAudience: true }, { isInvited: true }, { inAudience: true, isInvited: true }]) {
        const removed = f({ visibility: vis, podVisibility: 'public', participantStatus: 'removed', ...tie });
        expect(summariseEventAccess(removed, M).autoRegister).toBe(false);
      }
    }
    // A pod member who still holds a place is told, as before.
    expect(summariseEventAccess(f({ podVisibility: 'public', inAudience: true, participantStatus: 'registered' }), M).autoRegister).toBe(true);
  });

  it("keeps the access block's shape: production's client (origin/main) never reads it, and only a value changed (Part 2 Task 4 adds one field, admission, and removes none)", () => {
    const removed = f({ podVisibility: 'public', inAudience: true, participantStatus: 'removed' });
    expect(Object.keys(summariseEventAccess(removed, M)).sort())
      .toEqual(['admission', 'autoRegister', 'canManageRequests', 'mode', 'myRequest', 'visibility']);
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

// ─── T14 (1 Nov 2026, L22): a closed circle hides its events from people outside it ──────────────────────────
// An event for a whole circle (sessions.circle_id) whose circle is closed is for the people in the circle, whatever the
// event's own visibility, public included. Its host, co-hosts, invitees, participants and its pod's own members keep
// what they had (the event lives in the pod); admins see everything. `outsideClosedCircle` is true for a person with no
// circle_members row (and not its creator) when the event names a closed circle.
describe('an event of a closed circle', () => {
  const outsider = (over: Partial<EventAccessFacts> = {}) => f({ visibility: 'public', outsideClosedCircle: true, ...over });

  it.each(['public', 'public_with_approval', 'private'] as const)('%s: someone outside the circle neither sees, requests nor registers', (visibility) => {
    const s = outsider({ visibility });
    expect(canSeeEvent(s, M)).toBe(false);
    expect(needsApproval(s, M)).toBe(false);
    expect(canRegister(s, M)).toEqual({ ok: false, status: 403, code: 'EVENT_PRIVATE', message: CLOSED_CIRCLE_EVENT_SENTENCE });
    expect(summariseEventAccess(s, M)).toMatchObject({ mode: 'private', autoRegister: false });
  });

  it('a member of the circle (its audience, outsideClosedCircle false) sees and registers a public one', () => {
    const member = f({ visibility: 'public', inAudience: true, outsideClosedCircle: false });
    expect(canSeeEvent(member, M)).toBe(true);
    expect(canRegister(member, M)).toEqual({ ok: true, addToPod: false });
  });

  it('the host, a co-host, an invitee, someone holding a place, the pod\'s own members and admins keep what they had', () => {
    for (const keeps of [{ isHost: true }, { isCohost: true }, { isInvited: true }, { participantStatus: 'registered' }, { inAudience: true }]) {
      expect(canSeeEvent(outsider(keeps), M)).toBe(true);
      expect(canRegister(outsider(keeps), M).ok).toBe(true);
    }
    expect(canSeeEvent(outsider(), UserRole.ADMIN)).toBe(true);
    expect(canRegister(outsider(), UserRole.ADMIN).ok).toBe(true);
    expect(canRegister(outsider(), M, { viaInvite: true }).ok).toBe(true);
  });

  it('the list predicate leaves the event out for someone outside the closed circle, and the logged-out list never names it', () => {
    const list = visibleEventsSql('s', '$2').replace(/\s+/g, ' ');
    expect(list).toContain(`AND NOT ${closedCircleOutsiderSql('s', '$2').replace(/\s+/g, ' ')}`);
    const hidden = closedCircleOutsiderSql('s', '$2').replace(/\s+/g, ' ');
    expect(hidden).toContain("s.circle_id IS NOT NULL AND EXISTS (SELECT 1 FROM circles cc_c WHERE cc_c.id = s.circle_id AND cc_c.join_policy = 'closed'");
    expect(hidden).toContain('cc_c.created_by <> $2');
    expect(hidden).toContain('NOT EXISTS (SELECT 1 FROM circle_members cc_m WHERE cc_m.circle_id = s.circle_id AND cc_m.user_id = $2)');
    expect(publicEventsSql('s').replace(/\s+/g, ' ')).toContain(
      "AND NOT (s.circle_id IS NOT NULL AND EXISTS (SELECT 1 FROM circles pc_c WHERE pc_c.id = s.circle_id AND pc_c.join_policy = 'closed'))",
    );
    expect(() => closedCircleOutsiderSql('s; DROP', '$2')).toThrow();
  });
});
