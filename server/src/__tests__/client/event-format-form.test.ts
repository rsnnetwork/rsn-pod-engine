// server/src/__tests__/client/event-format-form.test.ts
// The event forms' rules (C7, 26 Oct 2026), EXECUTED: what a new or edited event starts on for each event type,
// what a switch of type does (and when it must ask first), what the forms send, and how BOTH shapes of server
// refusal land at the field they belong to. event-format-form.ts has no React, axios, store or router behind it,
// so a test can import it, the way entity-form.ts is run in reason-entities-text.test.ts.
//
// 25 Oct walkthrough: a "Video meeting" in a Reason pod was created with five 8-minute rounds and ran as speed
// networking; the title's "Required" sat three screens above the button on a phone.
import {
  TITLE_REQUIRED, autoTitle, editEventValues, eventBody, eventChanges, eventFacts, eventFactsLine, eventProblems,
  lengthOptions, newEventValues, nextQuarterHour, offeredFormats, podChangeFormat, problemSummary, settingProblem,
  startingFormat, switchFormat, titleProblem, type EventFormValues,
} from '../../../../client/src/features/sessions/event-format-form';
import { CONNECTION_LOST } from '../../../../client/src/features/reason/errors';

const reasonPod = { id: 'pod-1', name: 'Test', podType: 'reason', orchestrationMode: 'free_form' } as const;
const speedPod = { id: 'pod-2', name: 'Founders', podType: 'speed_networking', orchestrationMode: 'timed_rounds' } as const;
const chatPod = { id: 'pod-3', name: 'Chat', podType: 'chat', orchestrationMode: 'free_form' } as const;

// What axios hands a catch block when the server answered, and when nothing did.
const refused = (status: number, error: Record<string, unknown>) => ({ isAxiosError: true, response: { status, data: { success: false, error } } });
const noAnswer = Object.assign(new Error('Network Error'), { isAxiosError: true, code: 'ERR_NETWORK' });
const CREATE_COPY = {
  fallback: 'Could not schedule the event just now. Try again in a moment.',
  forbidden: "Only the pod's director or a host can schedule events in this pod.",
  notFound: 'This pod could not be found. It may have been archived.',
};

describe('the event types a pod offers, and the one a new event starts on', () => {
  it('a Reason pod offers Video meeting first, then Speed networking; a Chat pod only Video meeting', () => {
    expect(offeredFormats('reason' as never)).toEqual(['video_meeting', 'speed_networking']);
    expect(offeredFormats('chat' as never)).toEqual(['video_meeting']);
    expect(offeredFormats('speed_networking' as never)).toEqual(['speed_networking', 'video_meeting']);
  });

  it('with no pod chosen yet, every offered type is listed, and nothing unoffered (webinar, in person)', () => {
    expect(offeredFormats(null)).toEqual(['speed_networking', 'video_meeting']);
  });

  it("an event keeps its own type on the list when its pod no longer offers it (an edit after the pod's type changed)", () => {
    expect(offeredFormats('chat' as never, 'speed_networking')).toEqual(['video_meeting', 'speed_networking']);
  });

  it('a new event follows the pod: a Reason pod starts on Video meeting, a speed-networking pod on Speed networking', () => {
    expect(startingFormat(reasonPod as never)).toBe('video_meeting');
    expect(startingFormat(speedPod as never)).toBe('speed_networking');
    // An old Reason pod saved on timed rounds reads as Freeform (its type does not allow timed rounds).
    expect(startingFormat({ podType: 'reason', orchestrationMode: 'timed_rounds' } as never)).toBe('video_meeting');
  });

  it('a pod whose type allows Freeform and runs it starts its events as a Video meeting: "everyone together in one room"', () => {
    expect(startingFormat({ podType: 'two_sided_networking', orchestrationMode: 'free_form' } as never)).toBe('video_meeting');
    expect(startingFormat({ podType: 'two_sided_networking', orchestrationMode: 'timed_rounds' } as never)).toBe('speed_networking');
  });
});

