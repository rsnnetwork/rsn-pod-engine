// ─── T11 (1 Nov 2026; L17): who can join an event, on the preview's screens (source pins) ───────────────────
// The event page reads what the viewer may do from the server (session.access), never from the pod (D11); opening
// the page registers only the audience and invitees; the forms send "Who can join" as the top-level visibility; the
// duplicate keeps the type and who can join (D9); the Events list shows a chip; the Requests card follows the server.

import * as fs from 'fs';
import * as path from 'path';

const CLIENT_SRC = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(CLIENT_SRC, rel), 'utf8').replace(/\r\n/g, '\n');

const detail = read('features/sessions/SessionDetailPage.tsx');
const actions = read('features/sessions/EventAccessActions.tsx');
const card = read('features/sessions/EventJoinRequestsCard.tsx');
const field = read('features/sessions/EventAccessField.tsx');
const create = read('features/sessions/CreateSessionPage.tsx');
const edit = read('features/sessions/EditEventModal.tsx');
const list = read('features/sessions/SessionsPage.tsx');

describe('the event page (D11, L17)', () => {
  it('no longer guesses access from the pod, nor tells people they have an invite they do not have', () => {
    expect(detail).not.toMatch(/isRestrictedPod/);
    expect(detail).not.toMatch(/You have a pending invite/);
    expect(detail).toMatch(/const access: EventAccess \| undefined = session\?\.access;/);
  });

  it('shows "This event is private" when the server refuses with EVENT_PRIVATE (fix round 1)', () => {
    expect(detail).toMatch(/error\?\.code === 'EVENT_PRIVATE'/);
    expect(detail).toMatch(/ACCESS_COPY\.privateTitle/);
    expect(actions).toContain("privateTitle: 'This event is private'");
  });

  it('auto-registers only when the server says so (the audience and invitees); an old server keeps the old behaviour', () => {
    expect(detail).toMatch(/if \(access && !access\.autoRegister\) return;/);
  });

  it('offers Register, Request to join or the private notice by the server\'s mode', () => {
    expect(detail).toMatch(/<EventAccessActions/);
    expect(actions).toMatch(/mode === 'private'/);
    expect(actions).toMatch(/mode === 'request'/);
    expect(actions).toMatch(/api\.post\(`\/sessions\/\$\{sessionId\}\/requests`/);
    expect(actions).toMatch(/api\.delete\(`\/sessions\/\$\{sessionId\}\/requests\/mine`\)/);
    expect(actions).toContain("requestTitle: 'Request to join'");
    expect(actions).toContain("sent: 'Request sent'");
    expect(actions).toContain("withdraw: 'Withdraw'");
  });

  it('shows the Requests card to the people who answer requests, opened by ?requests=1', () => {
    expect(detail).toMatch(/access\?\.canManageRequests && access\.visibility === 'public_with_approval'/);
    expect(detail).toMatch(/focus=\{searchParams\.get\('requests'\) === '1'\}/);
    expect(card).toMatch(/meta: \{ entities: \[E\.session\(sessionId\)\] \}/);
    expect(card).toMatch(/\/requests\/\$\{row\.userId\}\/\$\{verb\}/);
    expect(card).toMatch(/min-h-\[44px\]/);
  });

  it('duplicates with the event\'s format and visibility (D9)', () => {
    expect(detail).toMatch(/format: session\?\.format,/);
    expect(detail).toMatch(/\.\.\.\(session\?\.visibility \? \{ visibility: session\.visibility \} : \{\}\)/);
  });
});

describe('the forms and the list', () => {
  it('offers the three choices from the shared words, with 44px cards and the pod\'s own setting', () => {
    expect(field).toMatch(/EVENT_VISIBILITY_KEYS\.map/);
    expect(field).toMatch(/min-h-\[44px\]/);
    expect(field).toMatch(/This choice is for this event only\./);
  });

  it('schedules with the visibility at the top level, starting from the pod', () => {
    expect(create).toMatch(/chosenVisibility \?\? defaultEventVisibility\(pod\?\.visibility\)/);
    expect(create).toMatch(/create\.mutate\(\{ \.\.\.eventBody\(values, \{ isAdmin \}\), visibility \}\)/);
  });

  it('edits send the visibility only when the organiser changed it', () => {
    expect(edit).toMatch(/\.\.\.\(visibilityChosen \? \{ visibility \} : \{\}\)/);
  });

  it('shows a chip per event that has its own visibility', () => {
    expect(list).toMatch(/EVENT_ACCESS\[s\.visibility\]\.chip/);
  });
});
