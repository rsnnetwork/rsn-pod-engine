// ─── Shirley pilot S3 (11 Nov 2026): the owner's Manage menu (RSN 11) and a profile's Communities (RSN 14) ──────────
// The pure rules run here (manage-menu.ts, communities-text.ts); the screens are pinned by what they must hold: who sees
// which entry, a bottom sheet on a phone and a portalled menu on a desktop, 44px taps, every query following its tags,
// the server deciding every row, and the setting in Settings > Privacy.

import * as fs from 'fs';
import * as path from 'path';
import type { ProfileCommunities, ProfileCommunity } from '@rsn/shared';
import {
  CIRCLE_HINT, EXPORT_SCREEN_ON_MAIN, MANAGE_LABEL, POD_HINT, SECTION_ID, circleManageKeys, podManageKeys,
} from '../../../../client/src/features/manage/manage-menu';
import {
  ROLE_LABEL, communitiesEntities, communitiesTitle, previewEmptyText, rowBadges, rowButton, rowToast, spaceHref,
} from '../../../../client/src/features/reason/human/communities-text';

const SRC = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

describe('the circle Manage menu: who sees which entry (circleManageKeys)', () => {
  it("the owner: every entry of the brief, in its order (Export once S7's screen is on main)", () => {
    expect(circleManageKeys({ canManage: true, isOwner: true })).toEqual(['edit', 'members', 'invitations', 'pods', 'events', 'visibility', 'moderation']);
    expect(circleManageKeys({ canManage: true, isOwner: true }, true)).toEqual(['edit', 'members', 'invitations', 'pods', 'events', 'visibility', 'moderation', 'export']);
  });
  it('a moderator who is not the owner: everything but Visibility (who can join is the owner\'s)', () => {
    expect(circleManageKeys({ canManage: true, isOwner: false })).toEqual(['edit', 'members', 'invitations', 'pods', 'events', 'moderation']);
  });
  it('a platform admin holds canManage and isOwner, so everything', () => {
    expect(circleManageKeys({ canManage: true, isOwner: true })).toContain('visibility');
  });
  it('a member, someone outside, an older server with no flags: no entry, so no Manage button', () => {
    expect(circleManageKeys({ canManage: false, isOwner: false })).toEqual([]);
    expect(circleManageKeys({})).toEqual([]);
    expect(circleManageKeys({ isOwner: true })).toEqual([]);
  });
});

describe('the pod Manage menu: who sees which entry (podManageKeys)', () => {
  const pod = { status: 'active', inCircles: true, platformAdmin: false };
  it('the director: every entry, then Duplicate and Archive', () => {
    expect(podManageKeys({ ...pod, role: 'director' })).toEqual(['edit', 'members', 'invitations', 'circles', 'events', 'visibility', 'moderation', 'duplicate', 'archive']);
    expect(podManageKeys({ ...pod, role: 'director' }, true)).toEqual(['edit', 'members', 'invitations', 'circles', 'events', 'visibility', 'moderation', 'export', 'duplicate', 'archive']);
  });
  it('a host: Members, Invitations, Events, Moderation (the edit form holds the director-only visibility)', () => {
    expect(podManageKeys({ ...pod, role: 'host' })).toEqual(['members', 'invitations', 'events', 'moderation']);
    expect(podManageKeys({ ...pod, role: 'host' }, true)).toEqual(['members', 'invitations', 'events', 'moderation', 'export']);
  });
  it('a platform admin who is not in the pod runs it as its director does', () => {
    expect(podManageKeys({ ...pod, role: null, platformAdmin: true })).toEqual(podManageKeys({ ...pod, role: 'director' }));
  });
  it('a member, or nobody: none', () => {
    expect(podManageKeys({ ...pod, role: 'member' })).toEqual([]);
    expect(podManageKeys({ ...pod, role: null })).toEqual([]);
  });
  it('Circles only while the pod is in one; nothing on an archived pod (its page offers Reactivate)', () => {
    expect(podManageKeys({ ...pod, role: 'director', inCircles: false })).not.toContain('circles');
    expect(podManageKeys({ ...pod, role: 'director', status: 'archived' })).toEqual([]);
    expect(podManageKeys({ ...pod, role: null, platformAdmin: true, status: 'archived' })).toEqual([]);
  });
  it('every entry has words; the export screen is not on main yet (the marked slot)', () => {
    expect(MANAGE_LABEL).toMatchObject({
      edit: 'Edit details', members: 'Members', invitations: 'Invitations', pods: 'Pods', events: 'Events',
      visibility: 'Visibility', moderation: 'Moderation', export: 'Export',
    });
    for (const k of circleManageKeys({ canManage: true, isOwner: true }, true)) expect(CIRCLE_HINT[k]).toBeTruthy();
    for (const k of podManageKeys({ ...pod, role: 'director' }, true)) expect(POD_HINT[k]).toBeTruthy();
    expect(EXPORT_SCREEN_ON_MAIN).toBe(false);
  });
});

