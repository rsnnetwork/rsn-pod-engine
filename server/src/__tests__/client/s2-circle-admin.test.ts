// ─── Shirley pilot S2 (11 Nov 2026): the circle and pod screens that give an owner authority ───────────────────────
// Brief RSN 02/03/04 and the visibility table; plan D2, D3. The pure rules run here (circle-admin.ts, pod-type-form.ts);
// the screens are pinned by what they must hold: who sees which control, the confirm before a handover or leaving,
// 44px taps, sheets portalled through Sheet, and every new query following its entity tags.

import * as fs from 'fs';
import * as path from 'path';
import {
  MEMBER_ACTION_LABEL, circleEdits, circleInviteEntities, handoverQuestion, memberActions, ownsCircle, podVisibilityBadge,
  roleToast,
} from '../../../../client/src/features/circles/circle-admin';
import { canRemoveMember } from '../../../../client/src/features/circles/circle-logic';
import { podVisibilitySetting } from '../../../../client/src/features/pods/pod-type-form';
import { POD_VISIBILITY_COPY, POD_VISIBILITY_SETTINGS, isDiscoverablePod } from '@rsn/shared';

const SRC = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const C = 'c1';

describe('what each viewer may do to a member row (memberActions)', () => {
  const owner = { canManage: true, isOwner: true };
  const moderator = { canManage: true, isOwner: false };
  const member = { canManage: false, isOwner: false };
  const admin = { canManage: true, isOwner: true }; // a platform admin holds the owner's powers

  it('the owner: make or unmake a moderator, make owner, remove; never on themselves or the owner row', () => {
    expect(memberActions({ userId: 'm', role: 'member' }, 'o', owner)).toEqual(['make-moderator', 'make-owner', 'remove']);
    expect(memberActions({ userId: 'd', role: 'moderator' }, 'o', owner)).toEqual(['remove-moderator', 'make-owner', 'remove']);
    expect(memberActions({ userId: 'o', role: 'owner' }, 'o', owner)).toEqual([]);
  });

  it('a moderator removes plain members only: never another moderator, never the owner, never themselves', () => {
    expect(memberActions({ userId: 'm', role: 'member' }, 'd', moderator)).toEqual(['remove']);
    expect(memberActions({ userId: 'd2', role: 'moderator' }, 'd', moderator)).toEqual([]);
    expect(memberActions({ userId: 'o', role: 'owner' }, 'd', moderator)).toEqual([]);
    expect(memberActions({ userId: 'd', role: 'moderator' }, 'd', moderator)).toEqual([]);
  });

  it('a member, or anyone who does not run it, has nothing; a platform admin acts as the owner but never on the owner row', () => {
    expect(memberActions({ userId: 'm', role: 'member' }, 'x', member)).toEqual([]);
    expect(memberActions({ userId: 'o', role: 'owner' }, 'a', admin)).toEqual([]);
    expect(memberActions({ userId: 'm', role: 'member' }, 'a', admin)).toEqual(['make-moderator', 'make-owner', 'remove']);
  });

  it('canRemoveMember follows the same rule (a moderator no longer removes a moderator)', () => {
    expect(canRemoveMember({ userId: 'd2', role: 'moderator' }, 'd', true, false)).toBe(false);
    expect(canRemoveMember({ userId: 'd2', role: 'moderator' }, 'o', true, true)).toBe(true);
    expect(canRemoveMember({ userId: 'm', role: 'member' }, 'd', true)).toBe(true);
  });

  it('every action has a label in words; the handover question names what changes for both people', () => {
    expect(Object.values(MEMBER_ACTION_LABEL)).toEqual(['Make moderator', 'Remove as moderator', 'Make owner', 'Remove from circle']);
    const q = handoverQuestion('Shirley', 'Curious Humans');
    expect(q.title).toBe('Make Shirley the owner of Curious Humans?');
    expect(q.body).toMatch(/You become a moderator/);
    expect(q.body).toMatch(/can no longer change roles or hand it over/);
    expect(roleToast('make-owner', 'Shirley', 'Curious Humans')).toBe('Shirley now owns Curious Humans. You are a moderator.');
    expect(roleToast('make-moderator', 'Stefan', 'Curious Humans')).toBe('Stefan is now a moderator of Curious Humans.');
  });

  it('ownsCircle is the viewer\'s own role, not a platform admin\'s powers', () => {
    expect(ownsCircle({ myRole: 'owner' })).toBe(true);
    expect(ownsCircle({ myRole: 'moderator' })).toBe(false);
    expect(ownsCircle({ myRole: null })).toBe(false);
  });
});

