// ─── Circles on the preview: invites that work, Open or Closed, a new pod from the circle (T14, 1 Nov 2026) ───────
// 30 Oct review, section 7: "Circle invites don't work", "Who can join a Circle: open or closed (same as Parts)",
// "Create a new Part from the Circle screen". The pure rules run here; the screens are pinned by what they must hold.

import * as fs from 'fs';
import * as path from 'path';
import {
  ATTACH_EMPTY, LOCKED_COPY, POLICY_COPY, canRemoveMember, circleEntities, joinButton, joinToast, placeOf, podMadeToast,
  requestsLabel, roleBadge,
} from '../../../../client/src/features/circles/circle-logic';
import {
  batchBody, batchSentence, candidateEntities, candidateParams, emailInviteBody, linkBody, pickerTitle, shareLinkNote,
  targetId, targetTags, type InviteTarget,
} from '../../../../client/src/features/invites/invite-picker';
import { acceptedDestination, canActOnInvite, inviteStatusLabel } from '../../../../client/src/features/notifications/notification-logic';

const SRC = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const C = 'c1';

describe('the circle button', () => {
  it('reads Join (open), Ask to join (closed), Requested · Cancel (waiting) or Leave', () => {
    expect(joinButton({ isMember: false, joinPolicy: 'open', myStatus: null })).toEqual({ action: 'join', label: 'Join' });
    expect(joinButton({ isMember: false, joinPolicy: 'closed', myStatus: null })).toEqual({ action: 'request', label: 'Ask to join' });
    expect(joinButton({ isMember: false, joinPolicy: 'closed', myStatus: 'declined' })).toEqual({ action: 'request', label: 'Ask to join' });
    expect(joinButton({ isMember: false, joinPolicy: 'closed', myStatus: 'requested' })).toEqual({ action: 'cancel', label: 'Requested · Cancel' });
    expect(joinButton({ isMember: true, joinPolicy: 'closed', myStatus: 'member' })).toEqual({ action: 'leave', label: 'Leave' });
  });

  it('someone who runs a closed circle without being in it joins directly; an older server (no myStatus) reads isMember', () => {
    expect(joinButton({ isMember: false, joinPolicy: 'closed', myStatus: null, canManage: true }).action).toBe('join');
    expect(placeOf({ isMember: true })).toBe('member');
    expect(joinButton({ isMember: false })).toEqual({ action: 'join', label: 'Join' });
  });

  it('says what happened after the call', () => {
    expect(joinToast('request', 'Founders', { status: 'requested' })).toBe('Your request to join Founders was sent.');
    expect(joinToast('request', 'Founders', { status: 'member' })).toBe('Welcome to Founders!');
    expect(joinToast('cancel', 'Founders')).toBe('Your request was withdrawn.');
    expect(joinToast('leave', 'Founders')).toBe('You left Founders.');
  });
});

describe('the words, verbatim from the review and the brief', () => {
  it('the setting, the locked state and the new pod toast', () => {
    expect(POLICY_COPY.open).toBe('Open: anyone on REASON can join.');
    expect(POLICY_COPY.closed).toBe('Closed: people ask to join and you approve them. People you invite join straight away.');
    expect(LOCKED_COPY).toBe('This circle is closed. Ask to join to see its wall, members and events.');
    expect(podMadeToast('Breakfast club', 'Founders')).toBe('Breakfast club is created and added to Founders.');
    expect(requestsLabel(0)).toBe('Requests');
    expect(requestsLabel(3)).toBe('Requests (3)');
    expect(ATTACH_EMPTY).not.toMatch(/RSN|session/i);
  });

  it('the setting sheet draws each choice as its exact sentence, the label in bold', () => {
    const sheet = read('features/circles/CircleSettingsSheet.tsx');
    expect(sheet).toContain('<b>{POLICY_LABEL[policy]}:</b>{POLICY_COPY[policy].slice(POLICY_LABEL[policy].length + 1)}');
    expect(sheet).toMatch(/type="radio"/);
  });
});

describe('who may do what on a member row', () => {
  it('the people who run it remove anyone but the owner and themselves', () => {
    expect(canRemoveMember({ userId: 'u2', role: 'member' }, 'u1', true)).toBe(true);
    expect(canRemoveMember({ userId: 'u2', role: 'owner' }, 'u1', true)).toBe(false);
    expect(canRemoveMember({ userId: 'u1', role: 'member' }, 'u1', true)).toBe(false);
    expect(canRemoveMember({ userId: 'u2', role: 'member' }, 'u1', false)).toBe(false);
    expect(roleBadge('owner')).toBe('OWNER');
    expect(roleBadge('moderator')).toBe('MOD');
    expect(roleBadge('member')).toBeNull();
  });
});

