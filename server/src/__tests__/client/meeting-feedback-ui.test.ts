// server/src/__tests__/client/meeting-feedback-ui.test.ts
// Feedback after meetings (30 Oct 2026, item 5c): "After a meeting ends, show a short prompt asking how it went and if
// there were any problems. Save the answers in the admin panel."
//
// meeting-feedback.ts is run for real: it has no React, axios, store or router behind it. The screens are read as
// source, like the other client pins (the client has no test runner of its own).
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { RoomEvent } from 'livekit-client';
import type { Meeting } from '@rsn/shared';
import { watchPartnerSeen, type SeenRoom } from '../../../../client/src/features/messages/partner-seen';
import {
  afterRoomPath, canGiveFeedback, cardLine, feedbackBody, feedbackCardDue, feedbackTitle, reportLine, toggleProblem,
  CARD_TITLE, FEEDBACK_PRIVACY, PROBLEMS_QUESTION, PROBLEM_OPTIONS, WORTH_OPTIONS, WORTH_QUESTION,
} from '../../../../client/src/features/meetings/meeting-feedback';
import { E as clientE } from '../../../../client/src/realtime/entities';

const CLIENT = path.join(__dirname, '../../../../client/src');
// Working-tree files are CRLF on Windows; normalise so patterns match either way.
const read = (rel: string) => fs.readFileSync(path.join(CLIENT, rel), 'utf8').replace(/\r\n/g, '\n');

const meeting = (over: Partial<Meeting> = {}): Meeting => ({
  id: 'm-1', conversationId: 'c-1', partner: { userId: 'u-2', displayName: 'Stefan Avivson', avatarUrl: null },
  startAt: '2026-10-25T12:00:00.000Z', durationMin: 30, kind: 'video', status: 'scheduled', phase: 'ended',
  context: null, joinPath: '/meet/c-1?scheduled=1&kind=video', attended: { me: true, them: true }, myFeedback: null,
  ...over,
});
const START = Date.parse('2026-10-25T12:00:00.000Z');

describe('the words, as L11 and the review give them', () => {
  it('asks how the meeting went, by name, with Yes / Maybe / No and the five problems', () => {
    expect(feedbackTitle('Stefan Avivson')).toBe('How did your meeting with Stefan Avivson go?');
    expect(WORTH_QUESTION).toBe('Worth continuing?');
    expect(WORTH_OPTIONS.map((o) => o.label)).toEqual(['Yes', 'Maybe', 'No']);
    expect(PROBLEMS_QUESTION).toBe('Any problems?');
    expect(PROBLEM_OPTIONS.map((o) => o.label)).toEqual(['Audio', 'Video', 'Connection', 'Behaviour', 'Other']);
    expect(reportLine('Stefan Avivson')).toBe('You can also report Stefan Avivson.');
    expect(FEEDBACK_PRIVACY).toBe('Only you and the REASON team see this.');
    expect(CARD_TITLE).toBe('How did it go?');
    expect(cardLine('Stefan Avivson')).toBe('Tell us how your meeting with Stefan Avivson went.');
  });
});

describe('when feedback is asked for', () => {
  it('from the start of the meeting, also when the other person never came; never before, never once cancelled', () => {
    expect(canGiveFeedback(meeting(), START - 1)).toBe(false);
    expect(canGiveFeedback(meeting(), START)).toBe(true);
    expect(canGiveFeedback(meeting({ attended: { me: true, them: false } }), START + 60_000)).toBe(true);
    expect(canGiveFeedback(meeting({ status: 'cancelled' }), START + 60_000)).toBe(false);
  });

  it('the card shows until the viewer has answered', () => {
    expect(feedbackCardDue(meeting(), START + 1)).toBe(true);
    expect(feedbackCardDue(meeting({ myFeedback: { worthContinuing: 'yes', problems: [], problemText: null } }), START + 1)).toBe(false);
    // An older server sends no myFeedback at all: the card asks, and the server keeps one answer per person.
    expect(feedbackCardDue(meeting({ myFeedback: undefined }), START + 1)).toBe(true);
  });

  it('leaving the room opens the question only after the other person had been in it, and only for a known meeting', () => {
    expect(afterRoomPath({ conversationId: 'c-1', meetingId: 'm-1', hadPartner: true })).toBe('/meetings/m-1?feedback=1');
    expect(afterRoomPath({ conversationId: 'c-1', meetingId: 'm-1', hadPartner: false })).toBe('/messages/c-1');
    expect(afterRoomPath({ conversationId: 'c-1', meetingId: null, hadPartner: true })).toBe('/messages/c-1');
    expect(afterRoomPath({ conversationId: 'c-1', hadPartner: true })).toBe('/messages/c-1');
  });
});

