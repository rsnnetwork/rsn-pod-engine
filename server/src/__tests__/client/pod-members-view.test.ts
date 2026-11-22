// ─── A pod's member list (21 Nov 2026, Stefan: "ux on how we show members, is really bad") ───────────────────────
//
// On a 30-member pod he directs, the list sat in the page's 320px side column beside an empty area, every member a
// tall card with Make Host and a remove icon wrapped under the name. Now the members have the page's full width below
// the discussion and the events, in compact rows (one across on a phone, two from 768px, three from 1280px), with a
// search over name, title and company, the first 12 and "Show all", and the director's actions in a "⋯" menu.
//
// The pure parts (pod-members-view.ts) are run here; the wiring is pinned by its source.

import * as fs from 'fs';
import * as path from 'path';
import {
  MEMBERS_SHOWN_AT_FIRST, MEMBER_ACTION_LABEL, SEARCH_FROM, SEARCH_PLACEHOLDER, SHOW_FEWER,
  memberMatches, memberName, memberRoleChip, memberStatusChips, memberSubtitle, membersInStatus, noMatchSentence,
  orderByRole, podMemberActions, podMembersView, roleFor, showAllLabel,
  type PodMemberRow,
} from '../../../../client/src/features/pods/pod-members-view';

const SRC = path.join(__dirname, '../../../../client/src');
const exists = (rel: string) => fs.existsSync(path.join(SRC, rel));
// A file that is not there reads as empty, so each test that needs it fails on its own expectations.
const read = (rel: string) => (exists(rel) ? fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n') : '');

const row = (n: number, over: Partial<PodMemberRow> = {}): PodMemberRow => ({
  id: `pm-${n}`, userId: `u-${n}`, role: 'member', status: 'active', displayName: `Person ${n}`,
  jobTitle: null, company: null, avatarUrl: null, ...over,
});
const many = (count: number, over: Partial<PodMemberRow> = {}) => Array.from({ length: count }, (_, i) => row(i + 1, over));

describe('what a member row says', () => {
  it('names the member, or says Member when there is no name', () => {
    expect(memberName({ displayName: 'Ada Lovelace' })).toBe('Ada Lovelace');
    expect(memberName({ displayName: '   ' })).toBe('Member');
    expect(memberName({ displayName: null })).toBe('Member');
  });

  it('writes "title · company", either half alone, or nothing', () => {
    expect(memberSubtitle({ jobTitle: 'Founder', company: 'Acme' })).toBe('Founder · Acme');
    expect(memberSubtitle({ jobTitle: ' Founder ', company: '' })).toBe('Founder');
    expect(memberSubtitle({ jobTitle: null, company: 'Acme' })).toBe('Acme');
    expect(memberSubtitle({ jobTitle: null, company: '  ' })).toBeNull();
  });

  it('has a Director or Host chip, and none for a member', () => {
    expect(memberRoleChip('director')).toBe('Director');
    expect(memberRoleChip('host')).toBe('Host');
    expect(memberRoleChip('member')).toBeNull();
  });
});

describe('the search (name, title, company; on the page, no request)', () => {
  const ada = row(1, { displayName: 'Ada Lovelace', jobTitle: 'Head of Engineering', company: 'Analytical Engines' });
  const jose = row(2, { displayName: 'José Núñez', jobTitle: 'Designer', company: 'Studio Uno' });

  it('matches every word anywhere in the name, the job title or the company, in any case', () => {
    expect(memberMatches(ada, 'ada')).toBe(true);
    expect(memberMatches(ada, 'ENGINEERING')).toBe(true);
    expect(memberMatches(ada, 'analytical')).toBe(true);
    expect(memberMatches(ada, 'lovelace head')).toBe(true);
    expect(memberMatches(ada, 'ada designer')).toBe(false);
    expect(memberMatches(ada, 'babbage')).toBe(false);
  });

  it('finds an accented name typed without its accents, and the other way round', () => {
    expect(memberMatches(jose, 'jose nunez')).toBe(true);
    expect(memberMatches(row(3, { displayName: 'Jose' }), 'josé')).toBe(true);
  });

  it('an empty or blank search matches everyone; a member with no title or company is searched by name', () => {
    expect(memberMatches(ada, '')).toBe(true);
    expect(memberMatches(ada, '   ')).toBe(true);
    expect(memberMatches(row(4, { displayName: 'Bo', jobTitle: null, company: null }), 'bo')).toBe(true);
  });

  it('says which search found nobody, in its own words', () => {
    expect(noMatchSentence('  zed ')).toBe('No members match ‘zed’');
    expect(SEARCH_PLACEHOLDER).toBe('Search by name, title or company');
  });
});

describe('the order and the status chips', () => {
  it('puts the director first, then the hosts, then everyone else, each group as the server sent it', () => {
    const list = [row(1), row(2, { role: 'host' }), row(3), row(4, { role: 'director' }), row(5, { role: 'host' })];
    expect(orderByRole(list).map((m) => m.userId)).toEqual(['u-4', 'u-2', 'u-5', 'u-1', 'u-3']);
    expect(list.map((m) => m.userId)).toEqual(['u-1', 'u-2', 'u-3', 'u-4', 'u-5']);
  });

  it('All lists the active members; a status chip lists that status', () => {
    const list = [row(1), row(2, { status: 'invited' }), row(3, { status: 'left' }), row(4)];
    expect(membersInStatus(list, null).map((m) => m.userId)).toEqual(['u-1', 'u-4']);
    expect(membersInStatus(list, 'invited').map((m) => m.userId)).toEqual(['u-2']);
    expect(membersInStatus(list, 'declined')).toEqual([]);
  });

  it('shows All with the total and only the statuses someone is in', () => {
    expect(memberStatusChips({ active: 30 }, 30)).toEqual([
      { key: null, label: 'All', count: 30 },
      { key: 'active', label: 'Active', count: 30 },
    ]);
    expect(memberStatusChips({ active: 4, invited: 2, declined: 0, left: 1 }, 7).map((c) => `${c.label} ${c.count}`))
      .toEqual(['All 7', 'Active 4', 'Invited 2', 'Left 1']);
    expect(memberStatusChips({}, 0)).toEqual([{ key: null, label: 'All', count: 0 }]);
  });
});

describe('the first 12, then Show all and Show fewer', () => {
  it('draws the first 12 of 30 and offers "Show all 30"', () => {
    const v = podMembersView({ members: many(30), status: null, query: '', showAll: false });
    expect(MEMBERS_SHOWN_AT_FIRST).toBe(12);
    expect(v.rows).toHaveLength(12);
    expect(v).toMatchObject({ listed: 30, matched: 30, hidden: 18, canShowFewer: false, searching: false });
    expect(showAllLabel(v.matched)).toBe('Show all 30');
  });

  it('Show all draws all 30 and offers Show fewer', () => {
    const v = podMembersView({ members: many(30), status: null, query: '', showAll: true });
    expect(v.rows).toHaveLength(30);
    expect(v).toMatchObject({ hidden: 0, canShowFewer: true });
    expect(SHOW_FEWER).toBe('Show fewer');
  });

  it('a pod of 12 or fewer has neither button; a pod of 13 hides one', () => {
    for (const count of [0, 1, 12]) {
      const v = podMembersView({ members: many(count), status: null, query: '', showAll: false });
      expect(v).toMatchObject({ hidden: 0, canShowFewer: false });
      expect(podMembersView({ members: many(count), status: null, query: '', showAll: true }).canShowFewer).toBe(false);
    }
    expect(podMembersView({ members: many(13), status: null, query: '', showAll: false }).hidden).toBe(1);
  });

  it('the search runs over the whole list, not only the 12 drawn, and the cap applies to what it finds', () => {
    const list = many(30);
    list[25] = row(26, { displayName: 'Zed Late', company: 'Far Away Ltd' });
    const v = podMembersView({ members: list, status: null, query: 'far away', showAll: false });
    expect(v.rows.map((m) => m.userId)).toEqual(['u-26']);
    expect(v).toMatchObject({ listed: 30, matched: 1, hidden: 0, searching: true });
    const all = podMembersView({ members: list, status: null, query: 'person', showAll: false });
    expect(all).toMatchObject({ matched: 29, hidden: 17 });
    expect(all.rows).toHaveLength(12);
  });

  it('a search that finds nobody says matched 0 with the list still there', () => {
    const v = podMembersView({ members: many(30), status: null, query: 'nobody-here', showAll: false });
    expect(v).toMatchObject({ rows: [], listed: 30, matched: 0, searching: true });
  });

  it('the director and hosts lead the first 12 even when they joined last', () => {
    const list = [...many(20), row(99, { role: 'director' }), row(98, { role: 'host' })];
    const v = podMembersView({ members: list, status: null, query: '', showAll: false });
    expect(v.rows.slice(0, 2).map((m) => m.userId)).toEqual(['u-99', 'u-98']);
  });

  it('a search box only from SEARCH_FROM members', () => {
    expect(SEARCH_FROM).toBe(7);
  });
});

describe('the "⋯" menu of a row', () => {
  const director = { me: 'u-dir', canManage: true };

  it('the director may make a member a host, or remove them', () => {
    expect(podMemberActions(row(1), director)).toEqual(['make-host', 'remove']);
    expect(podMemberActions(row(1, { role: 'host' }), director)).toEqual(['remove-host', 'remove']);
    expect(MEMBER_ACTION_LABEL).toEqual({ 'make-host': 'Make host', 'remove-host': 'Remove host', remove: 'Remove from pod' });
    expect(roleFor('make-host')).toBe('host');
    expect(roleFor('remove-host')).toBe('member');
  });

  it('has nothing for the viewer\'s own row, nor for a host or a member who does not run the pod', () => {
    expect(podMemberActions(row(1, { userId: 'u-dir', role: 'director' }), director)).toEqual([]);
    expect(podMemberActions(row(1), { me: 'u-2', canManage: false })).toEqual([]);
    expect(podMemberActions(row(1, { userId: '' }), director)).toEqual([]);
  });

  it('never changes the director\'s role, and changes a role only for an active member', () => {
    expect(podMemberActions(row(1, { role: 'director' }), { me: 'u-admin', canManage: true })).toEqual(['remove']);
    expect(podMemberActions(row(1, { status: 'invited' }), director)).toEqual(['remove']);
  });
});

describe('the wiring (source)', () => {
  const page = read('features/pods/PodDetailPage.tsx');
  const section = read('features/pods/PodMembersSection.tsx');
  const rowSrc = read('features/pods/PodMemberRow.tsx');
  const menu = read('features/pods/PodMemberMenu.tsx');

  it('the page hands the members query, its loading and error, and its two mutations to the section', () => {
    expect(page).toMatch(/const \{ data: members, isLoading: membersLoading, isError: membersFailed, refetch: refetchMembers \} = useQuery\(\{\s*queryKey: \['pod-members', podId\]/);
    expect(page).toMatch(/<PodMembersSection\b[^>]*members=\{membersList\}[^>]*loading=\{membersLoading\}[^>]*failed=\{membersFailed\}/);
    expect(page).toMatch(/onSetRole=\{\(m, role\) => changeRoleMutation\.mutate\(\{ userId: m\.userId, role \}\)\}/);
    expect(page).not.toMatch(/memberStatusFilter/);
    expect(page).not.toMatch(/Make Host/);
  });

  it('nothing in the list writes the cache: a change shows through the members query\'s entity tags', () => {
    for (const src of [section, rowSrc, menu]) {
      expect(src).not.toMatch(/setQueryData|useQueryClient|api\./);
    }
  });

  it('the section has the status chips (director and hosts), a search, Show all / Show fewer and the no-match line', () => {
    expect(section).toMatch(/p\.canFilter && p\.counts && \(\s*<PodMemberStatusChips/);
    expect(section).toMatch(/data-testid="pod-members-search"/);
    expect(section).toMatch(/<span className="sr-only">Search members<\/span>/);
    expect(section).toMatch(/data-testid="pod-members-show-all">\{showAllLabel\(view\.matched\)\}/);
    expect(section).toMatch(/data-testid="pod-members-show-fewer">\{SHOW_FEWER\}/);
    expect(section).toMatch(/<Line testId="pod-members-no-match">\{noMatchSentence\(query\)\}<\/Line>/);
    expect(section).toMatch(/'No members yet' : 'To access pod details, please join the pod\.'/);
    expect(section).toMatch(/aria-label="Loading members"/);
    expect(section).toMatch(/We could not load the members just now\./);
  });

  it('a row links to the Human Profile, with the member badge and the role chip beside the name, and its menu outside the link', () => {
    expect(rowSrc).toMatch(/<Link to=\{personHref\(m\.userId \|\| m\.id, 'Pods'\)\}/);
    expect(rowSrc).toMatch(/<ProfileBadge badge=\{m\.profileBadge\} \/>/);
    expect(rowSrc).toMatch(/<span className="truncate[^"]*">\{name\}<\/span>/);
    expect(rowSrc).toMatch(/\{subtitle && <p className="truncate[^"]*">\{subtitle\}<\/p>\}/);
    expect(rowSrc).toMatch(/<\/Link>\s*<PodMemberMenu\b/);
  });

  it('the menu is a 44px button, portalled to <body> from 768px and a bottom sheet on a phone, closed by Escape and a tap outside', () => {
    expect(menu).toMatch(/className=\{cn\('flex h-11 w-11 /);
    expect(menu).toMatch(/aria-label=\{`More for \$\{name\}`\}/);
    expect(menu).toMatch(/aria-expanded=\{open\}/);
    expect(menu).toMatch(/createPortal\(/);
    expect(menu).toMatch(/document\.body,/);
    expect(menu).toMatch(/role="menu"/);
    expect(menu).toMatch(/<Sheet open onClose=/);
    expect(menu).toMatch(/document\.addEventListener\('pointerdown', onOutside\)/);
    expect(menu).toMatch(/if \(e\.key === 'Escape'\)/);
    expect(menu).toMatch(/ArrowDown: at \+ 1, ArrowUp: at - 1, Home: 0, End: entries\.length - 1/);
  });

  it('Remove from pod keeps the pod-remove-<id> test id and the page\'s confirmation', () => {
    expect(section).toMatch(/testId: `pod-remove-\$\{m\.userId\}`/);
    expect(section).toMatch(/testId: `pod-role-\$\{m\.userId\}`/);
    expect(page).toMatch(/const removeMember = async \(memberId: string, name: string\) => \{/);
    expect(page).toMatch(/They cannot rejoin by themselves/);
  });
});
