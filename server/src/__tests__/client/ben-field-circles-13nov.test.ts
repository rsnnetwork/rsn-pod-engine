// ─── Ben field test, 13 Nov 2026: circles on the client ────────────────────────────────────────────────────────────
// "Creating a Circle requires a request and approval." "Each Circle has its own admission policy: open, request to join,
// or invitation only." "Show only Pods belonging to the active Circle when creating its events." The pure rules run
// here; the screens are pinned by what they must hold.

import * as fs from 'fs';
import * as path from 'path';
import {
  INVITE_ONLY_LOCKED_COPY, LOCKED_COPY, NEW_CIRCLE_POLICY, POLICY_COPY, POLICY_LABEL, POLICY_ORDER, isRestricted, joinButton,
  REQUEST_STATUS_LABEL, lockedCopy, policySavedToast,
} from '../../../../client/src/features/circles/circle-logic';
import { circleCountLine } from '../../../../client/src/features/reason/entities/entity-text';

const SRC = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

describe('who can join: three choices', () => {
  it('offers Open, Closed and Invitation only, in that order, each sentence starting with its label', () => {
    expect(POLICY_ORDER).toEqual(['open', 'closed', 'invite_only']);
    for (const p of POLICY_ORDER) expect(POLICY_COPY[p].startsWith(`${POLICY_LABEL[p]}: `)).toBe(true);
    expect(POLICY_LABEL.invite_only).toBe('Invitation only');
  });

  it('a new circle starts closed, never open', () => {
    expect(NEW_CIRCLE_POLICY).toBe('closed');
  });

  it('closed and invite-only keep outsiders out; open and an older server (no policy) do not', () => {
    expect(isRestricted('closed')).toBe(true);
    expect(isRestricted('invite_only')).toBe(true);
    expect(isRestricted('open')).toBe(false);
    expect(isRestricted(undefined)).toBe(false);
  });

  it('the locked line and the saved toast speak in the circle\'s own terms', () => {
    expect(lockedCopy('closed')).toBe(LOCKED_COPY);
    expect(lockedCopy('invite_only')).toBe(INVITE_ONLY_LOCKED_COPY);
    expect(policySavedToast('TRIIBE', 'invite_only')).toBe('TRIIBE is by invitation only. Only the people you invite can join.');
    expect(policySavedToast('TRIIBE', 'closed')).toBe('TRIIBE is closed. People now ask to join.');
    expect(policySavedToast('TRIIBE', 'open')).toBe('TRIIBE is open. Anyone on REASON can join.');
  });

  it('an entity names an invite-only circle as one', () => {
    expect(circleCountLine({ memberCount: null, joinPolicy: 'invite_only' })).toBe('Invitation-only circle');
    expect(circleCountLine({ memberCount: 3, joinPolicy: 'invite_only' })).toBe('Invitation-only circle · 3 members');
    expect(circleCountLine({ memberCount: 3, joinPolicy: 'open' })).toBe('3 members');
  });
});

describe('the circle button for an invite-only circle', () => {
  it('has nothing to press for someone outside it, only "Invitation only"', () => {
    expect(joinButton({ isMember: false, joinPolicy: 'invite_only', myStatus: null })).toEqual({ action: 'none', label: 'Invitation only' });
    expect(joinButton({ isMember: false, joinPolicy: 'invite_only', myStatus: 'declined' })).toEqual({ action: 'none', label: 'Invitation only' });
  });

  it('an ask from before it became invite-only can still be withdrawn; a member leaves; someone who runs it joins', () => {
    expect(joinButton({ isMember: false, joinPolicy: 'invite_only', myStatus: 'requested' })).toEqual({ action: 'cancel', label: 'Requested · Cancel' });
    expect(joinButton({ isMember: true, joinPolicy: 'invite_only', myStatus: 'member' })).toEqual({ action: 'leave', label: 'Leave' });
    expect(joinButton({ isMember: false, joinPolicy: 'invite_only', myStatus: null, canManage: true })).toEqual({ action: 'join', label: 'Join' });
  });

  it('the button renders a line, not a button, for that state', () => {
    const src = read('features/circles/CircleJoinButton.tsx');
    expect(src).toMatch(/if \(action === 'none'\) \{\n\s+return \(\n\s+<span/);
  });
});

describe('asking for a new circle', () => {
  it('a member sees Request a circle, an admin New circle; both forms choose who can join, starting closed', () => {
    const page = read('features/circles/CirclesPage.tsx');
    expect(page).toMatch(/admin \? \([\s\S]*?New circle[\s\S]*?\) : \([\s\S]*?Request a circle/);
    expect(page).toMatch(/\{!admin && <MyCircleRequests userId=\{user\?\.id\} \/>\}/);
    for (const sheet of ['NewCircleSheet.tsx', 'RequestCircleSheet.tsx']) {
      const src = read(`features/circles/${sheet}`);
      expect(src).toMatch(/joinPolicy: NEW_CIRCLE_POLICY/);
      expect(src).toMatch(/<CirclePolicyField field=\{register\('joinPolicy'\)\}/);
    }
  });

  it('the ask says who the circle is for and why, and that an admin reviews it', () => {
    const src = read('features/circles/RequestCircleSheet.tsx');
    expect(src).toMatch(/Who is it for, and why should it exist\?/);
    expect(src).toMatch(/A REASON admin will review it/);
  });

  it('each ask reads where it stands in plain words', () => {
    expect(REQUEST_STATUS_LABEL).toEqual({
      pending: 'Waiting for review', approved: 'Approved', declined: 'Not approved', cancelled: 'Withdrawn',
    });
  });

  it('the lists follow their tags: the member\'s own asks and the admins\' queue', () => {
    const src = read('features/circles/useCircleRequests.ts');
    expect(src).toMatch(/meta: \{ entities: userId \? \[E\.userCircleRequests\(userId\)\] : \[\] \}/);
    expect(src).toMatch(/meta: \{ entities: \[E\.adminCircleRequests\] \}/);
    expect(src).not.toMatch(/setQueryData/);
  });

  it('admins reach the queue from the admin tabs and the dashboard', () => {
    expect(read('features/reason/shell/AdminTabs.tsx')).toMatch(/\{ to: '\/admin\/circle-requests', label: 'Circle Requests', end: false \}/);
    expect(read('App.tsx')).toMatch(/<Route path="\/admin\/circle-requests" element=\{<AdminCircleRequestsPage \/>\} \/>/);
    expect(read('features/admin/AdminDashboardPage.tsx')).toMatch(/path: '\/admin\/circle-requests'/);
  });
});

describe('scheduling from a circle', () => {
  it('offers only the circle\'s own pods, and says how to add one when there is none', () => {
    const src = read('features/sessions/CreateSessionPage.tsx');
    expect(src).toMatch(/formProps\.circle \? circleBody\(formProps\.circle, schedulable\)/);
    expect(src).toMatch(/if \(inCircle\.length > 0\) return <NewEventForm pods=\{inCircle\} \{\.\.\.formProps\} \/>;/);
    expect(src).toMatch(/No pod in \$\{c\.name\} to schedule in yet/);
    expect(src).not.toMatch(/Your other pods/);
  });
});
