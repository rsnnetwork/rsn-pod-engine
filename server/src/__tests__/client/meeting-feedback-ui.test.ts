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
import { partnerInRoom, watchPartnerSeen, type SeenRoom } from '../../../../client/src/features/messages/partner-seen';
import {
  afterRoomLeave, afterRoomPath, canGiveFeedback, cardLine, feedbackBody, feedbackCardDue, feedbackTitle, reportLine, toggleProblem,
  CARD_TITLE, FEEDBACK_PRIVACY, LEAVE_READ_MS, PROBLEMS_QUESTION, PROBLEM_OPTIONS, WORTH_OPTIONS, WORTH_QUESTION,
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
    for (const e of [RoomEvent.Connected, RoomEvent.Reconnected, RoomEvent.TrackSubscribed, RoomEvent.ConnectionStateChanged]) {
      expect(room.listenerCount(e)).toBe(0);
    }
  });

  // Fix round 2 (1 Nov 2026). livekit-client does not always announce a person with ParticipantConnected: it sends it
  // only while the room reads as connected (Room.ts emitWhenConnected), holds it back while the room resumes, and
  // drops what it held back when the signal resumes (Room.ts, SignalResumed: bufferedEvents = []). The person is still
  // listed, and their tile still draws from the track and connection events. So whoever is listed counts, whichever
  // event the room sends.
  it('is said for someone the room lists without ever announcing them', () => {
    for (const event of [RoomEvent.Reconnected, RoomEvent.TrackSubscribed, RoomEvent.TrackPublished, RoomEvent.ConnectionStateChanged, RoomEvent.ParticipantActive]) {
      const room = new StubRoom();
      const seen = jest.fn();
      watchPartnerSeen(room.asRoom(), seen);
      room.emit(RoomEvent.Connected);
      room.remoteParticipants.set('b', { identity: 'b' });
      room.emit(event);
      expect({ event, seen: seen.mock.calls.length > 0 }).toEqual({ event, seen: true });
    }
  });

  it('answers, as the person leaves, whether anyone else is in the room right now', () => {
    const room = new StubRoom();
    expect(partnerInRoom(room.asRoom())).toBe(false);
    room.remoteParticipants.set('b', { identity: 'b' });
    expect(partnerInRoom(room.asRoom())).toBe(true);
  });
});