describe('a new event: its defaults per type, and a title already filled in', () => {
  it('a Video meeting in a Reason pod: 60 minutes for up to 25 people, titled "Video meeting · Test"', () => {
    const v = newEventValues({ pod: reasonPod as never, scheduledAt: '2026-11-02T10:00' });
    expect(v.format).toBe('video_meeting');
    expect(v.durationMinutes).toBe(60);
    expect(v.maxParticipants).toBe(25);
    expect(v.title).toBe('Video meeting · Test');
    expect(v.podId).toBe('pod-1');
    expect(v.scheduledAt).toBe('2026-11-02T10:00');
  });

  it('Speed networking: 5 rounds of 8 minutes, the timer in the last 10 seconds, matching within this event, 500 people', () => {
    const v = newEventValues({ pod: speedPod as never, scheduledAt: '2026-11-02T10:00' });
    expect(v.format).toBe('speed_networking');
    expect([v.numberOfRounds, v.roundMinutes, v.timerVisibility, v.matchingPolicy, v.maxParticipants])
      .toEqual([5, 8, 'last_10s', 'within_event', 500]);
    expect(v.matchingTemplateId).toBe('');
    expect(v.title).toBe('Speed networking · Founders');
  });

  it('with no pod chosen yet: Speed networking, titled by the type alone', () => {
    const v = newEventValues({ pod: null, scheduledAt: '2026-11-02T10:00' });
    expect(v.format).toBe('speed_networking');
    expect(v.podId).toBe('');
    expect(v.title).toBe('Speed networking');
  });

  it('the date starts on the next quarter hour, in local time as a datetime-local field holds it', () => {
    expect(nextQuarterHour(new Date(2026, 10, 2, 9, 7, 31))).toBe('2026-11-02T09:15');
    expect(nextQuarterHour(new Date(2026, 10, 2, 9, 50))).toBe('2026-11-02T10:00');
    expect(nextQuarterHour(new Date(2026, 10, 2, 23, 59))).toBe('2026-11-03T00:00');
    expect(nextQuarterHour(new Date(2026, 10, 2, 9, 15))).toBe('2026-11-02T09:15');
  });

  it('the title follows the type and pod until the member writes their own', () => {
    // Still the one we filled in: it follows.
    expect(autoTitle('Video meeting · Test', 'Video meeting · Test', 'Speed networking · Test')).toBe('Speed networking · Test');
    // Their own words stay, and so does a title they emptied on purpose.
    expect(autoTitle('Board catch-up', 'Video meeting · Test', 'Speed networking · Test')).toBe('Board catch-up');
    expect(autoTitle('', 'Video meeting · Test', 'Speed networking · Test')).toBe('');
  });
});

