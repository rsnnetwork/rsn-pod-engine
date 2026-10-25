// ─── An event's format is stored, checked against the pod and runs as itself (26 Oct 2026) ───────
//
// 25 Oct walkthrough (production, event fccadc3e): the old form posted config.eventType "video_meeting" and
// the server stored it beside five 8-minute rounds and ran a speed-networking event. Now:
//   - sessions.event_format (migration 111) holds the format, returned as `format`;
//   - an explicit `format` must be one the pod's type holds and offered, and its settings within limits;
//   - production's old form (no `format`) keeps working: an offered legacy config.eventType is honoured with
//     no pod check (option O1), anything else is speed networking exactly as before;
//   - the stored config is the format's own (a meeting keeps no round settings) and says its format;
//   - a meeting's LiveKit token lives as long as the meeting, not as long as five rounds;
//   - a platform admin can no longer cancel a live event through DELETE (a super_admin still can).

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: jest.fn(),
  __esModule: true,
}));

jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

const mockGetPodById = jest.fn();
const mockGetMemberRole = jest.fn();
jest.mock('../../../services/pod/pod.service', () => ({
  getPodById: (...args: unknown[]) => mockGetPodById(...args),
  getMemberRole: (...args: unknown[]) => mockGetMemberRole(...args),
  __esModule: true,
}));

import { DEFAULT_SESSION_CONFIG, PodType, UserRole, POD_TYPES } from '@rsn/shared';
import {
  createSession, updateSession, deleteSession, getSessionById, listSessions, livekitTokenTtlSeconds,
} from '../../../services/session/session.service';
import { buildSessionCalendarEvent } from '../../../services/calendar/calendar.service';

const POD_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const DIRECTOR = 'user-director';

function pod(podType: PodType) {
  return { id: POD_ID, name: 'Test', podType, orchestrationMode: 'free_form' };
}

/** Every query answers with one row: the INSERT/UPDATE ... RETURNING echoes a session row. */
function answerWith(row: Record<string, unknown> = { id: SESSION_ID, podId: POD_ID }) {
  mockQuery.mockResolvedValue({ rows: [row], rowCount: 1 });
}

function sessionInsert() {
  const call = mockQuery.mock.calls.find(([sql]) => /INSERT INTO sessions/.test(sql as string));
  if (!call) throw new Error('no INSERT INTO sessions was made');
  const [sql, params] = call as [string, unknown[]];
  return { sql, format: params[7], config: JSON.parse(params[5] as string) };
}

function sessionUpdate() {
  const call = mockQuery.mock.calls.find(([sql]) => /UPDATE sessions SET/.test(sql as string));
  return call as [string, unknown[]] | undefined;
}

const base = { podId: POD_ID, title: 'test', scheduledAt: '2026-11-01T12:00:00.000Z' };

beforeEach(() => {
  mockQuery.mockReset();
  mockGetPodById.mockReset();
  mockGetMemberRole.mockReset();
  mockGetMemberRole.mockResolvedValue('director');
});