describe('the edit form sends only what changed (circleEdits)', () => {
  const before = { name: 'Curious Humans', description: 'Old', joinPolicy: 'open' as const };

  it('trims, clears an emptied description to null, and leaves out unchanged fields', () => {
    expect(circleEdits(before, { name: ' Curious Humans ', description: 'Old', joinPolicy: 'open' }, true)).toEqual({});
    expect(circleEdits(before, { name: 'Curious Humans 2', description: '  ', joinPolicy: 'open' }, true))
      .toEqual({ name: 'Curious Humans 2', description: null });
  });

  it('who can join goes only when the viewer may choose it (the owner); a moderator\'s form never sends it', () => {
    expect(circleEdits(before, { name: 'Curious Humans', description: 'Old', joinPolicy: 'closed' }, true)).toEqual({ joinPolicy: 'closed' });
    expect(circleEdits(before, { name: 'Curious Humans', description: 'Old', joinPolicy: 'closed' }, false)).toEqual({});
  });
});

describe('pod visibility, one vocabulary (D2)', () => {
  it('three settings, each saying who finds it, who sees inside and how people get in', () => {
    expect([...POD_VISIBILITY_SETTINGS]).toEqual(['private', 'public_with_approval', 'public']);
    expect(POD_VISIBILITY_COPY.private.summary).toMatch(/Not listed anywhere/);
    expect(POD_VISIBILITY_COPY.private.summary).toMatch(/invites/);
    expect(POD_VISIBILITY_COPY.public_with_approval.summary).toMatch(/you approve each person/);
    expect(POD_VISIBILITY_COPY.public_with_approval.summary).toMatch(/Only members see its discussion, members and events/);
    expect(POD_VISIBILITY_COPY.public.summary).toMatch(/join straight away/);
  });

  it('only public and public with approval are discoverable; an old invite-only row is private everywhere', () => {
    expect(['public', 'public_with_approval', 'private', 'invite_only', 'request_to_join', null].map(isDiscoverablePod))
      .toEqual([true, true, false, false, false, false]);
    expect(podVisibilitySetting('invite_only')).toBe('private');
    expect(podVisibilitySetting(undefined)).toBe('private');
    expect(podVisibilitySetting('public_with_approval')).toBe('public_with_approval');
    expect(podVisibilityBadge('invite_only')).toBe('Private');
    expect(podVisibilityBadge('public_with_approval')).toBe('Approval');
    expect(podVisibilityBadge('public')).toBeNull();
  });

  it('no form or list offers "Invite only" any more', () => {
    const form = read('features/pods/PodFormFields.tsx');
    expect(form).toMatch(/const VISIBILITY_OPTIONS = POD_VISIBILITY_SETTINGS\.map/);
    expect(form).not.toMatch(/'invite_only'/);
    for (const f of ['features/pods/PodDetailPage.tsx', 'features/pods/PodsPage.tsx', 'features/sessions/EventAccessField.tsx']) {
      expect(read(f)).not.toMatch(/Invite Only|Invite only'/);
    }
  });
});

describe('the circle page (S2 controls)', () => {
  const page = read('features/circles/CircleDetailPage.tsx');

  // Shirley pilot S3 (RSN 11): the three are entries of the circle's Manage menu now, with the same test ids; who sees
  // which is circleManageKeys (canManage; Visibility for isOwner), pinned in shirley-s3-manage-communities.test.ts.
  it('Edit details and Invitations for the people who run it; Who can join for the owner only (in the Manage menu)', () => {
    const menu = read('features/circles/CircleManageMenu.tsx');
    expect(page).toMatch(/<CircleManageMenu circle=\{circle\} openSheet=\{setSheet\} openRequests=\{openRequests\} \/>/);
    expect(menu).toMatch(/edit: \{ key: 'edit', onSelect: \(\) => openSheet\('edit'\), testId: 'circle-edit' \}/);
    expect(menu).toMatch(/invitations: \{ key: 'invitations', onSelect: \(\) => openSheet\('invitations'\), testId: 'circle-invitations' \}/);
    expect(menu).toMatch(/onSelect: \(\) => openSheet\('settings'\),\s*testId: 'circle-settings'/);
    expect(menu).toMatch(/circleManageKeys\(circle, mayExportCircle\(circle\.myRole\)\)/);
    expect(page).not.toMatch(/data-testid="circle-edit"|data-testid="circle-invitations"|data-testid="circle-settings"/);
  });

  it('the members section: a 44px Manage button only where there is an action, a sheet of actions, a confirm before a handover or a removal', () => {
    const members = read('features/circles/CircleMembersSection.tsx');
    expect(members).toMatch(/\{actions\.length > 0 && \(/);
    expect(members).toMatch(/className="flex min-h-\[44px\] min-w-\[44px\]/);
    expect(members).toMatch(/aria-label=\{`Manage \$\{name\}`\}/);
    expect(members).toMatch(/import Sheet from '@\/features\/reason\/ui\/Sheet';/);
    expect(members).toMatch(/if \(action === 'make-owner'\) \{\s*const q = handoverQuestion\(name, circle\.name\);\s*if \(!\(await ask\(\{ \.\.\.q, confirmLabel: 'Make owner', tone: 'danger' \}\)\)\) return;/);
    expect(members).toMatch(/api\.post\(`\/circles\/\$\{circle\.id\}\/transfer`, \{ toUserId: userId \}\)/);
    expect(members).toMatch(/api\.patch\(`\/circles\/\$\{circle\.id\}\/members\/\$\{userId\}\/role`/);
    expect(members).toMatch(/className=\{`\$\{SHEET_ACTION\}/);
    expect(members).toMatch(/const SHEET_ACTION = 'flex min-h-\[48px\]/);
  });

  it('the owner has no Leave: the button says they own it', () => {
    const button = read('features/circles/CircleJoinButton.tsx');
    expect(button).toMatch(/if \(ownsCircle\(circle\)\) \{/);
    expect(button).toMatch(/You own this circle/);
  });

  it('the edit sheet: name and description validated inline; who can join only for the owner; a Sheet (portalled)', () => {
    const edit = read('features/circles/EditCircleSheet.tsx');
    expect(edit).toMatch(/const mayChoosePolicy = !!circle\.isOwner;/);
    expect(edit).toMatch(/\{mayChoosePolicy && \(\s*<fieldset/);
    expect(edit).toMatch(/useForm<Values>/);
    expect(edit).toMatch(/errors\.root/);
    expect(edit).toMatch(/<Sheet\s/);
  });

  it('the invitations sheet follows the circle\'s invites tag, has loading, empty and error states, and asks before a withdrawal', () => {
    const inv = read('features/circles/CircleInvitesSheet.tsx');
    expect(inv).toMatch(/meta: \{ entities: circleInviteEntities\(circleId\) \}/);
    expect(circleInviteEntities(C)).toEqual(['circle:c1', 'circle:c1:invites', 'circle:c1:members']);
    expect(inv).toMatch(/list\.isPending &&/);
    expect(inv).toMatch(/list\.isError &&/);
    expect(inv).toMatch(/rows\.length === 0/);
    expect(inv).toMatch(/title: 'Withdraw this invitation\?'/);
    expect(inv).toMatch(/min-h-\[44px\]/);
  });

  it('each pod on the circle says Private or Approval', () => {
    expect(read('features/circles/CirclePodsSection.tsx')).toMatch(/podVisibilityBadge\(p\.visibility\)/);
  });
});

describe('the pod page (S2)', () => {
  const pod = read('features/pods/PodDetailPage.tsx');
  const chips = read('features/pods/PodCircleChips.tsx');

  it('"In circles" follows the pod\'s tag (no more realtime skip) and offers the director a Remove that asks first', () => {
    expect(chips).toMatch(/meta: \{ entities: podId \? \[E\.pod\(podId\)\] : \[\] \}/);
    expect(chips).not.toMatch(/realtime: skip/);
    expect(chips).toMatch(/\{canUnlink && \(/);
    expect(chips).toMatch(/title: `Take \$\{podName\} out of \$\{circle\.name\}\?`/);
    expect(chips).toMatch(/api\.delete\(`\/circles\/\$\{circle\.id\}\/pods\/\$\{podId\}`\)/);
    expect(chips).toMatch(/className="flex min-h-\[44px\] min-w-\[44px\]/);
    expect(pod).toMatch(/<PodCircleChips podId=\{podId\} podName=\{pod\.name\} canUnlink=\{isPodDirector \|\| isAdminUser\} \/>/);
  });

  it('Leave Pod asks first, in words for each setting', () => {
    expect(pod).toMatch(/if \(await ask\(\{\s*title: `Leave \$\{pod\.name\}\?`/);
    expect(pod).toMatch(/To come back you need a new invitation\./);
    expect(pod).not.toMatch(/onClick=\{\(\) => leaveMutation\.mutate\(\)\}/);
  });

  // Fix round 1: removing a member asks first, says they cannot come back by themselves, and shows the server's words.
  it('Remove member asks first, in words that match the re-entry rule, and a refusal shows the server\'s sentence', () => {
    expect(pod).toMatch(/onClick=\{\(\) => void removeMember\(m\.userId, m\.displayName \|\| 'this member'\)\}/);
    expect(pod).not.toMatch(/onClick=\{\(\) => removeMemberMutation\.mutate\(m\.userId\)\}/);
    expect(pod).toMatch(/They cannot rejoin by themselves/);
    expect(pod).toMatch(/onError: \(err: any\) => addToast\(err\?\.response\?\.data\?\.error\?\.message \|\| 'They could not be removed\. Try again\.', 'error'\)/);
    expect(read('features/circles/CircleMembersSection.tsx')).toMatch(/They cannot rejoin by themselves: only an invitation from you or a moderator brings them back\./);
  });
});