describe('switching the event type', () => {
  const meeting = (): EventFormValues => newEventValues({ pod: reasonPod as never, scheduledAt: '2026-11-02T10:00' });

  it('a Video meeting switched to Speed networking shows the round settings at their defaults, without asking', () => {
    const r = switchFormat(meeting(), 'speed_networking', new Set());
    expect(r.confirm).toBeNull();
    expect(r.values.format).toBe('speed_networking');
    expect([r.values.numberOfRounds, r.values.roundMinutes, r.values.maxParticipants]).toEqual([5, 8, 500]);
  });

  it('switching back after editing the rounds asks first, in these words', () => {
    const toRounds = switchFormat(meeting(), 'speed_networking', new Set()).values;
    const edited = { ...toRounds, numberOfRounds: 3, roundMinutes: 10 };
    const r = switchFormat(edited, 'video_meeting', new Set(['numberOfRounds', 'roundMinutes']));
    expect(r.confirm).toBe('Switching to Video meeting removes the round settings (3 rounds × 10 min). Continue?');
    // Confirmed, the meeting's own settings return and the rounds stay in the form for a switch back.
    expect(r.values.format).toBe('video_meeting');
    expect(r.values.durationMinutes).toBe(60);
    expect(r.values.maxParticipants).toBe(25);
    expect(r.values.numberOfRounds).toBe(3);
    const back = switchFormat(r.values, 'speed_networking', new Set(['numberOfRounds', 'roundMinutes']));
    expect([back.values.numberOfRounds, back.values.roundMinutes]).toEqual([3, 10]);
  });

  it('one round reads "1 round"', () => {
    const toRounds = switchFormat(meeting(), 'speed_networking', new Set()).values;
    const r = switchFormat({ ...toRounds, numberOfRounds: 1 }, 'video_meeting', new Set(['numberOfRounds']));
    expect(r.confirm).toBe('Switching to Video meeting removes the round settings (1 round × 8 min). Continue?');
  });

  it("a meeting length the member set asks before Speed networking drops it", () => {
    const r = switchFormat({ ...meeting(), durationMinutes: 90 }, 'speed_networking', new Set(['durationMinutes']));
    expect(r.confirm).toBe('Switching to Speed networking removes the video meeting settings (90 min). Continue?');
  });

  it('a chosen capacity the new type cannot hold is replaced, and the member is told (not asked)', () => {
    const rounds = newEventValues({ pod: speedPod as never, scheduledAt: '2026-11-02T10:00' });
    const r = switchFormat({ ...rounds, maxParticipants: 300 }, 'video_meeting', new Set(['maxParticipants']));
    expect(r.confirm).toBeNull();
    expect(r.values.maxParticipants).toBe(25);
    expect(r.notices).toEqual(['Capacity changed to 25 people: a video meeting allows 2 to 100.']);
  });

  it('a chosen capacity both types allow stays', () => {
    const rounds = newEventValues({ pod: speedPod as never, scheduledAt: '2026-11-02T10:00' });
    const r = switchFormat({ ...rounds, maxParticipants: 40 }, 'video_meeting', new Set(['maxParticipants']));
    expect(r.values.maxParticipants).toBe(40);
    expect(r.notices).toEqual([]);
  });

  it('an edit counts every saved setting as chosen, so moving a speed-networking event to a meeting always asks', () => {
    const { values, touched } = editEventValues(
      { title: 'Mixer', description: null, format: 'speed_networking', config: { numberOfRounds: 4, roundDurationSeconds: 600, maxParticipants: 40, timerVisibility: 'always_visible', matchingPolicy: 'none' } },
      '2026-11-02T10:00',
    );
    expect([values.numberOfRounds, values.roundMinutes, values.timerVisibility, values.matchingPolicy, values.maxParticipants])
      .toEqual([4, 10, 'always_visible', 'none', 40]);
    const r = switchFormat(values, 'video_meeting', touched);
    expect(r.confirm).toBe('Switching to Video meeting removes the round settings (4 rounds × 10 min). Continue?');
    expect(r.values.maxParticipants).toBe(40);
  });

  it('an old event with no format column reads its type from config.eventType, as the server does', () => {
    const { values } = editEventValues({ title: 'Old', config: { eventType: 'video_meeting', durationMinutes: 45, maxParticipants: 20 } }, '');
    expect(values.format).toBe('video_meeting');
    expect([values.durationMinutes, values.maxParticipants]).toEqual([45, 20]);
    expect(values.description).toBe('');
  });
});

describe('choosing a pod after the type (the form opened without ?podId=)', () => {
  it('an untouched type follows the pod to its own starting type', () => {
    const v = newEventValues({ pod: null, scheduledAt: '2026-11-02T10:00' });
    expect(podChangeFormat(v.format, reasonPod as never, false)).toEqual({ format: 'video_meeting', notice: null });
  });

  it('a chosen type the pod holds stays', () => {
    expect(podChangeFormat('speed_networking', reasonPod as never, true)).toEqual({ format: 'speed_networking', notice: null });
  });

  it('a chosen type the pod does not hold changes, and the member is told', () => {
    expect(podChangeFormat('speed_networking', chatPod as never, true)).toEqual({
      format: 'video_meeting',
      notice: "Changed to Video meeting: Speed networking isn't available in this pod.",
    });
  });
});