describe('createSession with an explicit format', () => {
  it('stores a video meeting in a Reason pod with a meeting config and no round settings', async () => {
    mockGetPodById.mockResolvedValue(pod(PodType.REASON));
    answerWith();
    await createSession(DIRECTOR, { ...base, format: 'video_meeting', config: { durationMinutes: 90, maxParticipants: 8 } });
    const insert = sessionInsert();
    expect(insert.sql).toMatch(/event_format/);
    expect(insert.format).toBe('video_meeting');
    expect(insert.config).toEqual({ durationMinutes: 90, maxParticipants: 8, eventType: 'video_meeting' });
  });

  it('refuses a format the pod type does not hold: 400 EVENT_FORMAT_NOT_ALLOWED, nothing written', async () => {
    mockGetPodById.mockResolvedValue(pod(PodType.CHAT));
    answerWith();
    await expect(createSession(DIRECTOR, { ...base, format: 'speed_networking' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'EVENT_FORMAT_NOT_ALLOWED',
      message: "Speed networking isn't available in Chat pods. Choose Video meeting.",
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('refuses a format that is not offered yet, even where the pod type will hold it', async () => {
    mockGetPodById.mockResolvedValue(pod(PodType.WEBINAR));
    answerWith();
    await expect(createSession(DIRECTOR, { ...base, format: 'webinar' })).rejects.toMatchObject({
      statusCode: 400, code: 'EVENT_FORMAT_NOT_ALLOWED', message: "Webinar isn't offered yet.",
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('refuses settings outside the format’s limits, at the field', async () => {
    mockGetPodById.mockResolvedValue(pod(PodType.REASON));
    answerWith();
    await expect(createSession(DIRECTOR, { ...base, format: 'video_meeting', config: { maxParticipants: 500 } }))
      .rejects.toMatchObject({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        details: { maxParticipants: ['Capacity must be between 2 and 100 people.'] },
      });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('stores an explicit speed-networking event with the engine defaults, round length given in minutes', async () => {
    mockGetPodById.mockResolvedValue(pod(PodType.REASON));
    answerWith();
    await createSession(DIRECTOR, { ...base, format: 'speed_networking', config: { numberOfRounds: 3, roundMinutes: 4 } });
    const insert = sessionInsert();
    expect(insert.format).toBe('speed_networking');
    expect(insert.config).toEqual({
      ...DEFAULT_SESSION_CONFIG, numberOfRounds: 3, roundDurationSeconds: 240, eventType: 'speed_networking',
    });
  });
});

describe("createSession from production's old form (no format)", () => {
  it('stores the old form’s video meeting as a video meeting, with no pod check and no limit check (O1)', async () => {
    // Make the pod type refuse video meetings, to show the legacy path never asks it.
    jest.replaceProperty(POD_TYPES[PodType.CHAT], 'events', { default: 'speed_networking', allowed: ['speed_networking'] });
    mockGetPodById.mockResolvedValue(pod(PodType.CHAT));
    answerWith();
    const oldFormConfig = {
      eventType: 'video_meeting', numberOfRounds: 5, roundDurationSeconds: 480, maxParticipants: 500,
      timerVisibility: 'always_visible' as const, matchingPolicy: 'within_event' as const,
    };
    await createSession(DIRECTOR, { ...base, config: oldFormConfig });
    const insert = sessionInsert();
    expect(insert.format).toBe('video_meeting');
    expect(insert.config).toEqual({ durationMinutes: 60, maxParticipants: 500, eventType: 'video_meeting' });

    // The same choice made explicitly is checked against the pod type.
    mockQuery.mockClear();
    await expect(createSession(DIRECTOR, { ...base, format: 'video_meeting' }))
      .rejects.toMatchObject({ code: 'EVENT_FORMAT_NOT_ALLOWED' });
  });

  it('keeps speed-networking defaults exactly as before, adding only the format it now names', async () => {
    mockGetPodById.mockResolvedValue(pod(PodType.SPEED_NETWORKING));
    answerWith();
    const config = { eventType: 'speed_networking', numberOfRounds: 4, roundDurationSeconds: 300, ratingWindowSeconds: 20 };
    await createSession(DIRECTOR, { ...base, config });
    const insert = sessionInsert();
    expect(insert.format).toBe('speed_networking');
    expect(insert.config).toEqual({ ...DEFAULT_SESSION_CONFIG, ...config });
  });

  it('runs a legacy format that is not offered (webinar) as speed networking', async () => {
    mockGetPodById.mockResolvedValue(pod(PodType.WEBINAR));
    answerWith();
    await createSession(DIRECTOR, { ...base, config: { eventType: 'webinar' } });
    const insert = sessionInsert();
    expect(insert.format).toBe('speed_networking');
    expect(insert.config).toEqual({ ...DEFAULT_SESSION_CONFIG, eventType: 'speed_networking' });
  });

  // Fix round 1 (26 Oct review): the two settings only the new forms send are checked on this path too.
  it('refuses a round length in minutes below the limit, at the field, and writes nothing', async () => {
    mockGetPodById.mockResolvedValue(pod(PodType.SPEED_NETWORKING));
    answerWith();
    await expect(createSession(DIRECTOR, { ...base, config: { roundMinutes: 0.001 } })).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Round length must be between 1 and 60 minutes.',
      details: { roundMinutes: ['Round length must be between 1 and 60 minutes.'] },
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('refuses a 24-hour meeting from the old body, at the field, and writes nothing', async () => {
    mockGetPodById.mockResolvedValue(pod(PodType.REASON));
    answerWith();
    await expect(createSession(DIRECTOR, { ...base, config: { eventType: 'video_meeting', durationMinutes: 1440 } }))
      .rejects.toMatchObject({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Length must be between 15 and 240 minutes.',
        details: { durationMinutes: ['Length must be between 15 and 240 minutes.'] },
      });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('never stores a meeting length on a speed-networking event (it is not one of its settings)', async () => {
    mockGetPodById.mockResolvedValue(pod(PodType.SPEED_NETWORKING));
    answerWith();
    await createSession(DIRECTOR, { ...base, config: { durationMinutes: 1440 } });
    const insert = sessionInsert();
    expect(insert.format).toBe('speed_networking');
    expect(insert.config).not.toHaveProperty('durationMinutes');
    expect(insert.config).toEqual({ ...DEFAULT_SESSION_CONFIG, eventType: 'speed_networking' });
  });

  it('runs an event with no format and no config as speed networking with the defaults', async () => {
    mockGetPodById.mockResolvedValue(pod(PodType.SPEED_NETWORKING));
    answerWith();
    await createSession(DIRECTOR, base);
    const insert = sessionInsert();
    expect(insert.format).toBe('speed_networking');
    expect(insert.config).toEqual({ ...DEFAULT_SESSION_CONFIG, eventType: 'speed_networking' });
  });
});

describe('updateSession', () => {
  const scheduledMeeting = {
    id: SESSION_ID, podId: POD_ID, status: 'scheduled', hostUserId: DIRECTOR, format: 'video_meeting',
    config: { durationMinutes: 90, maxParticipants: 10, eventType: 'video_meeting' },
  };
  const scheduledSpeed = {
    id: SESSION_ID, podId: POD_ID, status: 'scheduled', hostUserId: DIRECTOR, format: 'speed_networking',
    config: { ...DEFAULT_SESSION_CONFIG, eventType: 'speed_networking' },
  };

  it('keeps a meeting a meeting when the old edit form sends round settings (no format)', async () => {
    answerWith(scheduledMeeting);
    await updateSession(SESSION_ID, DIRECTOR, { config: { numberOfRounds: 3, roundDurationSeconds: 300, maxParticipants: 30 } });
    const [sql, values] = sessionUpdate()!;
    expect(sql).not.toMatch(/event_format = /);
    const configParam = values.find((v) => typeof v === 'string' && v.startsWith('{')) as string;
    expect(JSON.parse(configParam)).toEqual({ durationMinutes: 90, maxParticipants: 30, eventType: 'video_meeting' });
  });

  it('switches a scheduled event to another format its pod holds, starting from that format’s defaults', async () => {
    answerWith(scheduledSpeed);
    mockGetPodById.mockResolvedValue(pod(PodType.REASON));
    await updateSession(SESSION_ID, DIRECTOR, { format: 'video_meeting', config: { durationMinutes: 45 } });
    const [sql, values] = sessionUpdate()!;
    expect(sql).toMatch(/event_format = \$\d+/);
    expect(values).toContain('video_meeting');
    const configParam = values.find((v) => typeof v === 'string' && v.startsWith('{')) as string;
    expect(JSON.parse(configParam)).toEqual({ durationMinutes: 45, maxParticipants: 25, eventType: 'video_meeting' });
  });

  it('refuses a switch to a format the pod does not hold', async () => {
    answerWith(scheduledMeeting);
    mockGetPodById.mockResolvedValue(pod(PodType.CHAT));
    await expect(updateSession(SESSION_ID, DIRECTOR, { format: 'speed_networking' }))
      .rejects.toMatchObject({ statusCode: 400, code: 'EVENT_FORMAT_NOT_ALLOWED' });
    expect(sessionUpdate()).toBeUndefined();
  });

  it('lets an event keep its format even if its pod type has since changed', async () => {
    answerWith(scheduledSpeed);
    mockGetPodById.mockResolvedValue(pod(PodType.CHAT));
    await updateSession(SESSION_ID, DIRECTOR, { format: 'speed_networking', title: 'Renamed' });
    expect(sessionUpdate()).toBeDefined();
    expect(mockGetPodById).not.toHaveBeenCalled();
  });

  it('refuses a meeting length beyond the limit sent without a format, and changes nothing', async () => {
    answerWith(scheduledMeeting);
    await expect(updateSession(SESSION_ID, DIRECTOR, { config: { durationMinutes: 1440 } }))
      .rejects.toMatchObject({ statusCode: 400, details: { durationMinutes: ['Length must be between 15 and 240 minutes.'] } });
    expect(sessionUpdate()).toBeUndefined();
  });

  it('refuses an explicit meeting capacity beyond the meeting’s limit', async () => {
    answerWith(scheduledMeeting);
    await expect(updateSession(SESSION_ID, DIRECTOR, { format: 'video_meeting', config: { maxParticipants: 300 } }))
      .rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    expect(sessionUpdate()).toBeUndefined();
  });

  it('still refuses any change once the event has started', async () => {
    answerWith({ ...scheduledMeeting, status: 'lobby_open' });
    await expect(updateSession(SESSION_ID, DIRECTOR, { format: 'speed_networking' }))
      .rejects.toMatchObject({ code: 'SESSION_ALREADY_STARTED' });
  });
});

describe('reads return the format', () => {
  it('getSessionById selects event_format as format', async () => {
    answerWith({ id: SESSION_ID, format: 'video_meeting' });
    await getSessionById(SESSION_ID);
    expect(mockQuery.mock.calls[0][0]).toMatch(/event_format AS "format"/);
  });

  it('the events list selects it too', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }).mockResolvedValueOnce({ rows: [] });
    await listSessions({ isAdmin: true });
    expect(mockQuery.mock.calls[1][0]).toMatch(/s\.event_format AS "format"/);
  });
});

describe('livekitTokenTtlSeconds', () => {
  it('lets a 90-minute meeting keep its token for at least the 90 minutes', () => {
    const ttl = livekitTokenTtlSeconds({ format: 'video_meeting', config: { durationMinutes: 90 } as never, currentRound: 0, startedAt: null });
    expect(ttl).toBeGreaterThanOrEqual(90 * 60);
  });

  it('counts a running meeting’s remaining time, never below the 30-minute floor', () => {
    const startedAt = new Date(Date.now() - 80 * 60_000);
    const ttl = livekitTokenTtlSeconds({ format: 'video_meeting', config: { durationMinutes: 90 } as never, currentRound: 0, startedAt });
    expect(ttl).toBe(1800);
  });

  it('keeps the speed-networking formula exactly as before (rounds left × (round + rating + 30) + 10 min)', () => {
    expect(livekitTokenTtlSeconds({ format: 'speed_networking', config: { ...DEFAULT_SESSION_CONFIG }, currentRound: 0, startedAt: null }))
      .toBe(5 * (480 + 30 + 30) + 600);
    expect(livekitTokenTtlSeconds({ format: 'speed_networking', config: { ...DEFAULT_SESSION_CONFIG }, currentRound: 4, startedAt: null }))
      .toBe(1800);
  });
});

describe('deleteSession refuses a live event unless a super_admin asks', () => {
  const live = { id: SESSION_ID, podId: POD_ID, status: 'lobby_open', hostUserId: DIRECTOR };

  it('an admin gets 409 for a live event, and nothing is cancelled', async () => {
    answerWith(live);
    await expect(deleteSession(SESSION_ID, 'user-admin', UserRole.ADMIN)).rejects.toMatchObject({ statusCode: 409 });
    expect(mockQuery.mock.calls.some(([sql]) => /status = 'cancelled'/.test(sql as string))).toBe(false);
  });

  it('a super_admin may still cancel it', async () => {
    answerWith(live);
    await deleteSession(SESSION_ID, 'user-super', UserRole.SUPER_ADMIN);
    expect(mockQuery.mock.calls.some(([sql]) => /status = 'cancelled'/.test(sql as string))).toBe(true);
  });

  it('an admin may still delete a scheduled event', async () => {
    answerWith({ ...live, status: 'scheduled' });
    await deleteSession(SESSION_ID, 'user-admin', UserRole.ADMIN);
    expect(mockQuery.mock.calls.some(([sql]) => /status = 'cancelled'/.test(sql as string))).toBe(true);
  });

  it('the host who is not an admin keeps the old 400 for an event in progress', async () => {
    answerWith(live);
    await expect(deleteSession(SESSION_ID, DIRECTOR, UserRole.MEMBER))
      .rejects.toMatchObject({ statusCode: 400, code: 'SESSION_IN_PROGRESS' });
  });
});

describe('a meeting’s calendar entry is as long as the meeting', () => {
  it('buildSessionCalendarEvent uses the meeting length', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{
        title: 'Video meeting · Test', scheduled_at: '2026-11-01T12:00:00.000Z', host_user_id: DIRECTOR,
        config: { durationMinutes: 90, eventType: 'video_meeting' }, event_format: 'video_meeting',
      }] })
      .mockResolvedValueOnce({ rows: [{ display_name: 'Claus', email: 'c@example.com' }] });
    const ev = await buildSessionCalendarEvent(SESSION_ID);
    expect(ev!.durationMinutes).toBe(90);
    expect(mockQuery.mock.calls[0][0]).toMatch(/event_format/);
  });
});
