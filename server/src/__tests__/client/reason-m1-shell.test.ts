// server/src/__tests__/client/reason-m1-shell.test.ts
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

// Working-tree files are CRLF on Windows; normalise so patterns match either way.
const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../../client/src', rel), 'utf8').replace(/\r\n/g, '\n');

describe('REASON shell (milestone 1)', () => {
  it('desktop navigation follows the prototype order, less the Introductions tab the client asked to drop (19 Oct)', () => {
    const labels = [...read('features/reason/shell/nav.ts').matchAll(/label: '([^']+)'/g)].map(m => m[1]);
    expect(labels).toEqual(['For You', 'People', 'Entities', 'Circles', 'Pods', 'Events', 'Messages', 'Profile', 'Settings', 'Support']);
  });
  it('the phone bar is For You, People, Events, Messages and More; More holds the rest', () => {
    const nav = read('features/reason/shell/nav.ts');
    expect(nav).toMatch(/MOBILE_PRIMARY[^=]*=\s*\['foryou', 'people', 'events', 'messages'\]/);
    expect(nav).toMatch(/MOBILE_MORE[^=]*=\s*\['entities', 'circles', 'pods', 'settings', 'support'\]/);
  });
  // nav.ts, run: the lists and the lookup as the sidebar, the rail, the phone bar and the More sheet read them.
  describe('without the Introductions tab (19 Oct)', () => {
    const loadNav = () => {
      const source = fs.readFileSync(path.join(__dirname, '../../../../client/src/features/reason/shell/nav.ts'), 'utf8');
      const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } });
      const mod: { exports: Record<string, unknown> } = { exports: {} };
      new Function('module', 'exports', 'require', outputText)(mod, mod.exports, require);
      return mod.exports as {
        MAIN_NAV: Array<{ key: string; match: (p: string) => boolean }>;
        SUB_NAV: Array<{ key: string; match: (p: string) => boolean }>;
        NAV_BY_KEY: Record<string, { match: (p: string) => boolean } | undefined>;
        MOBILE_PRIMARY: string[];
        MOBILE_MORE: string[];
      };
    };

    it('is in neither list, has no entry in the lookup, and no path marks anything as current', () => {
      const nav = loadNav();
      expect(nav.MAIN_NAV.map((i) => i.key)).toEqual(['foryou', 'people', 'entities', 'circles', 'pods', 'events', 'messages']);
      expect(nav.MOBILE_MORE).toEqual(['entities', 'circles', 'pods', 'settings', 'support']);
      expect(nav.NAV_BY_KEY.introductions).toBeUndefined();
      for (const url of ['/introductions', '/introductions/anything']) {
        expect({ url, current: [...nav.MAIN_NAV, ...nav.SUB_NAV].filter((i) => i.match(url)).map((i) => i.key) }).toEqual({ url, current: [] });
      }
    });
    // Final review, 21 Oct 2026 (C8): the profile form at /profile/edit left no entry current.
    it('Profile is the current entry on Your profile and on the profile form under it, and on nothing else', () => {
      const profile = loadNav().SUB_NAV.find((i) => i.key === 'profile')!;
      for (const url of ['/profile', '/profile/edit']) expect({ url, current: profile.match(url) }).toEqual({ url, current: true });
      for (const url of ['/', '/profiles', '/profile-edit', '/people/u1', '/settings']) expect({ url, current: profile.match(url) }).toEqual({ url, current: false });
    });
    it('the phone bar\'s More, the More sheet\'s profile link and the account menu\'s View profile follow the same rule', () => {
      const bar = read('features/reason/shell/MobileNav.tsx');
      const menu = read('features/reason/shell/ProfileMenu.tsx');
      expect(bar).toMatch(/const moreActive = [^;]*NAV_BY_KEY\.profile\.match\(pathname\)[^;]*;/);
      expect(bar).toMatch(/<Link to="\/profile" onClick=\{done\} aria-current=\{NAV_BY_KEY\.profile\.match\(pathname\) \? 'page' : undefined\}/);
      expect(menu).toMatch(/<MenuLink to="\/profile" label="View profile" current=\{NAV_BY_KEY\.profile\.match\(pathname\)\}/);
      for (const src of [bar, menu]) expect(src).not.toMatch(/pathname === '\/profile'/);
    });
    it('every key the phone bar and the More sheet draw has an entry to draw it from (a key with none crashes the phone bar)', () => {
      const nav = loadNav();
      for (const key of [...nav.MOBILE_PRIMARY, ...nav.MOBILE_MORE]) expect({ key, entry: typeof nav.NAV_BY_KEY[key]?.match }).toEqual({ key, entry: 'function' });
    });
    it('is not a navigation key either, so the compiler refuses any list that names it (its icon may stay in the icon set)', () => {
      expect(read('features/reason/shell/nav.ts')).toMatch(/export type NavKey = Exclude<ReasonIconName, 'more' \| 'introductions'>;/);
    });
    // Introductions went (Task 4) and Entities became a real page (Task 11), so the coming-soon page had nothing left
    // to show and is gone, with every route and import of it.
    it('the coming-soon page is gone: nothing in the app imports or routes to it', () => {
      expect(fs.existsSync(path.join(__dirname, '../../../../client/src/features/reason/shell/ComingSoonPage.tsx'))).toBe(false);
      expect(read('App.tsx')).not.toMatch(/ComingSoonPage/);
    });
  });
  it('the tablet rail keeps its icons (the prototype hid them) and names each one', () => {
    const side = read('features/reason/shell/ShellSidebar.tsx');
    // Named by its label. The Messages link adds its unread count to that name (pinned below).
    expect(side).toMatch(/aria-label=\{[^}]*item\.label[^}]*\}/);
    expect(side).toMatch(/<span className="hidden min-\[981px\]:inline">\{item\.label\}<\/span>/);
    expect(side).not.toMatch(/<ReasonIcon[^>]*hidden/);
  });
  it('fixed bars respect iPhone safe areas; phone tabs are at least 44px', () => {
    expect(read('features/reason/shell/MobileNav.tsx')).toMatch(/env\(safe-area-inset-bottom\)/);
    expect(read('features/reason/shell/MobileNav.tsx')).toMatch(/min-h-\[56px\]/);
    expect(read('features/reason/shell/ShellTopbar.tsx')).toMatch(/env\(safe-area-inset-top\)/);
  });
  it('People opens on Your connections, then keeps every existing people page one tap away (19 Oct: "show the user\'s own connections first")', () => {
    const tabs = read('features/reason/shell/PeopleTabs.tsx');
    const order = [...tabs.matchAll(/\{ to: '([^']+)', label: '([^']+)' \}/g)].map((m) => [m[1], m[2]]);
    expect(order).toEqual([
      ['/connections', 'Your connections'],
      ['/search', 'Find people'],
      ['/agents', 'Your searches'],
      ['/matches', 'Everyone who fits'],
      ['/encounters', 'People you have met'],
    ]);
    expect(read('features/reason/shell/ReasonShell.tsx')).toMatch(/\{inPeople && <PeopleTabs \/>\}/);
  });
  it('the shell keeps the old layout\'s "Complete your profile" nudge', () => {
    const shell = read('features/reason/shell/ReasonShell.tsx');
    expect(shell).toMatch(/onboardingCompleted === false/);
    expect(shell).toMatch(/Complete your profile/);
    expect(shell).toMatch(/to="\/onboarding"/);
  });
  it('App uses the new shell, For You at /, a full-screen Human Profile, and the Entities pages', () => {
    const app = read('App.tsx');
    expect(app).toMatch(/<ProtectedRoute><ReasonShell \/><\/ProtectedRoute>/);
    expect(app).toMatch(/<Route path="\/" element=\{<ForYouPage \/>\} \/>/);
    expect(app).toMatch(/path="\/people\/:userId"/);
    // Entities is a real page now (21 Oct 2026); its profile is full screen, like the Human Profile.
    expect(app).toMatch(/<Route path="\/entities" element=\{<EntitiesPage \/>\} \/>/);
    expect(app).toMatch(/<Route path="\/entities\/:entityId" element=\{<ProtectedRoute><><EntityProfilePage \/><ToastContainer \/><\/><\/ProtectedRoute>\} \/>/);
    expect(app).not.toMatch(/kind="entities"/);
  });
  it('the old /introductions address sends a member to For You, with no page left behind it (a bookmark or an old link must not land on a 404)', () => {
    const app = read('App.tsx');
    expect(app).toMatch(/<Route path="\/introductions" element=\{<Navigate to="\/" replace \/>\} \/>/);
    expect(app).not.toMatch(/kind="introductions"/);
    // The route stays inside the signed-in group: someone who is signed out is asked to sign in, and then lands on For You.
    const shellRoutes = app.slice(app.indexOf('<ReasonShell />'), app.indexOf('{/* Protected without layout'));
    expect(shellRoutes).toContain('path="/introductions"');
  });
});

