// ─── Who is invited, who declined: the organisers' list on the pod and event pages (26 Oct 2026, C9, POD-02/04) ───
//
// 25 Oct walkthrough: Claus closed the invite modal to see whether his invite had worked ("it greys out"): pending
// invites showed only behind a chip or a banner, at 70% opacity at the end of the participants, and a decline was never
// shown at all (it was stored as a withdrawal). The server (S7) now keeps when an invite was declined (declinedAt) and
// names the member it went to (inviteeUserId). This turns the pod's or event's invite lists into what the organisers
// always see: Invited, with Remind and Withdraw, and Declined.
//
// Pure (no React, axios or store), so the server's jest runs it: server/src/__tests__/client/c9-invite-picker.test.ts.
import { people, type Notice } from './invite-picker';

/** One row of GET /invites/pod/:podId or GET /invites/session/:sessionId. */
export interface InviteListRow {
  id: string;
  code: string;
  /** The address, or for a co-host a label in its place (the member's name, or a masked address); null for an open link. */
  inviteeEmail: string | null;
  inviteeName: string | null;
  /** The member the address belongs to, when it belongs to one. */
  inviteeUserId: string | null;
  status: string;
  createdAt: string;
  /** Set when the invitee said no; a withdrawal leaves it null. Both keep the status 'revoked'. */
  declinedAt: string | null;
  /** The event's list says how often an open link has been used. */
  maxUses?: number;
  useCount?: number;
}

export interface InviteStatusGroups {
  /** Pending invites to a person, newest first, one each. */
  invited: InviteListRow[];
  /** One row per person whose decline stands, newest first. */
  declined: InviteListRow[];
  /** Pending shareable links (no address). */
  links: InviteListRow[];
}

export const STATUS_TITLE = 'Invitations';
export const NOBODY_INVITED = 'Nobody has been invited yet.';
/** The empty card's button: it opens the same sheet as the page's own invite button, under words of its own. */
export const CHOOSE_PEOPLE = 'Choose people to invite';
export const LOAD_FAILED = 'We could not load the invitations just now.';
export const WITHDRAW_CONFIRM = 'Withdraw this invite? Its link stops working, and you can invite them again afterwards.';
export const WITHDRAWN = 'Invite withdrawn. Its link no longer works.';
export const NOT_WITHDRAWN = 'The invite could not be withdrawn. Please try again.';
export const NOT_REMINDED = 'The reminder could not be sent. Please try again.';
export const SHAREABLE_LINK = 'Shareable link';

/** One person across their invites: the member, or for an address with no member the address itself. */
function personKey(row: InviteListRow): string {
  if (row.inviteeUserId) return row.inviteeUserId;
  return row.inviteeEmail ? `email:${row.inviteeEmail.trim().toLowerCase()}` : `invite:${row.id}`;
}

const at = (iso: string | null) => (iso ? new Date(iso).getTime() : Number.NaN);

/**
 * Invited, Declined and the open links, read as the server reads a person's standing (invite-candidates.service.ts):
 * someone already in (a pod's active member, an event's guest) is neither; a pending invite makes them Invited; a
 * decline stands until they are invited again or say yes to an invite made after it. `pending` is the list asked with
 * ?status=pending (the server leaves out invites whose expiry has passed); `history` is every invite, any status.
 */
export function inviteStatusGroups(
  pending: readonly InviteListRow[],
  history: readonly InviteListRow[],
  present: ReadonlySet<string>,
): InviteStatusGroups {
  const isIn = (row: InviteListRow) => !!row.inviteeUserId && present.has(row.inviteeUserId);
  const links = pending.filter((row) => !row.inviteeEmail);

  const invited: InviteListRow[] = [];
  const invitedPeople = new Set<string>();
  for (const row of pending) {
    if (!row.inviteeEmail || isIn(row)) continue;
    const key = personKey(row);
    if (invitedPeople.has(key)) continue;
    invitedPeople.add(key);
    invited.push(row);
  }

  const latestDecline = new Map<string, InviteListRow>();
  for (const row of history) {
    if (!row.inviteeEmail || !row.declinedAt) continue;
    const key = personKey(row);
    const seen = latestDecline.get(key);
    if (!seen || at(row.declinedAt) > at(seen.declinedAt)) latestDecline.set(key, row);
  }
  const saidYesSince = (key: string, decline: InviteListRow) =>
    history.some((row) => row.status === 'accepted' && personKey(row) === key && at(row.createdAt) > at(decline.declinedAt));
  const declined = [...latestDecline.entries()]
    .filter(([key, decline]) => !invitedPeople.has(key) && !isIn(decline) && !saidYesSince(key, decline))
    .map(([, decline]) => decline)
    .sort((a, b) => at(b.declinedAt) - at(a.declinedAt));

  return { invited, declined, links };
}

