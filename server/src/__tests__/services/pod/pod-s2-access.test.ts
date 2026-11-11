// ─── Shirley pilot S2 (11 Nov 2026): who may change a pod's access, and the retired "invite only" ────────────────────
// A host may still edit a pod's name, description and rules, but only its director (or a platform admin) changes who
// may find, join or invite to it, so a host cannot turn a private pod public. A new pod with no setting is Private;
// an old "invite only" pod is private everywhere (no request, no join).

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: async (cb: Function) => cb({ query: (...a: unknown[]) => mockQuery(...a) }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import { PodVisibility, UserRole } from '@rsn/shared';
import { ONLY_DIRECTOR_SETS_ACCESS, createPod, joinPod, requestToJoin, updatePod } from '../../../services/pod/pod.service';

const flat = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();
const POD = { id: 'p1', name: 'Curious 12', visibility: 'private', status: 'active' };

function world(myRole: string | null, pod: Record<string, unknown> = POD) {
  mockQuery.mockReset();
  mockQuery.mockImplementation(async (sql: string) => {
    const text = flat(sql);
    if (/FROM pods LEFT JOIN/.test(text)) return { rows: [pod] };
    if (/^SELECT role FROM pod_members WHERE pod_id = \$1 AND user_id = \$2 AND status = 'active'$/.test(text)) return { rows: myRole ? [{ role: myRole }] : [] };
    if (/^UPDATE pods SET/.test(text)) return { rows: [{ ...pod }], rowCount: 1 };
    if (/^INSERT INTO pods/.test(text)) return { rows: [{ id: 'new' }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
}
const updates = () => mockQuery.mock.calls.filter(([s]) => /^UPDATE pods SET/.test(flat(s)));

describe('updatePod: access settings are the director\'s (S2)', () => {
  it.each([[{ visibility: PodVisibility.PUBLIC }], [{ allowMemberInvites: true }]])('a host cannot change %j (403 in words, nothing saved)', async (input) => {
    world('host');
    await expect(updatePod('p1', 'host', input as never, UserRole.MEMBER)).rejects.toMatchObject({ statusCode: 403, message: ONLY_DIRECTOR_SETS_ACCESS });
    expect(updates()).toEqual([]);
  });

  it('a host may still edit the name, description and rules', async () => {
    world('host');
    await updatePod('p1', 'host', { name: 'Curious 12 (2027)', rules: 'Be kind' } as never, UserRole.MEMBER);
    expect(updates()).toHaveLength(1);
  });

  it('the director (and a platform admin) change the visibility', async () => {
    world('director');
    await updatePod('p1', 'dir', { visibility: PodVisibility.PRIVATE } as never, UserRole.MEMBER);
    world(null);
    await updatePod('p1', 'admin', { visibility: PodVisibility.PUBLIC_WITH_APPROVAL } as never, UserRole.ADMIN);
    expect(updates()).toHaveLength(1);
  });

  it('a member, someone removed and a stranger change nothing (403)', async () => {
    world('member');
    await expect(updatePod('p1', 'm', { name: 'x' } as never, UserRole.MEMBER)).rejects.toMatchObject({ statusCode: 403 });
    world(null);
    await expect(updatePod('p1', 'gone', { visibility: PodVisibility.PUBLIC } as never, UserRole.MEMBER)).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('the retired "invite only" (D2)', () => {
  it('a pod made with no setting is Private', async () => {
    world('director');
    await createPod('u1', { name: 'No setting' } as never);
    const insert = mockQuery.mock.calls.find(([s]) => /^INSERT INTO pods/.test(flat(s)))!;
    expect((insert[1] as unknown[])[6]).toBe('private');
  });

  it('an old invite-only pod refuses a request and a join, as a private pod does', async () => {
    world(null, { ...POD, visibility: 'invite_only' });
    await expect(requestToJoin('p1', 'stranger')).rejects.toMatchObject({ statusCode: 403, message: 'This is a private pod. You need an invite to join.' });
    await expect(joinPod('p1', 'stranger', UserRole.MEMBER)).rejects.toMatchObject({ statusCode: 403 });
  });
});
