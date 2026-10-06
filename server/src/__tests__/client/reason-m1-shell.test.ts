// server/src/__tests__/client/reason-m1-shell.test.ts
import * as fs from 'fs';
import * as path from 'path';

// Working-tree files are CRLF on Windows; normalise so patterns match either way.
const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../../client/src', rel), 'utf8').replace(/\r\n/g, '\n');

describe('REASON shell (milestone 1)', () => {
  it('desktop navigation follows the prototype order', () => {
    const labels = [...read('features/reason/shell/nav.ts').matchAll(/label: '([^']+)'/g)].map(m => m[1]);
    expect(labels).toEqual(['For You', 'People', 'Entities', 'Circles', 'Pods', 'Events', 'Messages', 'Introductions', 'Profile', 'Settings', 'Support']);
  });
  it('the phone bar is For You, People, Events, Messages and More; More holds the rest', () => {
    const nav = read('features/reason/shell/nav.ts');
    expect(nav).toMatch(/MOBILE_PRIMARY[^=]*=\s*\['foryou', 'people', 'events', 'messages'\]/);
    expect(nav).toMatch(/MOBILE_MORE[^=]*=\s*\['entities', 'circles', 'pods', 'introductions', 'settings', 'support'\]/);
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
  it('People keeps every existing people page one tap away', () => {
    const tabs = read('features/reason/shell/PeopleTabs.tsx');
    for (const to of ['/search', '/agents', '/matches', '/encounters']) expect(tabs).toContain(`to: '${to}'`);
    expect(read('features/reason/shell/ReasonShell.tsx')).toMatch(/\{inPeople && <PeopleTabs \/>\}/);
  });
  it('the shell keeps the old layout\'s "Complete your profile" nudge', () => {
    const shell = read('features/reason/shell/ReasonShell.tsx');
    expect(shell).toMatch(/onboardingCompleted === false/);
    expect(shell).toMatch(/Complete your profile/);
    expect(shell).toMatch(/to="\/onboarding"/);
  });
  it('App uses the new shell, For You at /, a full-screen Human Profile, and the coming-soon pages', () => {
    const app = read('App.tsx');
    expect(app).toMatch(/<ProtectedRoute><ReasonShell \/><\/ProtectedRoute>/);
    expect(app).toMatch(/<Route path="\/" element=\{<ForYouPage \/>\} \/>/);
    expect(app).toMatch(/path="\/people\/:userId"/);
    expect(app).toMatch(/<ComingSoonPage kind="entities" \/>/);
    expect(app).toMatch(/<ComingSoonPage kind="introductions" \/>/);
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
    expect(shell).toMatch(/<main className="min-h-0 flex-1 overflow-y-auto/);
    // A sticky top bar would hide the Admin bulk bars, which stick to the top of <main>.
    expect(read('features/reason/shell/ShellTopbar.tsx')).not.toMatch(/\bsticky\b/);
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
    expect(read('features/reason/shell/ShellSidebar.tsx')).toMatch(/aria-label=\{badge \? `\$\{item\.label\}, \$\{badge\} unread` : item\.label\}/);
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
    expect(search).toMatch(/useEffect\(\(\) => \{ setQ\(urlQuery\); \}, \[urlQuery\]\)/);
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
  it('Messages hides the inbox list on a phone while a new message is written, as for an open thread (stacked above the compose panel it pushed the message box under the bottom bar)', () => {
    const page = read('features/messages/MessagesPage.tsx');
    // The list pane (lg:w-80) is hidden below lg whenever the thread pane is showing...
    expect(page).toMatch(/lg:w-80 lg:flex-shrink-0[^`]*\$\{\(activeId \|\| isComposeMode\) \? 'hidden lg:flex' : 'flex'\}/);
    // ...and the thread pane shows itself on exactly that condition, so the two can never both stack on a phone.
    expect(page).toMatch(/flex-1 bg-white rounded-xl border border-gray-200 overflow-hidden \$\{\(activeId \|\| isComposeMode\) \? 'flex' : 'hidden lg:flex'\}/);
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
    for (const file of SHELL_WITH_PINK) {
      const literals = read(`features/reason/shell/${file}.tsx`).match(/'[^'\n]*\bbg-reason-pink\b[^'\n]*'/g) ?? [];
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
});