describe('where leaving the room goes (worked out as the person leaves)', () => {
  const chat = '/messages/c-1';
  const asked = '/meetings/m-1?feedback=1';

  it('to the question when the other person was seen, or is in the room as I leave, and the meeting is known', async () => {
    expect(await afterRoomLeave({ conversationId: 'c-1', meetingId: 'm-1', hadPartner: true, partnerHere: false })).toBe(asked);
    // The room never announced them, but they are in it as I press leave (their tile is on my screen).
    expect(await afterRoomLeave({ conversationId: 'c-1', meetingId: 'm-1', hadPartner: false, partnerHere: true })).toBe(asked);
  });

  it('to the chat when nobody else was ever in the room, without asking the server anything', async () => {
    const read = jest.fn(async () => 'm-1');
    expect(await afterRoomLeave({ conversationId: 'c-1', meetingId: null, hadPartner: false, partnerHere: false, readMeetingId: read })).toBe(chat);
    expect(read).not.toHaveBeenCalled();
  });

  it('reads the meeting afresh when the room does not know it yet, and goes to the chat if that read fails or finds none', async () => {
    const read = jest.fn(async () => 'm-1');
    expect(await afterRoomLeave({ conversationId: 'c-1', meetingId: undefined, hadPartner: true, partnerHere: true, readMeetingId: read })).toBe(asked);
    expect(read).toHaveBeenCalledTimes(1);
    const known = jest.fn(async () => 'm-2');
    expect(await afterRoomLeave({ conversationId: 'c-1', meetingId: 'm-1', hadPartner: true, partnerHere: false, readMeetingId: known })).toBe(asked);
    expect(known).not.toHaveBeenCalled();
    expect(await afterRoomLeave({ conversationId: 'c-1', meetingId: null, hadPartner: true, partnerHere: false, readMeetingId: async () => { throw new Error('offline'); } })).toBe(chat);
    expect(await afterRoomLeave({ conversationId: 'c-1', meetingId: null, hadPartner: true, partnerHere: false, readMeetingId: async () => null })).toBe(chat);
    // A room with nothing to read (an instant call, no ?scheduled=1) goes to the chat, as before.
    expect(await afterRoomLeave({ conversationId: 'c-1', meetingId: undefined, hadPartner: true, partnerHere: true })).toBe(chat);
  });

  // Fix round 3: that read is the only wait between pressing leave and leaving, so it is bounded. A read that never
  // answers (axios gives up only after 60 s) must not hold the person in a call they asked to leave.
  it('goes to the chat once the fresh read has taken LEAVE_READ_MS, even if the read never answers', async () => {
    expect(LEAVE_READ_MS).toBe(3_000);
    jest.useFakeTimers();
    try {
      const never = jest.fn(() => new Promise<string>(() => {}));
      let to: string | null = null;
      void afterRoomLeave({ conversationId: 'c-1', meetingId: null, hadPartner: true, partnerHere: true, readMeetingId: never })
        .then((p) => { to = p; });
      await jest.advanceTimersByTimeAsync(LEAVE_READ_MS - 1);
      expect(to).toBeNull();
      await jest.advanceTimersByTimeAsync(1);
      expect(to).toBe(chat);
      expect(never).toHaveBeenCalledTimes(1);
      // A read that answers inside the bound still takes them to the question.
      let quick: string | null = null;
      void afterRoomLeave({
        conversationId: 'c-1', meetingId: null, hadPartner: true, partnerHere: true,
        readMeetingId: () => new Promise<string>((ok) => setTimeout(() => ok('m-1'), LEAVE_READ_MS - 500)),
      }).then((p) => { quick = p; });
      await jest.advanceTimersByTimeAsync(LEAVE_READ_MS - 500);
      expect(quick).toBe(asked);
    } finally {
      jest.useRealTimers();
    }
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
    expect(room).toMatch(/<PartnerSeen onSeen=\{onPartnerSeen\} probe=\{partnerProbe\} \/>/);
    expect(room).toMatch(/onDisconnected=\{leaveRoom\}/);
  });

  // Fix round 2: the leave reads what the room holds as the person leaves (who is in it now, and the meeting afresh
  // when the scheduler's read gave none), instead of trusting only what earlier events and reads left behind.
  it('decides as the person leaves: who is in the room now, and the meeting read afresh when it is not known', () => {
    expect(room).toMatch(/afterRoomLeave\(\{\s*conversationId: conversationId \?\? '',\s*meetingId: meeting\?\.meetingId,\s*hadPartner: hadPartner\.current,\s*partnerHere: partnerProbe\.current\(\),\s*readMeetingId: isScheduled \? readMeetingId : undefined,\s*\}\)/);
    expect(room).toMatch(/queryClient\.fetchQuery\(\{ queryKey: schedulingKey\(conversationId \?\? ''\), queryFn: readScheduling, staleTime: 0 \}\)/);
    const seen = read('features/messages/PartnerSeen.tsx');
    expect(seen).toMatch(/probe\.current = \(\) => partnerInRoom\(room\)/);
  });

  // Fix round 3: a press visibly does something at once, while the leave may wait (up to LEAVE_READ_MS) on that read.
  it('shows the leave buttons as busy from the moment they are pressed', () => {
    expect(room).toMatch(/leftRoom\.current = true;\s*setLeaving\(true\);/);
    expect(room).toMatch(/onClick=\{leaveRoom\}\s*disabled=\{leaving\}\s*aria-busy=\{leaving\}/);
    expect(room).toMatch(/<CallEndWatcher onLeave=\{leaveRoom\} leaving=\{leaving\} depart=\{departRef\} \/>/);
    expect(room).toMatch(/\{leaving \? 'Leaving…' : 'Leave'\}/);
  });

  it('the Wait / Leave notice never asks itself; its Leave is the person leaving, like the room\'s own buttons', () => {
    expect(room).toMatch(/<CallEndWatcher onLeave=\{leaveRoom\} /);
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