describe('realtime: the circle screens follow the server\'s circle tags', () => {
  it('the page follows the circle, its members and the member\'s own circles (and the asks for its managers)', () => {
    // T13: and the member's own events (a new event for the circle reaches their events list).
    expect(circleEntities(C, 'me')).toEqual(['circle:c1', 'circle:c1:members', 'user:me:circles', 'user:me', 'user:me:sessions']);
    expect(circleEntities(C, 'me', true)).toContain('circle:c1:requests');
    const page = read('features/circles/CircleDetailPage.tsx');
    expect(page).toMatch(/meta: \{ entities: circleEntities\(circleId \?\? '', user\?\.id\) \}/);
    expect(read('features/circles/CirclesPage.tsx')).toMatch(/meta: \{ entities: user\?\.id \? \[E\.userCircles\(user\.id\), E\.user\(user\.id\)\] : \[\] \}/);
    expect(read('features/circles/CircleRequestsSheet.tsx')).toMatch(/meta: \{ entities: \[E\.circleRequests\(circleId\), E\.circle\(circleId\)\] \}/);
  });

  it('the attach picker (a useInfiniteQuery, which the realtime guard does not scan) declares its tags and pages with pageSize', () => {
    const attach = read('features/circles/AttachPodSheet.tsx');
    expect(attach).toMatch(/useInfiniteQuery\(\{/);
    expect(attach).toMatch(/meta: \{ entities: \[E\.circle\(circleId\), \.\.\.\(me \? \[E\.userPods\(me\)\] : \[\]\)\] \}/);
    expect(attach).toMatch(/\/circles\/\$\{circleId\}\/attachable-pods/);
    expect(attach).toMatch(/pageSize: 50/);
    expect(attach).toContain('Create a new pod');
    expect(attach.replace(/\/\/.*$/gm, '')).not.toMatch(/<select/);
  });
});

describe('the invite sheet, for a circle', () => {
  const circle: InviteTarget = { type: 'circle', circleId: C };

  it('asks the server for the circle and sends circle invites', () => {
    expect(targetId(circle)).toBe(C);
    expect(pickerTitle(circle)).toBe('Invite people');
    expect(candidateParams(circle, 'connections', ' ana ', null)).toEqual({ source: 'connections', limit: 30, circleId: C, q: 'ana' });
    expect(batchBody(circle, ['u1'])).toEqual({ type: 'circle', circleId: C, inviteeUserIds: ['u1'] });
    expect(emailInviteBody(circle, ' a@b.co ')).toEqual({ type: 'circle', circleId: C, inviteeEmail: 'a@b.co', maxUses: 1, expiresInHours: 168 });
    expect(linkBody(circle, 500)).toEqual({ type: 'circle', circleId: C, maxUses: 500, expiresInHours: 168 });
    expect(shareLinkNote(circle, 500)).toBe('Anyone with this link can join the circle, up to 500 people, for 7 days.');
  });

  it('follows the circle\'s tags, and says "already in the circle"', () => {
    expect(targetTags(circle)).toEqual(['circle:c1', 'circle:c1:members', 'circle:c1:invites']);
    expect(candidateEntities(circle, 'connections', 'me')).toEqual(['circle:c1', 'circle:c1:members', 'circle:c1:invites', 'user:me:invites', 'user:me:blocks']);
    const counts = { invited: 0, already_member: 2, already_going: 0, already_invited: 0, declined: 0, not_allowed: 0, failed: 0 };
    expect(batchSentence({ results: [], counts }, 'circle').message).toBe('2 people are already in the circle.');
    expect(batchSentence({ results: [], counts }).message).toBe('2 people are already in the pod.');
  });

  it('the circle page opens the shared sheet with the circle as its target, shown when the server says canInvite', () => {
    const page = read('features/circles/CircleDetailPage.tsx');
    expect(page).toMatch(/<InvitePickerSheet open=\{sheet === 'invite'\} onClose=\{\(\) => setSheet\(null\)\} target=\{\{ type: 'circle', circleId: circle\.id \}\} \/>/);
    expect(page).toMatch(/const canInvite = circle\.canInvite \?\? circle\.isMember;/);
    expect(page).not.toMatch(/\/invites\?type=circle/);
    // The legacy deep link still works for production's client: the Invites page reads ?type=circle&circleId=.
    expect(read('features/invites/InvitesPage.tsx')).toMatch(/presetType === 'circle'/);
  });
});

describe('the bell and the Invites page, for a circle invite', () => {
  it('a circle invite is answered in place in the bell, and accepting lands on the circle', () => {
    const n = { id: 'n1', type: 'circle_invite', title: 'x', link: '/invite/ABCdef123', isRead: false, createdAt: '2026-11-01T00:00:00Z', inviteStatus: 'pending' };
    expect(canActOnInvite(n)).toBe(true);
    expect(inviteStatusLabel({ ...n, inviteStatus: 'accepted' })).toEqual({ text: 'Accepted', color: 'text-emerald-700' });
    expect(acceptedDestination({ circleId: C })).toBe('/circles/c1');
    expect(acceptedDestination({ sessionId: 's1', circleId: C })).toBe('/sessions/s1');
    expect(acceptedDestination({ podId: 'p1' })).toBe('/pods/p1');
    expect(acceptedDestination(null)).toBeNull();
    expect(read('features/notifications/useNotificationActions.ts')).toMatch(/acceptedDestination\(\{ sessionId: data\?\.sessionId \|\| n\.sessionId, podId: data\?\.podId \|\| n\.podId, circleId: data\?\.circleId \}\)/);
  });

  it('the Invites page labels a circle invite with its circle and accepting it lands on the circle', () => {
    const page = read('features/invites/InvitesPage.tsx');
    expect(page).toContain('const dest = acceptedDestination(res.data?.data);');
    expect(page).toContain("inv.podName || inv.sessionTitle || inv.circleName || 'REASON'");
    expect(page).toMatch(/c\.canInvite \?\? \(userIsAdmin \|\| c\.isMember\)/);
  });
});

describe('a new pod from the circle', () => {
  const modal = read('features/pods/CreatePodModal.tsx');
  it('reads "New pod in {circle}", sends the circle, and stays on the circle with the toast', () => {
    expect(modal).toMatch(/title=\{circle \? `New pod in \$\{circle\.name\}`/);
    expect(modal).toMatch(/api\.post\('\/pods', circle \? \{ \.\.\.podBody\(values\), circleId: circle\.id \} : podBody\(values\)\)/);
    const success = modal.slice(modal.indexOf('if (circle) {'), modal.indexOf('return;', modal.indexOf('if (circle) {')));
    expect(success).toMatch(/podMadeToast\(/);
    expect(success).not.toMatch(/navigate\(/);
  });

  it('the pods section offers New pod and Attach a pod to the people who run the circle only', () => {
    const pods = read('features/circles/CirclePodsSection.tsx');
    expect(pods).toMatch(/const manager = !!circle\.canManage;/);
    expect(pods).toMatch(/<CreatePodModal open=\{sheet === 'new'\} onClose=\{\(\) => setSheet\(null\)\} circle=\{\{ id: circle\.id, name: circle\.name \}\} \/>/);
    expect(pods).not.toMatch(/isAdmin\(/);
  });
});

describe('a closed circle from outside, and the asks', () => {
  const page = read('features/circles/CircleDetailPage.tsx');
  it('a locked circle shows the sentence and no wall, pods or members', () => {
    expect(page).toMatch(/\{circle\.locked && \(/);
    expect(page).toMatch(/\{!circle\.locked && <CirclePodsSection/);
    expect(page).toMatch(/\{!circle\.locked && \(\s*<div[^>]*>\s*<h2[\s\S]*?Wall/);
    expect(page).toMatch(/\{!circle\.locked && <CircleMembersSection/);
  });

  it('?requests=1 opens the asks, for the people who run the circle only', () => {
    expect(page).toMatch(/const requestsOpen = !!circle\.canManage && searchParams\.get\('requests'\) === '1';/);
    const sheet = read('features/circles/CircleRequestsSheet.tsx');
    expect(sheet).toContain('>Approve</Button>');
    expect(sheet).toContain('>Decline</Button>');
    expect(sheet).toMatch(/min-h-\[44px\]/);
  });

  it('every circle file stays within 200 lines', () => {
    for (const f of ['CircleDetailPage.tsx', 'CirclesPage.tsx', 'CircleJoinButton.tsx', 'CircleSettingsSheet.tsx', 'CircleRequestsSheet.tsx',
      'CirclePodsSection.tsx', 'CircleMembersSection.tsx', 'AttachPodSheet.tsx', 'circle-logic.ts', 'useCircleActions.ts']) {
      expect(read(`features/circles/${f}`).split('\n').length).toBeLessThanOrEqual(200);
    }
  });
});
