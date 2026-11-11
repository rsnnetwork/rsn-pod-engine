// ─── An admin who is not a member can join a pod (F6, 10 Nov 2026) ───────────
//
// Stefan: "Why can I not join this? because I am admin?" A platform admin was treated as a member of every pod
// in the screen, so no Join button showed, and the server refused private and invite-only pods for everyone.
// Now an admin or super admin joins any open pod as an ordinary active member; everyone else is unchanged.
// The database is a fake that answers by what the SQL asks for.

import { UserRole } from '@rsn/shared';

let podRow: Record<string, unknown>;
let existingRow: { id: string; status: string } | null;
const txSql: Array<{ sql: string; params: unknown[] }> = [];

function answer(sql: string) {
  const s = sql.replace(/\s+/g, ' ');
  if (s.includes('FROM pods WHERE id = $1 FOR UPDATE')) return { rows: [podRow] };
  if (s.includes('SELECT COUNT(*) as count FROM pod_members')) return { rows: [{ count: '0' }] };
  if (s.includes('SELECT id, status, removal_kind, left_at FROM pod_members')) return { rows: existingRow ? [existingRow] : [] };
  if (s.startsWith('INSERT INTO pod_members') || s.startsWith('UPDATE pod_members')) {
    return { rows: [{ podId: 'p1', userId: 'u1', role: 'member', status: 'active' }] };
  }
  if (s.includes('FROM pods')) return { rows: [podRow] };
  throw new Error(`unexpected SQL: ${s.slice(0, 80)}`);
}

jest.mock('../../../db', () => ({
  query: (sql: string) => Promise.resolve(answer(sql)),
  transaction: (cb: (c: { query: (s: string, p: unknown[]) => unknown }) => unknown) =>
    cb({
      query: (sql: string, params: unknown[]) => {
        txSql.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        return Promise.resolve(answer(sql));
      },
    }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import { joinPod } from '../../../services/pod/pod.service';

function pod(visibility: string, status = 'active') {
  podRow = { id: 'p1', name: 'Pod', visibility, status, maxMembers: null };
}

beforeEach(() => {
  txSql.length = 0;
  existingRow = null;
});

describe('joinPod by a platform admin', () => {
  it.each(['private', 'invite_only', 'public_with_approval', 'public'])(
    'an admin joins a %s pod as an active member',
    async (visibility) => {
      pod(visibility);
      const member = await joinPod('p1', 'u1', UserRole.ADMIN);
      expect(member.role).toBe('member');
      expect(member.status).toBe('active');
      const insert = txSql.find((t) => t.sql.startsWith('INSERT INTO pod_members'));
      expect(insert?.params).toEqual(['p1', 'u1', 'member', 'active']);
    }
  );

  it('a super admin joins a private pod too', async () => {
    pod('private');
    await expect(joinPod('p1', 'u1', UserRole.SUPER_ADMIN)).resolves.toMatchObject({ status: 'active' });
  });

  it.each(['removed', 'declined', 'left', 'pending_approval', 'no_response'])(
    'an admin with an old %s row is reactivated to an active member, not refused on the unique key',
    async (status) => {
      pod('private');
      existingRow = { id: 'm1', status };
      await joinPod('p1', 'u1', UserRole.ADMIN);
      const update = txSql.find((t) => t.sql.startsWith('UPDATE pod_members'));
      expect(update?.params).toEqual(['member', 'active', 'p1', 'u1', true]); // S2 fix round 1: back in, so the removal mark clears
      expect(txSql.some((t) => t.sql.startsWith('INSERT INTO pod_members'))).toBe(false);
    }
  );

  it('an admin who is already an active member gets the usual conflict', async () => {
    pod('private');
    existingRow = { id: 'm1', status: 'active' };
    await expect(joinPod('p1', 'u1', UserRole.ADMIN)).rejects.toThrow(/already an active member/);
  });

  it('an admin cannot join an archived pod', async () => {
    pod('public', 'archived');
    await expect(joinPod('p1', 'u1', UserRole.ADMIN)).rejects.toThrow(/not currently active/);
  });
});

describe('joinPod by everyone else (unchanged)', () => {
  it.each([UserRole.MEMBER, undefined])('a plain member (%s) is still refused on a private pod', async (role) => {
    pod('private');
    await expect(joinPod('p1', 'u1', role)).rejects.toThrow(/requires an invite/);
  });

  it('a plain member is still refused on an invite-only pod and a with-approval pod', async () => {
    pod('invite_only');
    await expect(joinPod('p1', 'u1', UserRole.MEMBER)).rejects.toThrow(/requires an invite/);
    pod('public_with_approval');
    await expect(joinPod('p1', 'u1', UserRole.MEMBER)).rejects.toThrow(/requires approval/);
  });

  it('a plain member still joins a public pod directly', async () => {
    pod('public');
    await expect(joinPod('p1', 'u1', UserRole.MEMBER)).resolves.toMatchObject({ status: 'active' });
  });
});