/** The three figures at the top: who is in (Members of a pod, Going to an event), Invited, Declined. */
export function statusSummary(kind: 'pod' | 'session', presentCount: number, groups: InviteStatusGroups) {
  return [
    { label: kind === 'pod' ? 'Members' : 'Going', count: presentCount },
    { label: 'Invited', count: groups.invited.length },
    { label: 'Declined', count: groups.declined.length },
  ];
}

/** A row's name, and the address on a line of its own only when it says something the name does not. */
export function personLine(row: InviteListRow): { name: string; detail: string | null } {
  const name = row.inviteeName || row.inviteeEmail || 'Someone';
  const detail = row.inviteeName && row.inviteeEmail && row.inviteeEmail !== row.inviteeName ? row.inviteeEmail : null;
  return { name, detail };
}

/** "26 Oct 2026", the way the event page writes dates. */
export function dayOf(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** One reminder's answer: sent, or not sent again because it went within the hour (still a 200). */
export function remindSentence(answer: { reminded?: boolean; recentlyReminded?: boolean }): Notice {
  return answer.reminded
    ? { message: 'Reminder sent.', tone: 'success' }
    : { message: 'They were reminded less than an hour ago.', tone: 'info' };
}

/** Remind all, in what went: the reminders sent, the ones that went within the hour, the ones that could not go. */
export function remindAllSentence({ reminded, total, recentlyReminded }: { reminded: number; total: number; recentlyReminded?: number }): Notice {
  const recent = recentlyReminded ?? 0;
  if (total === 0) {
    return recent > 0
      ? { message: 'Everyone was reminded less than an hour ago.', tone: 'info' }
      : { message: 'Nobody is waiting for a reminder.', tone: 'info' };
  }
  if (reminded === 0) return { message: 'The reminders could not be sent just now. Please try again.', tone: 'error' };
  if (reminded < total) return { message: `Reminders sent to ${reminded} of ${total} people. Try the rest again in a moment.`, tone: 'info' };
  const also = recent > 0 ? ` ${people(recent)} ${recent === 1 ? 'was' : 'were'} reminded less than an hour ago.` : '';
  return { message: `Reminders sent to ${people(reminded)}.${also}`, tone: 'success' };
}

/**
 * A pod has no remind-all route, so its page reminds each invite on its own and counts the answers the way the event's
 * route does: sent, reminded within the hour (left out of the total), or failed (anything that did not answer "sent").
 */
export function tallyReminders(
  results: ReadonlyArray<PromiseSettledResult<{ reminded?: boolean; recentlyReminded?: boolean }>>,
): { reminded: number; total: number; recentlyReminded: number } {
  let reminded = 0;
  let recentlyReminded = 0;
  let failed = 0;
  for (const result of results) {
    if (result.status === 'rejected') failed += 1;
    else if (result.value.reminded) reminded += 1;
    else if (result.value.recentlyReminded) recentlyReminded += 1;
    else failed += 1;
  }
  return { reminded, total: reminded + failed, recentlyReminded };
}

/** The pause between two reminders of a pod's Remind all: the mail provider takes about two sends a second. */
export const REMIND_GAP_MS = 500;

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * Runs `run` for each item in turn, one at a time, pausing `gapMs` between two (not after the last), and keeps every
 * answer as Promise.allSettled would: a failure is recorded and the rest still run. The pod's Remind all sends its
 * reminders this way, because every reminder is an email and the provider drops sends that arrive together.
 */
export async function settleInTurn<T, R>(
  items: readonly T[],
  run: (item: T) => Promise<R>,
  gapMs: number,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  for (let i = 0; i < items.length; i++) {
    if (i > 0) await wait(gapMs);
    try {
      results.push({ status: 'fulfilled', value: await run(items[i]) });
    } catch (reason) {
      results.push({ status: 'rejected', reason });
    }
  }
  return results;
}
