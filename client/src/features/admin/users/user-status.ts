// client/src/features/admin/users/user-status.ts
// The admin Users page's tabs and the words of each status change (T2, 1 Nov 2026). On 30 Oct Stefan removed two
// accounts twice each: the Active tab sent no status, so it listed every account, and a removed row stayed where it
// was. Each tab now asks for its own status and says how many it holds, and each action says what it does before and
// after.
import type { UserStatusCounts } from '@rsn/shared';

export type AccountStatus = 'active' | 'suspended' | 'deactivated' | 'banned';
export type StatusAction = 'suspend' | 'ban' | 'remove' | 'activate' | 'delete';

export interface StatusTab { status: AccountStatus; label: string; empty: string }

export const STATUS_TABS: StatusTab[] = [
  { status: 'active', label: 'Active', empty: 'No active members match.' },
  { status: 'suspended', label: 'Suspended', empty: 'Nobody is suspended.' },
  { status: 'deactivated', label: 'Removed', empty: 'Nobody has been removed.' },
  { status: 'banned', label: 'Banned', empty: 'Nobody is banned.' },
];

export const STATUS_LABEL: Record<AccountStatus, string> = {
  active: 'Active', suspended: 'Suspended', deactivated: 'Removed', banned: 'Banned',
};

/** What each tab's rows may have done to them. Delete for good is a super admin's only. */
export function actionsFor(status: AccountStatus, isSuperAdmin: boolean): StatusAction[] {
  switch (status) {
    case 'active': return ['suspend', 'remove', 'ban'];
    case 'suspended': return ['activate', 'remove', 'ban'];
    case 'deactivated': return isSuperAdmin ? ['activate', 'ban', 'delete'] : ['activate', 'ban'];
    case 'banned': return isSuperAdmin ? ['activate', 'delete'] : ['activate'];
  }
}

/** The status an action leaves the account in (a delete for good closes it, as Remove does). */
export const RESULT_STATUS: Record<StatusAction, AccountStatus> = {
  suspend: 'suspended', ban: 'banned', remove: 'deactivated', activate: 'active', delete: 'deactivated',
};

export const ACTION_LABEL: Record<StatusAction, string> = {
  suspend: 'Suspend', ban: 'Ban', remove: 'Remove', activate: 'Reactivate', delete: 'Delete for good',
};

export interface ActionCopy { title: string; body: string; confirmLabel: string; busyLabel: string; tone: 'danger' | 'default'; done: string }

/** The question, the busy words and the sentence after, for one person. */
export function actionCopy(action: StatusAction, name: string): ActionCopy {
  switch (action) {
    case 'suspend':
      return {
        title: `Suspend ${name}?`, confirmLabel: 'Suspend', busyLabel: 'Suspending…', tone: 'danger',
        body: 'They cannot sign in, and other members stop seeing them, until an admin reactivates them.',
        done: `${name} is suspended. They are under Suspended now.`,
      };
    case 'ban':
      return {
        title: `Ban ${name}?`, confirmLabel: 'Ban', busyLabel: 'Banning…', tone: 'danger',
        body: 'They cannot sign in, other members stop seeing them, and asking to join again will not let them back in.',
        done: `${name} is banned. They are under Banned now.`,
      };
    case 'remove':
      return {
        title: `Remove ${name}?`, confirmLabel: 'Remove', busyLabel: 'Removing…', tone: 'danger',
        body: 'Their account is closed: they cannot sign in, and they leave every list other members see. Old chats show them as Former member. They can ask to join again later.',
        done: `${name} was removed. They are under Removed now.`,
      };
    case 'activate':
      return {
        title: `Reactivate ${name}?`, confirmLabel: 'Reactivate', busyLabel: 'Reactivating…', tone: 'default',
        body: 'They can sign in again, and other members see them as before.',
        done: `${name} is active again. They are under Active now.`,
      };
    case 'delete':
      return {
        title: `Delete ${name} for good?`, confirmLabel: 'Delete for good', busyLabel: 'Deleting…', tone: 'danger',
        body: 'Their account is closed, they are taken out of every pod and event, and they are signed out everywhere. This cannot be undone.',
        done: `${name} was deleted. They are out of every pod and event.`,
      };
  }
}

/** The bulk bar's question and its sentence after, for `count` people. */
export function bulkCopy(action: 'suspend' | 'ban' | 'activate', count: number): ActionCopy {
  const people = count === 1 ? '1 person' : `${count} people`;
  const one = actionCopy(action, people);
  const done = action === 'activate' ? `${people} reactivated.` : action === 'ban' ? `${people} banned.` : `${people} suspended.`;
  return { ...one, done };
}

export const ROLE_LABEL: Record<string, string> = {
  free: 'Free', member: 'Member', pro: 'Pro', founding_member: 'Founding Member', host: 'Host',
  admin: 'Admin', super_admin: 'Super Admin',
};

/**
 * The roles the row's menu offers. "Free" is never offered (30 Oct). Admin roles are offered only to a super admin,
 * and an admin's own row is not a menu for anyone else (the server lets only a super admin hand out those roles).
 */
export function roleChoices(isSuperAdmin: boolean): string[] {
  return isSuperAdmin ? ['member', 'pro', 'founding_member', 'host', 'admin', 'super_admin'] : ['member', 'pro', 'founding_member', 'host'];
}

export function roleIsEditable(role: string, isSuperAdmin: boolean): boolean {
  return isSuperAdmin || (role !== 'admin' && role !== 'super_admin');
}

export const NO_COUNTS: UserStatusCounts = { active: 0, suspended: 0, deactivated: 0, banned: 0 };

/** The sentence a refused or failed press shows: the server's own words, else a plain one. */
export function failureText(err: unknown): string {
  const message = (err as { response?: { data?: { error?: { message?: unknown } } } } | null)?.response?.data?.error?.message;
  return typeof message === 'string' && message.trim() ? message : 'That did not go through. Please try again.';
}