describe('what each field accepts, said at the field', () => {
  it('the title is required, in these words', () => {
    expect(TITLE_REQUIRED).toBe('Give your event a title');
    expect(titleProblem('')).toBe('Give your event a title');
    expect(titleProblem('   ')).toBe('Give your event a title');
    expect(titleProblem('Video meeting · Test')).toBeNull();
    expect(titleProblem('x'.repeat(301))).toBe('Keep the title to 300 characters.');
  });

  it("a setting outside its type's limits says the limits, in the definition's words", () => {
    expect(settingProblem('video_meeting', 'maxParticipants', 500)).toBe('Capacity must be between 2 and 100 people.');
    expect(settingProblem('speed_networking', 'maxParticipants', 500)).toBeNull();
    expect(settingProblem('speed_networking', 'numberOfRounds', 21)).toBe('Number of rounds must be between 1 and 20.');
    expect(settingProblem('speed_networking', 'roundMinutes', 0)).toBe('Round length must be between 1 and 60 minutes.');
  });

  it('a field emptied by the member is said, not silently defaulted', () => {
    expect(settingProblem('speed_networking', 'numberOfRounds', Number.NaN)).toBe('Number of rounds must be a number.');
  });

  it('counts the server keeps whole must be whole; a round may last a minute and a half', () => {
    expect(settingProblem('speed_networking', 'numberOfRounds', 2.5)).toBe('Number of rounds must be a whole number.');
    expect(settingProblem('video_meeting', 'maxParticipants', 10.5)).toBe('Capacity must be a whole number.');
    expect(settingProblem('speed_networking', 'roundMinutes', 1.5)).toBeNull();
  });

  it('a field the chosen type does not have is not checked (it is not sent either)', () => {
    expect(settingProblem('video_meeting', 'numberOfRounds', 999)).toBeNull();
  });
});

describe('what the forms send', () => {
  it("a video meeting sends its type and only its own settings, round length and rounds left out", () => {
    const v = newEventValues({ pod: reasonPod as never, scheduledAt: '2026-11-02T10:00' });
    const body = eventBody({ ...v, description: '  ' }, { isAdmin: false });
    expect(body).toEqual({
      podId: 'pod-1',
      title: 'Video meeting · Test',
      scheduledAt: new Date('2026-11-02T10:00').toISOString(),
      format: 'video_meeting',
      config: { durationMinutes: 60, maxParticipants: 25 },
    });
  });

  it('speed networking sends the matching rule the organiser picked, and the round length in minutes', () => {
    const v = newEventValues({ pod: speedPod as never, scheduledAt: '2026-11-02T10:00' });
    const body = eventBody({ ...v, matchingPolicy: 'platform_wide', roundMinutes: 6 }, { isAdmin: false });
    expect(body.format).toBe('speed_networking');
    expect(body.config).toEqual({
      numberOfRounds: 5, roundMinutes: 6, timerVisibility: 'last_10s', matchingPolicy: 'platform_wide', maxParticipants: 500,
    });
  });

  it('the matching template is an admin pick, and an empty one is never sent (it is stored in a uuid column)', () => {
    const v = newEventValues({ pod: speedPod as never, scheduledAt: '2026-11-02T10:00' });
    expect(eventBody({ ...v, matchingTemplateId: 'tpl-1' }, { isAdmin: false }).config).not.toHaveProperty('matchingTemplateId');
    expect(eventBody({ ...v, matchingTemplateId: 'tpl-1' }, { isAdmin: true }).config.matchingTemplateId).toBe('tpl-1');
    expect(eventBody({ ...v, matchingTemplateId: '' }, { isAdmin: true }).config).not.toHaveProperty('matchingTemplateId');
  });

  it('an edit sends its type every time, its words trimmed, and a description emptied on purpose as empty', () => {
    const { values } = editEventValues({ title: 'Mixer', description: 'Old words', format: 'video_meeting', config: { durationMinutes: 45, maxParticipants: 20 } }, '2026-11-02T10:00');
    const body = eventChanges({ ...values, title: '  Mixer two ', description: '' }, { isAdmin: false });
    expect(body).toEqual({
      title: 'Mixer two',
      description: '',
      scheduledAt: new Date('2026-11-02T10:00').toISOString(),
      format: 'video_meeting',
      config: { durationMinutes: 45, maxParticipants: 20 },
    });
  });

  it('an edit of an event with no date leaves the date out rather than sending an empty one', () => {
    const { values } = editEventValues({ title: 'Copy', format: 'video_meeting', config: {} }, '');
    expect(eventChanges(values, { isAdmin: false })).not.toHaveProperty('scheduledAt');
  });
});