// Found by running the shell (390 and 360 wide, then 768 to 1920) and not by reading it.
describe('REASON shell: faults found by looking at it', () => {
  it('the phone bar sits under every dialog the old pages open (Modal is z-50, the tour z-60)', () => {
    const bar = read('features/reason/shell/MobileNav.tsx');
    const z = bar.match(/fixed inset-x-0 bottom-0 z-(\d+)\b/);
    expect(z).not.toBeNull();
    expect(Number(z![1])).toBeLessThan(50);
  });
  it('the page area scrolls, not the window, as in the old layout', () => {
    const shell = read('features/reason/shell/ReasonShell.tsx');
    expect(shell).toMatch(/h-\[100dvh\]/);
    expect(shell).toMatch(/<main ref=\{main\} className="min-h-0 flex-1 overflow-y-auto/);
    // A sticky top bar would hide the Admin bulk bars, which stick to the top of <main>.
    expect(read('features/reason/shell/ShellTopbar.tsx')).not.toMatch(/\bsticky\b/);
  });
  it('<main> is the scroll area, so it is what keeps its place between pages: a new page opens at its top, Back returns to the place the member left, and a ?tab= or ?q= change is the same page (CON-01)', () => {
    const shell = read('features/reason/shell/ReasonShell.tsx');
    expect(shell).toMatch(/import \{ useRef \} from 'react';/);
    expect(shell).toMatch(/const main = useRef<HTMLElement>\(null\);/);
    expect(shell).toMatch(/useMainScrollMemory\(main\);/);
    // The path is still what the nav reads; the scroll no longer waits on it alone, or on every location.
    expect(shell).toMatch(/const \{ pathname \} = useLocation\(\);/);
    expect(shell).not.toMatch(/scrollTo\(/);
    // Before paint (no frame is drawn mid-list), instant (the app scrolls smoothly), and the rules are run in
    // reason-m1-scroll-memory.test.ts: top for a new path, the saved place for Back, no jump for a search-only change.
    const hook = read('features/reason/shell/useMainScrollMemory.ts');
    expect(hook).toMatch(/useLayoutEffect\(/);
    expect(read('features/reason/shell/scroll-memory.ts')).toMatch(/behavior: 'instant'/);
    expect(hook).toMatch(/scrollTo\(\{ top: 0, left: 0, behavior: 'instant' \}\)/);
  });
  it('the rail scrolls on a short window, so the account block stays on screen', () => {
    const side = read('features/reason/shell/ShellSidebar.tsx');
    expect(side).toMatch(/<div className="[^"]*min-h-0 flex-1[^"]*overflow-y-auto[^"]*">\s*<nav className="[^"]*" aria-label="Main">/);
  });
  it('an iPhone on its side: the rail, the top bar and the page area keep clear of the notch', () => {
    expect(read('features/reason/shell/ShellSidebar.tsx')).toMatch(/w-\[calc\(82px\+env\(safe-area-inset-left\)\)\]/);
    expect(read('features/reason/shell/ShellSidebar.tsx')).toMatch(/pl-\[calc\(14px\+env\(safe-area-inset-left\)\)\]/);
    // ...and its account button stays out of the home-indicator zone at the bottom.
    expect(read('features/reason/shell/ShellSidebar.tsx')).toMatch(/pb-\[calc\(14px\+env\(safe-area-inset-bottom\)\)\]/);
    const shell = read('features/reason/shell/ReasonShell.tsx');
    expect(shell).toMatch(/min-\[721px\]:pl-\[calc\(82px\+env\(safe-area-inset-left\)\)\]/);
    expect(shell).toMatch(/pr-\[max\(13px,env\(safe-area-inset-right\)\)\]/);
    expect(read('features/reason/shell/ShellTopbar.tsx')).toMatch(/pr-\[max\(12px,env\(safe-area-inset-right\)\)\]/);
  });
  it('Admin pages keep the old layout section links (Support tickets were linked from nowhere else)', () => {
    const tabs = read('features/reason/shell/AdminTabs.tsx');
    for (const to of ['/admin', '/admin/users', '/admin/pods', '/admin/sessions', '/admin/join-requests', '/admin/moderation', '/admin/templates', '/admin/email', '/admin/support']) {
      expect(tabs).toContain(`to: '${to}'`);
    }
    expect(read('features/reason/shell/ReasonShell.tsx')).toMatch(/\{inAdmin && <AdminTabs \/>\}/);
    expect(read('features/reason/shell/ReasonShell.tsx')).toMatch(/isAdmin\(user\?\.role\)/);
  });
  it('the profile nudge sits between the top bar and the page area, outside <main> (Messages sizes itself to <main>, so anything else in it pushes the composer off screen)', () => {
    const shell = read('features/reason/shell/ReasonShell.tsx');
    const topbar = shell.indexOf('<ShellTopbar />');
    const nudge = shell.indexOf('{nudgeProfile && (');
    const main = shell.indexOf('<main ');
    expect(topbar).toBeGreaterThan(-1);
    expect(nudge).toBeGreaterThan(topbar);
    expect(main).toBeGreaterThan(nudge);
    // Nothing between the two <main> tags may be the nudge.
    expect(shell.slice(main, shell.indexOf('</main>'))).not.toMatch(/nudgeProfile|Complete your profile/);
  });
  it('the nudge is left off Messages and everything under it (pinned above it, it pushes the message box under the phone bar on a window about 640px tall)', () => {
    const shell = read('features/reason/shell/ReasonShell.tsx');
    expect(shell).toMatch(/const inMessages = NAV_BY_KEY\.messages\.match\(pathname\)/);
    expect(shell).toMatch(/const nudgeProfile = [^;]*onboardingCompleted === false[^;]*pathname !== '\/'[^;]*&& !inMessages;/);
    // The Messages entry covers /messages and every route under it (a thread, a new message, ?poke=).
    expect(read('features/reason/shell/nav.ts')).toMatch(/key: 'messages'[^}]*match: under\('\/messages'\)/);
  });
  it('Invite and Admin pages mark More (phone) and the account button (rail, sidebar) as current, and More says whether it is open', () => {
    expect(read('features/reason/shell/nav.ts')).toMatch(/export const isAccountPage = \(path: string\) => onInvites\(path\) \|\| onAdmin\(path\)/);
    const bar = read('features/reason/shell/MobileNav.tsx');
    expect(bar).toMatch(/const moreActive = [^;]*isAccountPage\(pathname\)/);
    expect(bar).toMatch(/aria-expanded=\{moreOpen\}/);
    expect(bar).toMatch(/aria-current=\{moreActive \? 'true' : undefined\}/);
    expect(read('features/reason/shell/ProfileMenu.tsx')).toMatch(/aria-current=\{isAccountPage\(pathname\) \? 'true' : undefined\}/);
  });
  it('the Messages link keeps its unread count in its accessible name, as the old sidebar did', () => {
    // 26 Oct 2026: a link's badge carries its own name (Events names its upcoming meetings, meetings-ui.test.ts).
    const side = read('features/reason/shell/ShellSidebar.tsx');
    expect(side).toMatch(/aria-label=\{badge\?\.name \?\? item\.label\}/);
    expect(side).toMatch(/if \(item\.key === 'messages'\) return \{ count: unreadCount, name: unreadCount \? `\$\{item\.label\}, \$\{unreadCount\} unread` : item\.label \};/);
    expect(read('features/reason/shell/MobileNav.tsx')).toMatch(/`\$\{item\.label\}, \$\{unreadCount\} unread`/);
  });
  it('the current tab is brought into view inside the tab rows (not by moving the page), and again once the font has loaded', () => {
    const hook = read('features/reason/shell/useRevealActive.ts').replace(/^\s*\/\/.*$/gm, '');
    expect(hook).toMatch(/\[aria-current="page"\]/);
    expect(hook).toMatch(/strip\.scrollTo\(/);
    expect(hook).not.toMatch(/scrollIntoView/);
    expect(hook).toMatch(/document\.fonts\.addEventListener\('loadingdone'/);
    expect(read('features/reason/shell/PeopleTabs.tsx')).toMatch(/useRevealActive\(row\)/);
    expect(read('features/reason/shell/AdminTabs.tsx')).toMatch(/useRevealActive\(row\)/);
  });
  it('the account menu closes on Escape and on a tap outside it', () => {
    const menu = read('features/reason/shell/ProfileMenu.tsx');
    expect(menu).toMatch(/e\.key !== 'Escape'/);
    expect(menu).toMatch(/addEventListener\('pointerdown'/);
  });
  it('the account menu is a plain disclosure of links and a button: aria-expanded on its trigger, and no menu roles (they promise arrow-key support that nothing here has)', () => {
    const menu = read('features/reason/shell/ProfileMenu.tsx');
    expect(menu).toMatch(/aria-expanded=\{open\}/);
    expect(menu).not.toMatch(/role="menu"|role="menuitem"|aria-haspopup/);
    // What is inside is real links and a real button, so Tab and Enter already do everything a member expects.
    expect(menu).toMatch(/<Link\b/);
    expect(menu).toMatch(/<button\s+type="button"\s+onClick=\{\(\) => \{ close\(\); setConfirm\(true\); \}\}/);
  });
  it('the current page is announced the way it is drawn (the rail and the phone bar)', () => {
    expect(read('features/reason/shell/ShellSidebar.tsx')).toMatch(/aria-current=\{active \? 'page' : undefined\}/);
    expect(read('features/reason/shell/MobileNav.tsx')).toMatch(/aria-current=\{active \? 'page' : undefined\}/);
  });
  it('the More sheet adds no home-bar inset of its own (the Sheet owns it: a second one doubled it), the fixed bar keeps its own', () => {
    const nav = read('features/reason/shell/MobileNav.tsx');
    const sheet = nav.slice(nav.indexOf('<Sheet open={moreOpen}'), nav.indexOf('</Sheet>'));
    expect(sheet.length).toBeGreaterThan(0);
    expect(sheet).not.toMatch(/safe-area-inset/);
    expect(nav).toMatch(/pb-\[calc\(6px\+env\(safe-area-inset-bottom\)\)\]/);
  });
  it('the top search opens Find people with the words already in', () => {
    expect(read('features/reason/shell/ShellTopbar.tsx')).toMatch(/navigate\(`\/search\?q=\$\{encodeURIComponent\(term\)\}`\)/);
    const search = read('features/search/SearchPage.tsx');
    expect(search).toMatch(/import \{ Link, useSearchParams \} from 'react-router-dom'/);
    expect(search).toMatch(/const urlQuery = searchParams\.get\('q'\) \?\? ''/);
    expect(search).toMatch(/useState\(urlQuery\)/);
    // A new ?q= from outside is followed (CON-01: the page now writes ?q= itself, and must not follow its own write).
    expect(search).toMatch(/useEffect\(\(\) => \{\s*if \(urlQuery === written\.current\) return;\s*written\.current = urlQuery;\s*setQ\(urlQuery\);\s*\}, \[urlQuery\]\)/);
  });
  it('preview builds report to Sentry as "preview", not "production"', () => {
    const sentry = read('lib/sentry.ts');
    expect(sentry).toMatch(/host\.startsWith\('preview\.'\) \|\| host\.includes\('-git-'\)/);
    expect(sentry).toMatch(/environment: sentryEnvironment\(\)/);
    expect(sentry).not.toMatch(/environment: import\.meta\.env\.MODE/);
  });
});

// Left open by the reviews of the shell and Messages, closed before a client looks at it (task P2).
describe('REASON shell and Messages: fixes before a client reviews it (P2)', () => {
  it('Messages hides the inbox list on a phone while a new message is written, as for an open thread or group chat (stacked above the compose panel it pushed the message box under the bottom bar)', () => {
    const page = read('features/messages/MessagesPage.tsx');
    // The thread pane shows for a conversation, a new message, and (26 Oct 2026, C12) a group chat.
    expect(page).toMatch(/const threadShown = !!activeId \|\| isComposeMode \|\| !!groupId;/);
    // The list pane (lg:w-80) is hidden below lg whenever the thread pane is showing...
    expect(page).toMatch(/lg:w-80 lg:flex-shrink-0[^`]*\$\{threadShown \? 'hidden lg:flex' : 'flex'\}/);
    // ...and the thread pane shows itself on exactly that condition, so the two can never both stack on a phone.
    expect(page).toMatch(/flex-1 bg-white rounded-xl border border-gray-200 overflow-hidden \$\{threadShown \? 'flex' : 'hidden lg:flex'\}/);
  });
  it('the compose panel keeps a Back to inbox while it waits for the person to load, since the list beside it is gone on a phone', () => {
    const page = read('features/messages/MessagesPage.tsx');
    expect(page).toMatch(/composeToUserId \? \(\s*<>[\s\S]*?lg:hidden[\s\S]*?navigate\('\/messages'\)[\s\S]*?aria-label="Back to inbox"[\s\S]*?<Spinner \/><\/div>\s*<\/>\s*\) : \(focusPokeId/);
    // The thread header's own arrow is still there for a loaded thread or person.
    expect(page).toMatch(/className="lg:hidden -ml-2 flex h-11 w-11[^"]*"\s*aria-label="Back to inbox"/);
  });

  // Measured with WCAG relative luminance: the brand red #DE322E on the pink #fff1ef is 4.15:1, the darker
  // red #C52B28 is 5.09:1 (small text needs 4.5:1). The brand red stays on borders, the 3px marker, icons
  // and white-on-red buttons, where it is not text on pink.
  const SHELL_WITH_PINK = ['AdminTabs', 'MobileNav', 'PeopleTabs', 'ProfileMenu', 'ShellSidebar'];
  it('the current item\'s label is the darker red on its pink (4.5:1), in every place the shell draws one', () => {
    let onPink = 0;
    const brandRedOnPink: string[] = [];
    // Every string literal, in all three forms: 'single' (constants and cn() arguments), "double" (JSX attributes) and
    // `template` (which can hold ${...} between the classes).
    const STRING_LITERALS = /'[^'\n]*'|"[^"\n]*"|`[^`]*`/g;
    for (const file of SHELL_WITH_PINK) {
      const literals = (read(`features/reason/shell/${file}.tsx`).match(STRING_LITERALS) ?? []).filter((l) => /\bbg-reason-pink\b/.test(l));
      for (const literal of literals) {
        if (/\btext-reason-red(?!-)/.test(literal)) brandRedOnPink.push(`${file}: ${literal}`);
        if (/\btext-reason-red-hover\b/.test(literal)) onPink++;
      }
    }
    expect(brandRedOnPink).toEqual([]);
    // AdminTabs 1, MobileNav 4 (bar tab, More, More tile, account link), PeopleTabs 1, ProfileMenu 1, ShellSidebar 1.
    expect(onPink).toBeGreaterThanOrEqual(8);
  });
  it('the icon of the current item keeps the brand red (it is not text), though its label is the darker red', () => {
    expect(read('features/reason/shell/ShellSidebar.tsx')).toMatch(/<ReasonIcon name=\{item\.key\} className=\{cn\('shrink-0', active && 'text-reason-red'\)\} \/>/);
    const nav = read('features/reason/shell/MobileNav.tsx');
    expect(nav).toMatch(/<ReasonIcon name=\{key\} className=\{active \? 'text-reason-red' : undefined\} \/>/);
    expect(nav).toMatch(/<ReasonIcon name="more" className=\{moreActive \? 'text-reason-red' : undefined\} \/>/);
    expect(nav).toMatch(/<ReasonIcon name=\{key\} width=\{20\} height=\{20\} className=\{active \? 'text-reason-red' : undefined\} \/>/);
    // ...and so does the 3px marker on the rail and the sidebar.
    expect(read('features/reason/shell/ShellSidebar.tsx')).toMatch(/shadow-\[inset_3px_0_0_#DE322E\]/);
  });
  it('small grey text in the shell clears 4.5:1 on the surface it sits on: "View profile" (pink when current, soft under the pointer), Log out under the pointer, the search placeholder', () => {
    const menu = read('features/reason/shell/ProfileMenu.tsx');
    // #646a77 is 4.93:1 on the pink, 5.07:1 on the soft grey and 5.43:1 on white; the muted #6d7380 was 4.32 and 4.44 on the first two.
    expect(menu).toMatch(/<span className="block text-\[11px\] text-\[#646a77\]">View profile<\/span>/);
    // Log out is the brand red on white (4.56:1) and the darker red on the soft grey it gets under the pointer (4.26:1 before).
    expect(menu).toMatch(/text-\[14px\] text-reason-red hover:bg-reason-soft hover:text-reason-red-hover/);
    // The placeholder defaulted to gray-400 (2.33:1 on the search field's #f4f5f7).
    expect(read('features/reason/shell/ShellTopbar.tsx')).toMatch(/bg-\[#f4f5f7\][^"]*\bplaceholder:text-\[#646a77\]/);
  });

  // Old pages inside <main> scrolled sideways on a phone. Measured as main.scrollWidth - main.clientWidth at 360 and 390.
  it('a list of cards that hold a truncated title or name is a one-column grid, not an auto track (an auto track grows to the longest truncated line, and the page scrolls sideways on a phone)', () => {
    // Circle detail: events (a truncated title beside a date that never wraps) and members. +53px at a 360px window for a 33-character title.
    const circle = read('features/circles/CircleDetailPage.tsx');
    expect(circle).toMatch(/<div className="grid grid-cols-1 gap-2">\s*\{circle\.upcomingEvents\.map/);
    expect(circle).toMatch(/<div className="grid grid-cols-1 gap-2">\s*\{circle\.members\.map/);
    // Pod detail: the member list, whose ProfileCard truncates the job title (+360px at a 360px window for a long one).
    expect(read('features/pods/PodDetailPage.tsx')).toMatch(/<div className="grid grid-cols-1 gap-2">\s*\{\(memberStatusFilter === null \? activeMembers/);
    // Event page: the participant list (8px at 360 in WebKit).
    expect(read('features/sessions/SessionDetailPage.tsx')).toMatch(/<div className="grid grid-cols-1 gap-2">\s*\{\/\* Host\/Director card/);
  });
  it('People you have met wraps the badges and the Message button under the name on a phone and from 1024px (two cards to a row, each as narrow as a phone\'s), and lets a long name break there; from 721px to 1023px it is the old one-line row', () => {
    // +43px at a 360px window: the avatar, the name, the badges and the button could not fit one line and held the card (and the page) wider.
    // The phone range is the shell's own: its bar is min-[721px]:hidden, so max-[720px] is exactly where the bar shows.
    expect(read('features/reason/shell/MobileNav.tsx')).toMatch(/min-\[721px\]:hidden/);
    // Exactly these classes. An unscoped flex-wrap or gap moved the Message button to a second line at 768px, where the
    // old row shrank the text instead. The name is a page link to the Human Profile (21 Oct), so Back returns here.
    expect(read('features/sessions/EncounterHistoryPage.tsx')).toMatch(
      /<div className="flex items-center justify-between max-\[720px\]:flex-wrap max-\[720px\]:gap-x-3 max-\[720px\]:gap-y-2 min-\[1024px\]:flex-wrap min-\[1024px\]:gap-x-3 min-\[1024px\]:gap-y-2">\s*<Link to=\{`\/people\/\$\{e\.otherUserId\}\?from=People`\} className="flex items-center gap-3 hover:opacity-80 transition-opacity max-\[720px\]:\[overflow-wrap:anywhere\] min-\[1024px\]:\[overflow-wrap:anywhere\]"/,
    );
    // Two to a row from 1024px, one list below.
    expect(read('features/sessions/EncounterHistoryPage.tsx')).toMatch(/<div className="grid gap-3 animate-fade-in-up stagger-1 min-\[1024px\]:grid-cols-2">/);
  });
  // Entities has its own search box on its own page (21 Oct 2026); the top search still searches people only.
  it('the top search says it searches people, and its accessible name matches: it opens Find people, and searches nothing else', () => {
    const top = read('features/reason/shell/ShellTopbar.tsx');
    expect(top).toMatch(/aria-label="Search people"/);
    expect(top).toMatch(/placeholder="Search people…"/);
    // The old placeholder promised entities, circles, pods and events (and was cut off on a 360px phone); the old name was "Search REASON".
    expect(top).not.toMatch(/entities, circles, pods or events/);
    expect(top).not.toMatch(/Search REASON/);
    // ...because the submit still goes to Find people only.
    expect(top).toMatch(/navigate\(`\/search\?q=\$\{encodeURIComponent\(term\)\}`\)/);
  });
  it('a long unbroken author name on the circle wall and the pod wall (one set of components) breaks instead of widening the page, on a post and on a comment', () => {
    expect(read('components/wall/WallPostCard.tsx')).toMatch(/<p className="min-w-0 break-words text-sm font-semibold text-gray-900">\{p\.authorName \|\| 'Member'\}<\/p>/);
    expect(read('components/wall/WallComments.tsx')).toMatch(/<p className="break-words text-xs font-semibold text-gray-700">\s*\{c\.authorName \|\| 'Member'\}/);
  });
});

// Your connections (21 Oct 2026): the People entry opens the member's own connections, its first tab, and stays
// marked on every People page. nav.ts is run, as the sidebar, the rail and the phone bar read it.
describe('REASON shell: People opens Your connections', () => {
  const loadNav = () => {
    const source = fs.readFileSync(path.join(__dirname, '../../../../client/src/features/reason/shell/nav.ts'), 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } });
    const mod: { exports: Record<string, unknown> } = { exports: {} };
    new Function('module', 'exports', 'require', outputText)(mod, mod.exports, require);
    return mod.exports as { MAIN_NAV: Array<{ key: string; to: string; match: (p: string) => boolean }> };
  };

  it('the People entry goes to /connections', () => {
    expect(loadNav().MAIN_NAV.find((i) => i.key === 'people')?.to).toBe('/connections');
  });

  it('People is the current entry on all five tabs, a page under them and a Human Profile, and on nothing else', () => {
    const people = loadNav().MAIN_NAV.find((i) => i.key === 'people')!;
    for (const url of ['/connections', '/search', '/agents', '/agents/a1', '/matches', '/encounters', '/people/u1']) {
      expect({ url, current: people.match(url) }).toEqual({ url, current: true });
    }
    for (const url of ['/', '/circles', '/messages', '/connectionsx', '/searching']) {
      expect({ url, current: people.match(url) }).toEqual({ url, current: false });
    }
    // Every People tab is an address the People entry is current on.
    const tabs = [...read('features/reason/shell/PeopleTabs.tsx').matchAll(/\{ to: '([^']+)'/g)].map((m) => m[1]);
    expect(tabs).toHaveLength(5);
    for (const to of tabs) expect({ to, current: people.match(to) }).toEqual({ to, current: true });
  });

  it('App routes /connections to Your connections inside the shell, so the tabs and the navigation are there', () => {
    const app = read('App.tsx');
    expect(app).toMatch(/^import ConnectionsPage from '@\/features\/reason\/people\/ConnectionsPage';$/m);
    const shellRoutes = app.slice(app.indexOf('<ReasonShell />'), app.indexOf('{/* Protected without layout'));
    expect(shellRoutes).toContain('<Route path="/connections" element={<ConnectionsPage />} />');
  });

  it('on a tablet and up the five tabs wrap instead of running off the side; on a phone the row scrolls', () => {
    const tabs = read('features/reason/shell/PeopleTabs.tsx');
    expect(tabs).toMatch(/aria-label="People" className="[^"]*\boverflow-x-auto\b[^"]*\bmin-\[721px\]:flex-wrap\b/);
  });
});
