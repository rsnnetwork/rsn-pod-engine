// ─── The pod page for an admin who is not a member (F6, 10 Nov 2026) ─────────
// Stefan: "Why can I not join this? because I am admin?" Being an admin made the page treat the viewer as a
// member, so Join never showed. canManage (director or admin) and isMember (an active pod_members row) are now
// separate. The client has no test runner of its own, so this reads the source.

import * as fs from 'fs';
import * as path from 'path';

const SRC = fs
  .readFileSync(path.join(__dirname, '../../../../client/src/features/pods/PodDetailPage.tsx'), 'utf8')
  .replace(/\r\n/g, '\n');

describe('PodDetailPage membership and management are separate', () => {
  it('isMember is an active membership only, with no admin term', () => {
    const line = SRC.split('\n').find((l) => /const isMember\s+=/.test(l)) ?? '';
    expect(line).toMatch(/myMembership\?\.status === 'active'/);
    expect(line).toMatch(/pod\.memberRole/);
    expect(line).not.toMatch(/isAdminUser/);
  });

  it('canManage is the pod director or a platform admin', () => {
    const line = SRC.split('\n').find((l) => /const canManage\s+=/.test(l)) ?? '';
    expect(line).toMatch(/isPodDirector/);
    expect(line).toMatch(/isAdminUser/);
  });

  it('Join shows whenever the viewer is not a member, for an admin on any visibility', () => {
    expect(SRC).toMatch(/\{!isMember && !isPending && pod\.status === 'active' && \(/);
    expect(SRC).toMatch(/pod\.visibility === 'public' \|\| isAdminUser/);
    expect(SRC).not.toMatch(/\bisDirector\b/);
  });

  it('the manage controls stay for an admin whether or not they are a member', () => {
    expect(SRC).toMatch(/pod\.status !== 'archived' && \(isMember \|\| canManage\) &&/);
    for (const label of ['Edit Pod', 'Duplicate Pod', 'Archive Pod']) expect(SRC).toContain(label);
  });

  it('Leave shows for an active member who is not the pod director, an admin-member included', () => {
    expect(SRC).toMatch(/\{isMember && !isPodDirector && \(/);
  });

  it('an admin with a pending request is offered Join, not a pending notice', () => {
    expect(SRC).toMatch(/const isPending\s+=.*&& !isAdminUser/);
  });

  it('the wall still opens for an admin to moderate, and posting follows active membership', () => {
    expect(SRC).toMatch(/isMember=\{canOpenWall\}/);
    expect(SRC).toMatch(/const canOpenWall\s+= isMember \|\| isAdminUser;/);
    expect(SRC).toMatch(/isActiveMember=\{isActiveMember\}/);
    expect(SRC).toMatch(/const isActiveMember\s+= isMember;/);
  });
});
