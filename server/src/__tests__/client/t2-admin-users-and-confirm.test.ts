// ─── The admin Users page answers, every "are you sure?" is asked in the page, and former members (T2, 1 Nov 2026) ─
//
// 30 Oct review: "Admin dashboard buttons don't respond … Removing users doesn't work. Users that were removed still
// show up." Stefan pressed Remove twice on each of two accounts: the Active tab sent no status (it listed everyone),
// a removed row stayed where it was, and no action said anything when it failed. A browser that has stopped showing
// dialogs answers window.confirm() with false at once, so a press behind one did nothing at all.
//
// The pure parts (the tabs, what each action says, the role menu) run here; the wiring is pinned by its source.

import * as fs from 'fs';
import * as path from 'path';
import {
  ACTION_LABEL, RESULT_STATUS, STATUS_TABS, actionCopy, actionsFor, bulkCopy, failureText, roleChoices, roleIsEditable,
} from '../../../../client/src/features/admin/users/user-status';

const CLIENT = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(CLIENT, rel), 'utf8').replace(/\r\n/g, '\n');

/** Every client source file, with comments taken out (a comment may name window.confirm; a call may not). */
function sources(dir = CLIENT): Array<{ file: string; code: string }> {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sources(full);
    if (!/\.(ts|tsx)$/.test(e.name)) return [];
    const code = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    return [{ file: path.relative(CLIENT, full), code }];
  });
}