describe('ManageMenu: a sheet on a phone, a menu on a desktop', () => {
  const menu = read('features/manage/ManageMenu.tsx');
  it('no entries, no button; the button is 44px and says Manage', () => {
    expect(menu).toMatch(/if \(entries\.length === 0\) return null;/);
    expect(menu).toMatch(/inline-flex min-h-\[44px\]/);
    expect(menu).toMatch(/data-testid="manage-open"/);
    expect(menu).toMatch(/aria-expanded=\{open\}/);
  });
  it('under 768px the bottom Sheet (portalled, Escape closes, focus trapped); from 768px a menu portalled to body', () => {
    expect(menu).toMatch(/useMediaQuery\('\(min-width: 768px\)'\)/);
    expect(menu).toMatch(/\{open && !wide && \(\s*<Sheet open onClose=\{\(\) => setOpen\(false\)\} title=\{title\}>/);
    expect(menu).toMatch(/import Sheet from '@\/features\/reason\/ui\/Sheet';/);
    expect(menu).toMatch(/createPortal\([\s\S]*document\.body,\s*\)/);
    expect(menu).toMatch(/if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); close\(true\); return; \}/);
    expect(menu).toMatch(/document\.addEventListener\('pointerdown', onOutside\)/);
    expect(menu).toMatch(/useEffect\(\(\) => \{ setOpen\(false\); \}, \[pathname\]\);/);
  });
  it('every entry is at least 48px and kept inside the window at 360px', () => {
    expect(menu).toMatch(/const ENTRY = 'flex min-h-\[48px\]/);
    expect(menu).toMatch(/w-\[min\(300px,calc\(100vw-16px\)\)\]/);
    expect(menu).toMatch(/Math\.max\(EDGE, Math\.min\(box\.left, window\.innerWidth - width - EDGE\)\)/);
  });
  it('an entry runs once the menu has closed (so focus going back does not undo a scroll or a new sheet)', () => {
    expect(menu).toMatch(/setOpen\(false\);\s*afterClose\(e\.onSelect\);/);
  });
});

describe('the pages use it', () => {
  it('the circle page: the Manage menu in the header row; Schedule an event, Invite, Requests and Join stay', () => {
    const page = read('features/circles/CircleDetailPage.tsx');
    expect(page).toMatch(/<CircleManageMenu circle=\{circle\} openSheet=\{setSheet\} openRequests=\{openRequests\} \/>/);
    expect(page).toMatch(/data-testid="circle-schedule-event"/);
    expect(page).toMatch(/data-testid="circle-invite"/);
    expect(page).toMatch(/data-testid="circle-requests-open"/);
    expect(page.split('\n').length).toBeLessThanOrEqual(200);
    const menu = read('features/circles/CircleManageMenu.tsx');
    expect(menu).toMatch(/members: \{ key: 'members', onSelect: \(\) => scrollToSection\(SECTION_ID\.circleMembers\) \}/);
    expect(menu).toMatch(/pods: \{ key: 'pods', onSelect: \(\) => scrollToSection\(SECTION_ID\.circlePods\) \}/);
    expect(menu).toMatch(/events: \{ key: 'events', onSelect: \(\) => navigate\(scheduleForCircleHref\(circle\.id\)\) \}/);
    expect(menu).toMatch(/moderation: \{ key: 'moderation', onSelect: openRequests/);
    expect(read('features/circles/CircleMembersSection.tsx')).toContain(`id="${SECTION_ID.circleMembers}"`);
    expect(read('features/circles/CirclePodsSection.tsx')).toContain(`id="${SECTION_ID.circlePods}"`);
  });

  it('the pod page: the Manage menu replaces Edit Pod, Duplicate Pod and Archive Pod; Archive still asks first', () => {
    const page = read('features/pods/PodDetailPage.tsx');
    expect(page).not.toMatch(/> Edit Pod<|> Duplicate Pod<|> Archive Pod</);
    expect(page).toMatch(/const myActiveRole = myMembership\?\.status === 'active' \? myMembership\.role : pod\.memberRole \?\? null;/);
    expect(page).toMatch(/inCircles: \(podCircles\?\.length \?\? 0\) > 0,/);
    expect(page).toMatch(/if \(await ask\(\{ title: 'Archive this pod\?'/);
    expect(page).toMatch(/events: \{ key: 'events', onSelect: \(\) => navigate\(`\/sessions\/new\?podId=\$\{podId\}`\) \}/);
    for (const id of [SECTION_ID.podRequests, SECTION_ID.podInvitations, SECTION_ID.podMembers, SECTION_ID.podDiscussion]) {
      expect(page).toContain(`id="${id}"`);
    }
    expect(read('features/pods/PodCircleChips.tsx')).toContain(`id="${SECTION_ID.podCircles}"`);
    // Schedule Event, Invite members and Leave stay where people look for them.
    expect(page).toMatch(/<Calendar className="h-4 w-4 mr-2" \/> Schedule Event/);
    expect(page).toMatch(/data-testid="pod-leave"/);
  });

  it("the chips and the menu share one read of the pod's circles, which follows the pod", () => {
    const chips = read('features/pods/PodCircleChips.tsx');
    expect(chips).toMatch(/export function usePodCircles\(podId: string \| undefined\)/);
    expect(chips).toMatch(/meta: \{ entities: podId \? \[E\.pod\(podId\)\] : \[\] \}/);
  });
});

const row = (o: Partial<ProfileCommunity>): ProfileCommunity => ({
  kind: 'pod', id: 'p1', name: 'Curious 12', role: 'director', access: 'approval', action: 'request', hasJoinRules: false, ...o,
});

describe("a profile's Communities: each row's words and button (communities-text)", () => {
  it('Request to join on an approval pod, Join on an open circle or pod, Requested while waiting, nothing when in it or removed', () => {
    expect(rowButton(row({}))).toEqual({ kind: 'call', label: 'Request to join', call: 'request-pod' });
    expect(rowButton(row({ kind: 'circle', access: 'open', action: 'join' }))).toEqual({ kind: 'call', label: 'Join', call: 'join-circle' });
    expect(rowButton(row({ access: 'open', action: 'join' }))).toEqual({ kind: 'call', label: 'Join', call: 'join-pod' });
    expect(rowButton(row({ action: 'pending' }))).toEqual({ kind: 'waiting', label: 'Requested' });
    expect(rowButton(row({ action: 'open' }))).toBeNull();
    expect(rowButton(row({ action: 'none', access: 'open' }))).toBeNull();
  });
  it("a pod with rules to agree to is asked on its own page, where the rules are shown", () => {
    expect(rowButton(row({ hasJoinRules: true }))).toEqual({ kind: 'link', label: 'Request to join', to: '/pods/p1' });
  });
  it('badges say the kind, and how to get in when it is not open; the role in words', () => {
    expect(rowBadges(row({}))).toEqual(['Pod', 'Approval']);
    expect(rowBadges(row({ access: 'open' }))).toEqual(['Pod']);
    expect(rowBadges(row({ access: 'members' }))).toEqual(['Pod', 'Private']);
    expect(rowBadges(row({ kind: 'circle', access: 'members' }))).toEqual(['Circle', 'Closed']);
    expect(ROLE_LABEL).toEqual({ owner: 'Owner', moderator: 'Moderator', director: 'Director', host: 'Host', member: 'Member' });
    expect(spaceHref(row({ kind: 'circle', id: 'c1' }))).toBe('/circles/c1');
    expect(communitiesTitle('Shirley', 1)).toBe('The 1 community Shirley is in.');
    expect(communitiesTitle('Shirley', 4)).toBe('The 4 communities Shirley is in.');
    expect(rowToast('request-pod', 'Curious 12')).toMatch(/request to join Curious 12 was sent/);
  });
  it('your own preview says why it is empty', () => {
    expect(previewEmptyText('setting_off')).toMatch(/turned off "Show my communities on my profile"/);
    expect(previewEmptyText('hidden_from_search')).toMatch(/hidden from search/);
    expect(previewEmptyText(null)).toMatch(/private pods and closed circles never do/);
  });
  it('the tags: your own lists and blocks, their lists and profile, and each listed space; once each', () => {
    const pages: ProfileCommunities[] = [{ items: [row({}), row({ kind: 'circle', id: 'c1' })], total: 2, nextOffset: null }];
    const tags = communitiesEntities('me', 'them', pages);
    expect(tags).toEqual([
      'user:me:circles', 'user:me:pods', 'user:me:blocks', 'user:me',
      'user:them:circles', 'user:them:pods', 'user:them',
      'pod:p1', 'pod:p1:members', 'circle:c1', 'circle:c1:members',
    ]);
    // The preview is your own: no second copy of your tags.
    expect(communitiesEntities('me', 'me', undefined)).toEqual(['user:me:circles', 'user:me:pods', 'user:me:blocks', 'user:me']);
  });
});

describe('the Communities section on a profile and in the preview', () => {
  const section = read('features/reason/human/ProfileCommunities.tsx');
  it('reads the server a page at a time and follows its tags; the server decides every row', () => {
    expect(section).toMatch(/useInfiniteQuery\(\{/);
    expect(section).toMatch(/meta: \{ entities: communitiesEntities\(me, them, loaded\) \}/);
    expect(section).toMatch(/fetchMyCommunities\(pageParam, limit\) : fetchCommunities\(props\.userId, pageParam, limit\)/);
    expect(section).toMatch(/getNextPageParam: \(last\) => last\.nextOffset \?\? undefined/);
    expect(section).toMatch(/retry: shouldRetry/);
  });
  it("another member's profile: left out when it has nothing, or on a 404; a skeleton while loading; an error with Try again", () => {
    expect(section).toMatch(/if \(items\.length === 0\) \{\s*if \(!preview\) return null;/);
    expect(section).toMatch(/if \(statusOf\(list\.error\) === 404\) return null;/);
    expect(section).toMatch(/<Skeleton /);
    expect(section).toMatch(/Try again/);
  });
  it('the preview sends nothing and says why it is empty; Show more reads the next page; buttons are 44px', () => {
    expect(section).toMatch(/if \(preview\) \{ addToast\('This is a preview\. Nothing is sent\.', 'info'\); return; \}/);
    expect(section).toMatch(/previewEmptyText\(hidden\)/);
    expect(section).toMatch(/onClick=\{\(\) => void list\.fetchNextPage\(\)\}/);
    expect(section).toMatch(/const BUTTON = cn\('min-h-\[44px\]/);
    expect(section).toMatch(/'request-pod': \(id\) => api\.post\(`\/pods\/\$\{id\}\/request-join`\)/);
    expect(section).toMatch(/'join-circle': \(id\) => api\.post\(`\/circles\/\$\{id\}\/join`\)/);
  });
  it('is on a member\'s profile and in the preview, never on the public link\'s card', () => {
    expect(read('features/reason/human/HumanProfilePage.tsx')).toMatch(/<ProfileCommunities mode="member" userId=\{userId\} first=\{who\.first\} \/>/);
    expect(read('features/reason/profile/ProfilePreviewPage.tsx')).toMatch(/<ProfileCommunities mode="preview" first=/);
    expect(read('features/reason/profile/PublicCardView.tsx')).not.toMatch(/Communit/);
    expect(read('features/reason/profile/SharedProfilePage.tsx')).not.toMatch(/Communit/);
  });
});

describe('Settings > Privacy: "Show my communities on my profile"', () => {
  const page = read('features/settings/SettingsPage.tsx');
  it('is one of the switches Save writes, on unless the server says off', () => {
    expect(page).toMatch(/const PREF_KEYS = \[[^\]]*'showCommunities'\] as const;/);
    expect(page).toMatch(/showCommunities: u\.showCommunities !== false,/);
    expect(page).toMatch(/onToggle=\{\(\) => toggle\('showCommunities'\)\}\s*label="Show my communities on my profile"/);
    expect(page).toMatch(/Private pods and closed circles are only shown to people in them with you/);
  });
});