describe('a refusal from the server lands at its field: both shapes', () => {
  it('the validation shape (paths, zod words) gets our own words at each field, never the zod text', () => {
    const err = refused(400, {
      code: 'VALIDATION_ERROR', message: 'Validation failed',
      details: { title: ['String must contain at least 1 character(s)'], 'config.numberOfRounds': ['Expected integer, received float'], 'config.maxParticipants': ['Number must be less than or equal to 10000'] },
    });
    expect(eventProblems(err, 'speed_networking', CREATE_COPY)).toEqual({
      fields: {
        title: 'Give your event a title',
        numberOfRounds: 'Number of rounds must be a whole number.',
        maxParticipants: 'Capacity must be between 2 and 10000 people.',
      },
      form: null,
    });
  });

  it('a stored setting the zod shape names lands at the field the form shows (round seconds at the round length)', () => {
    const err = refused(400, { code: 'VALIDATION_ERROR', message: 'Validation failed', details: { 'config.roundDurationSeconds': ['Number must be greater than or equal to 60'] } });
    expect(eventProblems(err, 'speed_networking', CREATE_COPY).fields).toEqual({ roundMinutes: 'Round length must be between 1 and 60 minutes.' });
  });

  it('a title too long, a date and the event type each get their own sentence', () => {
    const err = refused(400, {
      code: 'VALIDATION_ERROR', message: 'Validation failed',
      details: { title: ['String must contain at most 300 character(s)'], scheduledAt: ['Invalid datetime'], format: ["Invalid enum value. Expected 'speed_networking' | 'video_meeting'"] },
    });
    expect(eventProblems(err, 'video_meeting', CREATE_COPY).fields).toEqual({
      title: 'Keep the title to 300 characters.',
      scheduledAt: 'Choose a date and time.',
      format: 'Choose an event type.',
    });
  });

  it("the service's range shape (bare field names, the definition's sentence) is shown as the server said it", () => {
    const err = refused(400, {
      code: 'VALIDATION_ERROR', message: 'Round length must be between 1 and 60 minutes.',
      details: { roundMinutes: ['Round length must be between 1 and 60 minutes.'] },
    });
    expect(eventProblems(err, 'speed_networking', CREATE_COPY)).toEqual({
      fields: { roundMinutes: 'Round length must be between 1 and 60 minutes.' }, form: null,
    });
    const meetingErr = refused(400, {
      code: 'VALIDATION_ERROR', message: 'Length must be between 15 and 240 minutes.',
      details: { durationMinutes: ['Length must be between 15 and 240 minutes.'], maxParticipants: ['Capacity must be between 2 and 100 people.'] },
    });
    expect(eventProblems(meetingErr, 'video_meeting', CREATE_COPY).fields).toEqual({
      durationMinutes: 'Length must be between 15 and 240 minutes.', maxParticipants: 'Capacity must be between 2 and 100 people.',
    });
  });

  it('a type the pod does not hold lands at the event type, in the server\'s sentence', () => {
    const sentence = "Speed networking isn't available in Chat pods. Choose Video meeting.";
    const err = refused(400, { code: 'EVENT_FORMAT_NOT_ALLOWED', message: sentence, details: { format: [sentence] } });
    expect(eventProblems(err, 'speed_networking', CREATE_COPY)).toEqual({ fields: { format: sentence }, form: null });
  });

  it('a refusal with no field goes beside the button, in words about events (the server says "sessions")', () => {
    expect(eventProblems(refused(403, { code: 'AUTH_FORBIDDEN', message: 'Only pod directors and hosts can create sessions' }), 'video_meeting', CREATE_COPY))
      .toEqual({ fields: {}, form: "Only the pod's director or a host can schedule events in this pod." });
    expect(eventProblems(refused(404, { code: 'POD_NOT_FOUND', message: 'Pod with id 3f2b8a4e-1c9d-4e7a-b6f0-2a5c8d1e9f03 not found' }), 'video_meeting', CREATE_COPY).form)
      .toBe('This pod could not be found. It may have been archived.');
    expect(eventProblems(refused(500, { code: 'INTERNAL_ERROR', message: 'boom' }), 'video_meeting', CREATE_COPY).form).toBe(CREATE_COPY.fallback);
    expect(eventProblems(refused(429, { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests. Please try again later.' }), 'video_meeting', CREATE_COPY).form)
      .toBe('Slow down a moment, then try again.');
  });

  it('an event that has started says so (edit)', () => {
    const copy = { ...CREATE_COPY, started: 'This event has started, so it can no longer be changed.' };
    expect(eventProblems(refused(400, { code: 'SESSION_ALREADY_STARTED', message: 'Cannot update an event that has already started' }), 'video_meeting', copy).form)
      .toBe('This event has started, so it can no longer be changed.');
  });

  it('no answer at all is the connection', () => {
    expect(eventProblems(noAnswer, 'video_meeting', CREATE_COPY)).toEqual({ fields: {}, form: CONNECTION_LOST });
  });

  it('a validation refusal naming nothing the form shows still says something beside the button', () => {
    const err = refused(400, { code: 'VALIDATION_ERROR', message: 'Validation failed', details: { 'config.lobbyDurationSeconds': ['Expected number, received string'] } });
    expect(eventProblems(err, 'video_meeting', CREATE_COPY)).toEqual({ fields: {}, form: "Check the event's settings and try again." });
  });
});

describe('the summary beside the button', () => {
  it('"Fix 1 thing: Title", the fields in the order the form shows them', () => {
    expect(problemSummary(['title'], 'video_meeting')).toEqual({ lead: 'Fix 1 thing:', items: [{ key: 'title', label: 'Title' }] });
    expect(problemSummary(['maxParticipants', 'title', 'format'], 'video_meeting')).toEqual({
      lead: 'Fix 3 things:',
      items: [{ key: 'format', label: 'Event type' }, { key: 'title', label: 'Title' }, { key: 'maxParticipants', label: 'Capacity' }],
    });
    expect(problemSummary(['roundMinutes', 'scheduledAt'], 'speed_networking')?.items.map((i) => i.label)).toEqual(['Date and time', 'Round length']);
  });

  it('nothing to fix, no summary', () => {
    expect(problemSummary([], 'video_meeting')).toBeNull();
  });
});

describe("the event page's facts follow the type", () => {
  it('"Video meeting · 60 min · up to 25"', () => {
    expect(eventFactsLine('video_meeting', { durationMinutes: 60, maxParticipants: 25, eventType: 'video_meeting' })).toBe('Video meeting · 60 min · up to 25');
    expect(eventFacts('video_meeting', { durationMinutes: 90, maxParticipants: 12 })).toEqual([
      { key: 'durationMinutes', value: '90 min', caption: 'length' },
      { key: 'maxParticipants', value: '12', caption: 'max capacity' },
    ]);
  });

  it('"Speed networking · 5 rounds × 8 min · up to 500", from the stored seconds', () => {
    expect(eventFactsLine('speed_networking', { numberOfRounds: 5, roundDurationSeconds: 480, maxParticipants: 500 })).toBe('Speed networking · 5 rounds × 8 min · up to 500');
    expect(eventFacts('speed_networking', { numberOfRounds: 3, roundDurationSeconds: 300, maxParticipants: 40 })).toEqual([
      { key: 'numberOfRounds', value: '3', caption: 'rounds' },
      { key: 'roundMinutes', value: '5m', caption: 'per round' },
      { key: 'maxParticipants', value: '40', caption: 'max capacity' },
    ]);
  });

  it('a setting never stored reads as its default', () => {
    expect(eventFactsLine('speed_networking', {})).toBe('Speed networking · 5 rounds × 8 min · up to 500');
    expect(eventFactsLine('video_meeting', null)).toBe('Video meeting · 60 min · up to 25');
  });
});

describe('the meeting length choices', () => {
  it("are the presets inside the type's limits", () => {
    expect(lengthOptions('video_meeting').map((o) => o.value)).toEqual([15, 30, 45, 60, 90, 120, 180, 240]);
    expect(lengthOptions('video_meeting')[3]).toEqual({ value: 60, label: '60 min' });
  });

  it('a stored length that is not a preset is kept as a choice, so the form shows the truth', () => {
    expect(lengthOptions('video_meeting', 75).map((o) => o.value)).toEqual([15, 30, 45, 60, 75, 90, 120, 180, 240]);
  });
});