describe('no window.confirm anywhere in the client', () => {
  it('every question is a ConfirmDialog in the page', () => {
    const calls = sources().filter(({ code }) => /(^|[^\w.])(window\.)?confirm\s*\(/m.test(code)).map(({ file }) => file);
    expect(calls).toEqual([]);
  });

  it('ConfirmDialog has the shared props, portals through Sheet, and stays open while busy', () => {
    const dialog = read('components/ui/ConfirmDialog.tsx');
    expect(dialog).toMatch(/open: boolean;\s*title: string;\s*body: string;\s*confirmLabel: string;\s*tone: 'danger' \| 'default';\s*onConfirm: \(\) => void;\s*onCancel: \(\) => void;\s*busy\?: boolean;/);
    expect(dialog).toMatch(/import Sheet from '@\/features\/reason\/ui\/Sheet';/);
    expect(read('features/reason/ui/Sheet.tsx')).toMatch(/createPortal\(/);
    expect(dialog).toMatch(/const cancel = \(\) => \{ if \(!busy\) onCancel\(\); \};/);
    expect(dialog).toMatch(/data-testid="confirm-dialog-confirm"/);
    expect(dialog.match(/min-h-\[44px\]/g)?.length).toBeGreaterThanOrEqual(1);
  });

  it('useConfirm answers true only for the confirm button', () => {
    const hook = read('hooks/useConfirm.tsx');
    expect(hook).toMatch(/onConfirm=\{\(\) => settle\(true\)\}/);
    expect(hook).toMatch(/onCancel=\{\(\) => settle\(false\)\}/);
    expect(hook).toMatch(/pending\.current\?\.\(false\);/);
  });
});

describe('the admin Users page tabs', () => {
  it('are Active, Suspended, Removed and Banned, each asking for its own status', () => {
    expect(STATUS_TABS.map((t) => [t.label, t.status])).toEqual([
      ['Active', 'active'], ['Suspended', 'suspended'], ['Removed', 'deactivated'], ['Banned', 'banned'],
    ]);
    const page = read('features/admin/AdminUsersPage.tsx');
    expect(page).toMatch(/new URLSearchParams\(\{ page: String\(page\), pageSize: '20', status: tab \}\)/);
    expect(page).toMatch(/meta: \{ entities: \[E\.adminUsers\] \}/);
    expect(page).toMatch(/const counts = meta\?\.statusCounts \?\? null;/);
    expect(read('features/admin/users/UserStatusTabs.tsx')).toMatch(/\{counts \? counts\[tab\.status\] : '…'\}/);
  });

  it('offers Reactivate on Suspended, Removed and Banned, and Delete for good to a super admin only', () => {
    expect(actionsFor('active', true)).toEqual(['suspend', 'remove', 'ban']);
    expect(actionsFor('suspended', false)).toEqual(['activate', 'remove', 'ban']);
    expect(actionsFor('deactivated', false)).toEqual(['activate', 'ban']);
    expect(actionsFor('deactivated', true)).toEqual(['activate', 'ban', 'delete']);
    expect(actionsFor('banned', false)).toEqual(['activate']);
    expect(RESULT_STATUS).toEqual({ suspend: 'suspended', ban: 'banned', remove: 'deactivated', activate: 'active', delete: 'deactivated' });
    expect(ACTION_LABEL.activate).toBe('Reactivate');
  });

  it('says what each action does before, and where the person went after, in sentences', () => {
    expect(actionCopy('remove', 'Ana Silva')).toMatchObject({
      title: 'Remove Ana Silva?', confirmLabel: 'Remove', tone: 'danger',
      done: 'Ana Silva was removed. They are under Removed now.',
    });
    expect(actionCopy('remove', 'Ana Silva').body).toMatch(/Former member/);
    expect(actionCopy('activate', 'Ana Silva').done).toBe('Ana Silva is active again. They are under Active now.');
    expect(actionCopy('suspend', 'Ana Silva').done).toBe('Ana Silva is suspended. They are under Suspended now.');
    expect(actionCopy('ban', 'Ana Silva').done).toBe('Ana Silva is banned. They are under Banned now.');
    expect(bulkCopy('activate', 3).done).toBe('3 people reactivated.');
    expect(bulkCopy('suspend', 1).title).toBe('Suspend 1 person?');
  });

  it('a refused or failed press says the server\'s words, else a plain sentence', () => {
    expect(failureText({ response: { data: { error: { message: 'Only super admins can assign admin roles' } } } })).toBe('Only super admins can assign admin roles');
    expect(failureText(new Error('Network Error'))).toBe('That did not go through. Please try again.');
    expect(failureText(null)).toBe('That did not go through. Please try again.');
  });

  it('never offers "Free", and an admin\'s row is a menu only for a super admin', () => {
    expect(roleChoices(false)).toEqual(['member', 'pro', 'founding_member', 'host']);
    expect(roleChoices(true)).toEqual(['member', 'pro', 'founding_member', 'host', 'admin', 'super_admin']);
    expect(roleIsEditable('admin', false)).toBe(false);
    expect(roleIsEditable('super_admin', false)).toBe(false);
    expect(roleIsEditable('member', false)).toBe(true);
    expect(roleIsEditable('admin', true)).toBe(true);
    // A role the menu does not offer (an old "free" row) shows as itself, not as the first option.
    expect(read('features/admin/users/AdminUserRow.tsx')).toMatch(/\{!choices\.includes\(u\.role\) && <option value=\{u\.role\} disabled>\{roleLabel\}<\/option>\}/);
  });

  it('runs every hook before the admin check, so a role change while it is open cannot break it', () => {
    const page = read('features/admin/AdminUsersPage.tsx');
    const check = page.indexOf('if (!admin) {');
    expect(check).toBeGreaterThan(0);
    const after = page.slice(check);
    expect(after).not.toMatch(/\buse[A-Z]\w*\(/);
  });

  it('every status change is asked in a dialog that stays busy, then toasts, and the list refetches', () => {
    const action = read('features/admin/users/useStatusAction.ts');
    expect(action).toMatch(/onSuccess: \(_res, \{ user, action \}\) => addToast\(actionCopy\(action, nameOf\(user\)\)\.done, 'success'\)/);
    expect(action).toMatch(/onError: \(err\) => addToast\(failureText\(err\), 'error'\)/);
    expect(action).toMatch(/invalidateQueries\(\{ queryKey: \['admin-users'\] \}\)/);
    const page = read('features/admin/AdminUsersPage.tsx');
    expect(page).toMatch(/<ConfirmDialog[\s\S]{0,300}busy=\{status\.busy\}/);
    const bulk = read('features/admin/users/UsersBulkBar.tsx');
    expect(bulk).toMatch(/onError: \(err\) => addToast\(failureText\(err\), 'error'\)/);
    expect(bulk).toMatch(/busy=\{mutation\.isPending\}/);
  });
});

describe('the join requests page', () => {
  it('says the Poke cooldown in words under the button, and spins only the row pressed', () => {
    const page = read('features/admin/AdminJoinRequestsPage.tsx');
    expect(page).toMatch(/`Reminded \$\{ago === 0 \? 'less than an hour' : `\$\{ago\}h`\} ago\. You can remind them again in \$\{wait\}h\.`/);
    expect(page).toMatch(/isLoading=\{pokeMutation\.isPending && pokeMutation\.variables === r\.id\}/);
    expect(page).not.toMatch(/title=\{canPoke\(r\) \?/);
  });
});

describe('a former member in an old conversation', () => {
  it('keeps the thread, links to no profile and takes no new message', () => {
    const page = read('features/messages/MessagesPage.tsx');
    expect(page).toMatch(/otherIsFormerMember\?: boolean;/);
    expect(page).toMatch(/const otherIsFormer = !!activeConv\?\.otherIsFormerMember;/);
    expect(page).toMatch(/<PersonHeaderLink to=\{`\/people\/\$\{headerContext\.otherUserId\}\?from=Messages`\} former=\{otherIsFormer\}>/);
    expect(page).toMatch(/This person is no longer a member of REASON, so they cannot get messages\./);
    expect(page).toMatch(/\{activeConv && !otherIsFormer && callsUnlocked && \(/);
  });

  it('the old profile page says the server\'s sentence when the person is gone', () => {
    expect(read('features/profile/PublicProfilePage.tsx')).toMatch(/response\?\.status === 404[\s\S]{0,200}error\?\.message \|\| 'User not found'/);
  });
});
