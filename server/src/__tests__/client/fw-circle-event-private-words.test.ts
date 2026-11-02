// ─── For an event made for a circle, Private says the circle (final fix wave CM2, 2 Nov 2026) ────────────────────
//
// T13 made the schedule form's Private card for a circle event read "Private: only {circle}'s members and people you
// invite". The Edit Event form passed no circle, so it said the pod's words, and the event page's private notice always
// said "It is for its pod's members". Both now name the circle when the event is for one, and keep the pod's words when
// it is not. The words are pure and run here; the wiring is pinned by its source.

import * as fs from 'fs';
import * as path from 'path';
import { circlePrivateNotice } from '../../../../client/src/features/sessions/circle-preset';

const CLIENT = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(CLIENT, rel), 'utf8').replace(/\r\n/g, '\n');

describe("the event page's private notice", () => {
  it("names the circle's members for a circle event", () => {
    expect(circlePrivateNotice('Founding Circle')).toBe("This event is private. It is for Founding Circle's members and the people the host invites.");
    expect(circlePrivateNotice('  Doctors ')).toBe("This event is private. It is for Doctors's members and the people the host invites.");
  });

  it('the event page hands the notice the circle, and keeps the pod words without one', () => {
    const actions = read('features/sessions/EventAccessActions.tsx');
    expect(actions).toMatch(/<span>\{circleName \? circlePrivateNotice\(circleName\) : ACCESS_COPY\.privateNotice\}<\/span>/);
    expect(actions).toContain("privateNotice: 'This event is private. It is for its pod\\'s members and the people the host invites.',");
    expect(read('features/sessions/SessionDetailPage.tsx')).toMatch(/<EventAccessActions[\s\S]*?circleName=\{session\.circle\?\.name\}[\s\S]*?\/>/);
  });
});

describe('the Edit Event form', () => {
  it("passes the event's circle to Who can join, so its Private card names the circle", () => {
    const modal = read('features/sessions/EditEventModal.tsx');
    expect(modal).toMatch(/circle\?: \{ id: string; name: string \} \| null;/);
    expect(modal).toMatch(/<EventAccessField[\s\S]*?circleName=\{session\.circle\?\.name\}[\s\S]*?\/>/);
  });
});