describe('what Send posts', () => {
  it('Worth continuing alone, or with the problems in the sheet\'s order and the text trimmed', () => {
    expect(feedbackBody('yes', [], '   ')).toEqual({ worthContinuing: 'yes' });
    expect(feedbackBody('maybe', ['connection'], '  It froze  ')).toEqual({ worthContinuing: 'maybe', problems: ['connection'], problemText: 'It froze' });
    expect(feedbackBody('no', [], 'x'.repeat(1200)).problemText).toHaveLength(1000);
    expect(toggleProblem(['other'], 'audio')).toEqual(['audio', 'other']);
    expect(toggleProblem(['audio', 'other'], 'audio')).toEqual(['other']);
  });
});

describe('the sheet', () => {
  const sheet = read('features/meetings/MeetingFeedbackSheet.tsx');

  it('is the REASON Sheet (portalled to body), titled with the question', () => {
    expect(sheet).toMatch(/import Sheet from '@\/features\/reason\/ui\/Sheet';/);
    expect(sheet).toMatch(/title=\{feedbackTitle\(name\)\}/);
    expect(read('features/reason/ui/Sheet.tsx')).toMatch(/createPortal\(/);
  });

  it('has Send and Skip in the pinned footer with the privacy line, every control 44px tall', () => {
    expect(sheet).toMatch(/footer=\{/);
    expect(sheet).toContain('{FEEDBACK_PRIVACY}');
    expect(sheet).toMatch(/>\s*Skip\s*</);
    expect(sheet).toMatch(/'Send'/);
    expect(sheet.match(/min-h-\[44px\]/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it('offers the report only when Behaviour is picked, and opens ReportUserModal for the other person', () => {
    expect(sheet).toMatch(/problems\.includes\('behaviour'\)/);
    expect(sheet).toMatch(/import ReportUserModal from '@\/components\/ReportUserModal';/);
    expect(sheet).toMatch(/reportedId=\{meeting\.partner\.userId\}/);
    // The modal sits under the sheet's layer, so the sheet steps aside while it is open and comes back with its answers.
    expect(sheet).toMatch(/open=\{open && !reporting\}/);
  });

  it('starts from the viewer\'s own earlier answer, so a second press edits it', () => {
    expect(sheet).toMatch(/meeting\.myFeedback/);
  });
});

describe('the meeting page', () => {
  const card = read('features/meetings/MeetingFeedback.tsx');
  const page = read('features/meetings/MeetingDetailPage.tsx');

  it('shows the card until it is answered, and opens the sheet from ?feedback=1', () => {
    expect(card).toMatch(/feedbackCardDue\(meeting, now\)/);
    expect(card).toMatch(/get\('feedback'\) === '1'/);
    expect(card).toContain('{CARD_TITLE}');
    expect(page).toMatch(/<MeetingFeedback meeting=\{meeting\} now=\{now\} \/>/);
  });

  it('posts through the meetings hooks, which refetch the meeting when it is saved', () => {
    const hooks = read('features/meetings/useMeetings.ts');
    expect(hooks).toMatch(/api\.post\(`\/meetings\/\$\{encodeURIComponent\(id\)\}\/feedback`, body\)/);
    expect(hooks).toMatch(/export function useSubmitMeetingFeedback/);
  });
});

describe('whether the other person has been in the room', () => {
  // livekit-client lists the people already in the room once it has connected (no "connected" event for them), and
  // announces each person who comes in later.
  class StubRoom extends EventEmitter {
    remoteParticipants = new Map<string, { identity: string }>();
    asRoom(): SeenRoom { return this as unknown as SeenRoom; }
  }

  it('is never said for a room nobody else came into', () => {
    const room = new StubRoom();
    const seen = jest.fn();
    watchPartnerSeen(room.asRoom(), seen);
    room.emit(RoomEvent.Connected);
    expect(seen).not.toHaveBeenCalled();
  });

  it('is said for someone already there when I connect, and for someone who comes in later', () => {
    const early = new StubRoom();
    const seenEarly = jest.fn();
    watchPartnerSeen(early.asRoom(), seenEarly);
    early.remoteParticipants.set('b', { identity: 'b' });
    early.emit(RoomEvent.Connected);
    expect(seenEarly).toHaveBeenCalled();

    const late = new StubRoom();
    const seenLate = jest.fn();
    watchPartnerSeen(late.asRoom(), seenLate);
    late.emit(RoomEvent.Connected);
    late.remoteParticipants.set('b', { identity: 'b' });
    late.emit(RoomEvent.ParticipantConnected, { identity: 'b' });
    expect(seenLate).toHaveBeenCalled();
  });

  it('stops listening when the room goes', () => {
    const room = new StubRoom();
    const seen = jest.fn();
    watchPartnerSeen(room.asRoom(), seen)();
    room.emit(RoomEvent.ParticipantConnected, { identity: 'b' });
    expect(seen).not.toHaveBeenCalled();
    expect(room.listenerCount(RoomEvent.Connected)).toBe(0);
  });
});

// Fix round 1 (1 Nov 2026). On the preview the spec's leave went to the chat: it moved the meeting's start and the
// conversation's start in two statements, two transactions with two NOW()s, and the server names a conversation's
// meeting only while the two starts are equal, so the room read no meeting id. Any spec that moves a booked meeting's
// time must move both in one statement.
describe('the feedback spec moves a booked meeting the way the server can still read it', () => {
  const spec = fs.readFileSync(path.join(__dirname, '../../../../e2e/tests/n1-t8-meeting-feedback.spec.ts'), 'utf8').replace(/\r\n/g, '\n');
  const guard = fs.readFileSync(path.join(__dirname, '../../services/meetings/current-meeting.ts'), 'utf8');

  it("the server names the meeting only while its start equals the conversation's", () => {
    expect(guard.replace(/\s+/g, ' ')).toContain('AND m.start_at = dm_conversations.meeting_start_at');
  });

  it('so the spec moves both starts in one statement, and checks the room can still see the meeting', () => {
    expect(spec).toMatch(/WITH moved AS \(UPDATE meetings SET start_at = [^\n]*? RETURNING start_at\)\s*UPDATE dm_conversations SET meeting_start_at = \(SELECT start_at FROM moved\)/);
    expect(spec).not.toMatch(/UPDATE dm_conversations SET meeting_start_at = NOW\(\)/);
    expect(spec).toMatch(/confirmed\?\.meetingId, 'the room can still see the meeting it is in'\)\.toBe\(roomMeeting\)/);
  });
});

describe('the meeting room', () => {
  const room = read('features/messages/MeetPage.tsx');

  it('notes whether the other person was ever in the room, and leaving goes to the question only then', () => {
    expect(room).toMatch(/<PartnerSeen onSeen=\{/);
    expect(room).toMatch(/afterRoomPath\(\{ conversationId: conversationId \?\? '', meetingId: meeting\?\.meetingId, hadPartner: hadPartner\.current \}\)/);
    expect(room).toMatch(/onDisconnected=\{leaveRoom\}/);
  });

  it('the Wait / Leave notice never asks itself; its Leave is the person leaving, like the room\'s own buttons', () => {
    expect(room).toMatch(/<CallEndWatcher onLeave=\{leaveRoom\} \/>/);
    // The pages outside the room (error, ended, countdown) go back to the chat, as before.
    expect(room.match(/onClick=\{leave\}/g)?.length).toBe(3);
  });
});

describe('the admin feedback page', () => {
  const page = read('features/admin/AdminFeedbackPage.tsx');
  const app = read('App.tsx');

  it('is at /admin/feedback, in the admin tabs', () => {
    expect(app).toMatch(/<Route path="\/admin\/feedback" element=\{<AdminFeedbackPage \/>\} \/>/);
    expect(read('features/reason/shell/AdminTabs.tsx')).toContain("{ to: '/admin/feedback', label: 'Feedback', end: false }");
  });

  it('declares admin:meeting-feedback on its list (an infinite query, which the realtime check does not scan), so an answer appears live', () => {
    expect(clientE.adminMeetingFeedback).toBe('admin:meeting-feedback');
    expect(page).toMatch(/useInfiniteQuery\(\{[\s\S]*?meta: \{ entities: \[E\.adminMeetingFeedback\] \}/);
  });

  it('has the filter, the CSV, links to the user inspector, and its three states', () => {
    expect(page).toContain('Only with problems');
    expect(page).toMatch(/\/admin\/feedback\.csv/);
    expect(page).toMatch(/to=\{`\/admin\/users\/\$\{/);
    expect(page).toContain('No feedback yet.');
    expect(page).toContain('Try again');
    expect(page).toMatch(/aria-busy/);
  });

  it('turns a member away, and never asks the server for them', () => {
    expect(page).toMatch(/enabled: admin/);
    expect(page).toContain('Admins only');
  });

  it('reads a profile answer as "Profile" and a closed account as the server names it', () => {
    expect(page).toMatch(/'Profile'/);
    expect(page).toMatch(/isFormerMember/);
  });
});
