// ─── In-person events and speed-networking presets, on create and edit (30 Oct 2026, T12) ─────────
//
// "Physical (in-person) meeting" and "Speed networking types, e.g. founders and investors, job-related":
//   - an in-person event needs its place (config.location, trimmed, at most 300 characters): without one the server
//     answers 400 with a sentence at the field, on the new form's path and on production's old path (config only);
//   - production's form never offers In person, but production's duplicate button (config only) still copies one;
//     a row from before 26 Oct tagged physical_event with no place copies as the speed networking it ran as;
//   - matchingTemplateId must be the id of a template that exists: a preset for anyone, any template for an admin.
//     A value that is not a UUID is refused at the field and never reaches the engine's template read.

const mockQuery = jest.fn();
jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: jest.fn(),
  __esModule: true,
}));

// Every person registered here is a member: the event-guest check (guest-registration.ts) has its own tests.
jest.mock('../../../services/session/guest-registration', () => ({
  ...jest.requireActual('../../../services/session/guest-registration'),
  assertGuestMayRegister: jest.fn(async () => ({ isGuest: false })),
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

import { PodType, UserRole, MATCHING_PRESET_IDS } from '@rsn/shared';
import { createSession, updateSession, generateLiveKitToken, registerParticipant } from '../../../services/session/session.service';

const POD_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN_TEMPLATE = '33333333-3333-4333-8333-333333333333';
const GONE_TEMPLATE = '44444444-4444-4444-8444-444444444444';
const DIRECTOR = 'user-director';

const base = { podId: POD_ID, title: 'Dinner', scheduledAt: '2026-11-20T19:00:00.000Z' };

function pod(podType: PodType) {
  return { id: POD_ID, name: 'Test', status: 'active', podType, orchestrationMode: 'free_form' };
}

/** The templates that exist: the four presets and one admin template. */
function answer(sessionRow: Record<string, unknown> = { id: SESSION_ID, podId: POD_ID }) {
  mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (/FROM matching_templates WHERE id = \$1/.test(sql)) {
      const id = params[0] as string;
      if (Object.values(MATCHING_PRESET_IDS).includes(id as never)) return { rows: [{ is_preset: true }], rowCount: 1 };
      if (id === ADMIN_TEMPLATE) return { rows: [{ is_preset: false }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
    return { rows: [sessionRow], rowCount: 1 };
  });
}

function inserted() {
  const call = mockQuery.mock.calls.find(([sql]) => /INSERT INTO sessions/.test(sql as string));
  if (!call) throw new Error('no INSERT INTO sessions was made');
  const params = call[1] as unknown[];
  return { format: params[7], config: JSON.parse(params[5] as string) };
}

const wrote = () => mockQuery.mock.calls.some(([sql]) => /^\s*(INSERT INTO sessions|UPDATE sessions)/.test(sql as string));

beforeEach(() => {
  mockQuery.mockReset();
  mockGetPodById.mockReset();
  mockGetMemberRole.mockReset();
  mockGetMemberRole.mockResolvedValue('director');
});

describe('creating an in-person event (the new form, format sent)', () => {
  it('stores it with its place trimmed, its length and capacity', async () => {
    mockGetPodById.mockResolvedValue(pod(PodType.REASON));
    answer();
    await createSession(DIRECTOR, {
      ...base, format: 'physical_event', config: { location: '  The Ivy, 1-5 West St  ', durationMinutes: 180, maxParticipants: 40 },
    });
    expect(inserted()).toEqual({
      format: 'physical_event',
      config: { location: 'The Ivy, 1-5 West St', durationMinutes: 180, maxParticipants: 40, eventType: 'physical_event' },
    });
  });

  it.each([
    ['no place', {}],
    ['an empty place', { location: '' }],
    ['a place of spaces', { location: '    ' }],
  ])('refuses %s with 400 and a sentence at Where, writing nothing', async (_label, config) => {
    mockGetPodById.mockResolvedValue(pod(PodType.REASON));
    answer();
    await expect(createSession(DIRECTOR, { ...base, format: 'physical_event', config })).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Say where the event happens: an address or a venue.',
      details: { location: ['Say where the event happens: an address or a venue.'] },
    });
    expect(wrote()).toBe(false);
  });

  it('refuses a place over 300 characters, and a length over eight hours', async () => {
    mockGetPodById.mockResolvedValue(pod(PodType.REASON));
    answer();
    await expect(createSession(DIRECTOR, { ...base, format: 'physical_event', config: { location: 'x'.repeat(301) } }))
      .rejects.toMatchObject({ statusCode: 400, details: { location: ['Where must be 300 characters or fewer.'] } });
    await expect(createSession(DIRECTOR, { ...base, format: 'physical_event', config: { location: 'Soho', durationMinutes: 481 } }))
      .rejects.toMatchObject({ statusCode: 400, details: { durationMinutes: ['Length must be between 15 and 480 minutes.'] } });
    expect(wrote()).toBe(false);
  });

  it('is refused in a Chat or Webinar pod, with the way out', async () => {
    mockGetPodById.mockResolvedValue(pod(PodType.CHAT));
    answer();
    await expect(createSession(DIRECTOR, { ...base, format: 'physical_event', config: { location: 'Soho' } })).rejects.toMatchObject({
      statusCode: 400, code: 'EVENT_FORMAT_NOT_ALLOWED', message: "In person isn't available in Chat pods. Choose Video meeting.",
    });
    expect(wrote()).toBe(false);
  });
});

describe("production's old path (config only, no format)", () => {
  it('duplicating an in-person event copies it in person, place and all', async () => {
    mockGetPodById.mockResolvedValue(pod(PodType.REASON));
    answer();
    // Exactly what origin/main's duplicate button posts: the source event's stored config.
    await createSession(DIRECTOR, {
      ...base, title: 'Dinner (copy)', description: '', scheduledAt: null as unknown as string,
      config: { location: 'The Ivy', durationMinutes: 120, maxParticipants: 25, eventType: 'physical_event' },
    });
    expect(inserted()).toEqual({
      format: 'physical_event',
      config: { location: 'The Ivy', durationMinutes: 120, maxParticipants: 25, eventType: 'physical_event' },
    });
  });

  it('duplicating a row from before 26 Oct tagged physical_event with no place copies the speed networking it ran as', async () => {
    mockGetPodById.mockResolvedValue(pod(PodType.REASON));
    answer();
    await createSession(DIRECTOR, {
      ...base, scheduledAt: null as unknown as string,
      config: { eventType: 'physical_event', numberOfRounds: 5, roundDurationSeconds: 480, maxParticipants: 500 },
    });
    const { format, config } = inserted();
    expect(format).toBe('speed_networking');
    expect(config).toMatchObject({ eventType: 'speed_networking', numberOfRounds: 5 });
    expect(config).not.toHaveProperty('location');
  });

  it('a place over 300 characters is refused on this path too', async () => {
    mockGetPodById.mockResolvedValue(pod(PodType.REASON));
    answer();
    await expect(createSession(DIRECTOR, {
      ...base, config: { eventType: 'physical_event', location: 'x'.repeat(301) },
    })).rejects.toMatchObject({ statusCode: 400, details: { location: ['Where must be 300 characters or fewer.'] } });
    expect(wrote()).toBe(false);
  });

  it("production's 26 Oct form body (a video meeting with its format) is stored as before", async () => {
    mockGetPodById.mockResolvedValue(pod(PodType.REASON));
    answer();
    await createSession(DIRECTOR, {
      ...base, format: 'video_meeting', config: { eventType: 'video_meeting', durationMinutes: 60, maxParticipants: 25 },
    });
    expect(inserted()).toEqual({ format: 'video_meeting', config: { durationMinutes: 60, maxParticipants: 25, eventType: 'video_meeting' } });
  });
});

describe('editing an in-person event', () => {
  const stored = {
    id: SESSION_ID, podId: POD_ID, status: 'scheduled', hostUserId: DIRECTOR, format: 'physical_event',
    config: { location: 'Soho', durationMinutes: 60, maxParticipants: 25, eventType: 'physical_event' },
  };

  it('keeps its place when an edit does not send one (production\'s edit form)', async () => {
    answer(stored);
    await updateSession(SESSION_ID, DIRECTOR, { config: { maxParticipants: 30 } });
    const call = mockQuery.mock.calls.find(([sql]) => /UPDATE sessions SET/.test(sql as string))!;
    expect(JSON.parse((call[1] as unknown[]).find((v) => typeof v === 'string' && v.startsWith('{')) as string))
      .toEqual({ location: 'Soho', durationMinutes: 60, maxParticipants: 30, eventType: 'physical_event' });
  });

  it('refuses clearing the place on the new form', async () => {
    answer(stored);
    await expect(updateSession(SESSION_ID, DIRECTOR, { format: 'physical_event', config: { location: '  ' } }))
      .rejects.toMatchObject({ statusCode: 400, details: { location: ['Say where the event happens: an address or a venue.'] } });
    expect(mockQuery.mock.calls.some(([sql]) => /UPDATE sessions SET/.test(sql as string))).toBe(false);
  });

  it('a switch to In person needs a place', async () => {
    answer({ ...stored, format: 'video_meeting', config: { durationMinutes: 60, maxParticipants: 25, eventType: 'video_meeting' } });
    mockGetPodById.mockResolvedValue(pod(PodType.REASON));
    await expect(updateSession(SESSION_ID, DIRECTOR, { format: 'physical_event', config: { durationMinutes: 60 } }))
      .rejects.toMatchObject({ statusCode: 400, details: { location: ['Say where the event happens: an address or a venue.'] } });
  });
});

describe('who should meet whom: the template id is checked', () => {
  const speed = (matchingTemplateId: string) => ({ ...base, format: 'speed_networking' as const, config: { matchingTemplateId } });

  it.each(Object.entries(MATCHING_PRESET_IDS))('any organiser may choose the %s preset', async (_key, id) => {
    mockGetPodById.mockResolvedValue(pod(PodType.SPEED_NETWORKING));
    answer();
    await createSession(DIRECTOR, speed(id));
    expect(inserted().config.matchingTemplateId).toBe(id);
  });

  it('a template that is not a preset is refused for a director (403 at the field) and allowed for an admin', async () => {
    mockGetPodById.mockResolvedValue(pod(PodType.SPEED_NETWORKING));
    answer();
    await expect(createSession(DIRECTOR, speed(ADMIN_TEMPLATE), UserRole.MEMBER)).rejects.toMatchObject({
      statusCode: 403,
      details: { matchingTemplateId: ['Only platform admins can choose that matching template. Choose one of the presets.'] },
    });
    expect(wrote()).toBe(false);
    await createSession('admin-user', speed(ADMIN_TEMPLATE), UserRole.ADMIN);
    expect(inserted().config.matchingTemplateId).toBe(ADMIN_TEMPLATE);
  });

  it('an id that is not a UUID is refused at the field before any template is read', async () => {
    mockGetPodById.mockResolvedValue(pod(PodType.SPEED_NETWORKING));
    answer();
    await expect(createSession('admin-user', speed('investor-day'), UserRole.ADMIN)).rejects.toMatchObject({
      statusCode: 400,
      details: { matchingTemplateId: ['Choose who should meet whom from the list.'] },
    });
    expect(mockQuery.mock.calls.some(([sql]) => /matching_templates/.test(sql as string))).toBe(false);
    expect(wrote()).toBe(false);
  });

  it('an id of no template is refused at the field', async () => {
    mockGetPodById.mockResolvedValue(pod(PodType.SPEED_NETWORKING));
    answer();
    await expect(createSession('admin-user', speed(GONE_TEMPLATE), UserRole.ADMIN)).rejects.toMatchObject({
      statusCode: 400,
      details: { matchingTemplateId: ["That matching choice doesn't exist any more. Choose another."] },
    });
    expect(wrote()).toBe(false);
  });

  it('an edit that keeps a stored id, even one that is not a UUID (stored before ids were checked), is not refused', async () => {
    answer({
      id: SESSION_ID, podId: POD_ID, status: 'scheduled', hostUserId: DIRECTOR, format: 'speed_networking',
      config: { numberOfRounds: 5, matchingTemplateId: 'investor-day', eventType: 'speed_networking' },
    });
    await updateSession(SESSION_ID, DIRECTOR, { title: 'Renamed', config: { numberOfRounds: 4 } });
    await updateSession(SESSION_ID, DIRECTOR, { config: { matchingTemplateId: 'investor-day' } });
    expect(mockQuery.mock.calls.some(([sql]) => /matching_templates/.test(sql as string))).toBe(false);
  });

  it('an edit to a template that is not a preset is refused for the host who is not an admin', async () => {
    answer({
      id: SESSION_ID, podId: POD_ID, status: 'scheduled', hostUserId: DIRECTOR, format: 'speed_networking',
      config: { numberOfRounds: 5, eventType: 'speed_networking' },
    });
    await expect(updateSession(SESSION_ID, DIRECTOR, { format: 'speed_networking', config: { matchingTemplateId: ADMIN_TEMPLATE } }, UserRole.MEMBER))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it("production's form for a non-admin sends no template, and is accepted as before", async () => {
    mockGetPodById.mockResolvedValue(pod(PodType.SPEED_NETWORKING));
    answer();
    await createSession(DIRECTOR, {
      ...base, format: 'speed_networking',
      config: { eventType: 'speed_networking', numberOfRounds: 5, roundDurationSeconds: 480, maxParticipants: 500, timerVisibility: 'last_10s', matchingPolicy: 'within_event' },
    }, UserRole.MEMBER);
    expect(inserted().config).not.toHaveProperty('matchingTemplateId');
    expect(mockQuery.mock.calls.some(([sql]) => /matching_templates/.test(sql as string))).toBe(false);
  });
});

describe('no video token for an in-person event (D10)', () => {
  it('answers 409 NOT_A_VIDEO_EVENT with the sentence, even to its host, and checks nobody', async () => {
    answer({
      id: SESSION_ID, podId: POD_ID, status: 'scheduled', hostUserId: DIRECTOR, format: 'physical_event',
      config: { location: 'Soho', durationMinutes: 60, eventType: 'physical_event' },
    });
    await expect(generateLiveKitToken(SESSION_ID, DIRECTOR)).rejects.toMatchObject({
      statusCode: 409, code: 'NOT_A_VIDEO_EVENT', message: 'This event happens in person, so there is no video room.',
    });
    expect(mockQuery.mock.calls.some(([sql]) => /session_participants/.test(sql as string))).toBe(false);
  });

  it('a video meeting goes on to the participant check, as before', async () => {
    answer({
      id: SESSION_ID, podId: POD_ID, status: 'lobby_open', hostUserId: DIRECTOR, format: 'video_meeting',
      config: { durationMinutes: 60, eventType: 'video_meeting' },
    });
    // No LiveKit keys here, so the mint itself fails afterwards; what matters is that it was not refused as in person.
    await generateLiveKitToken(SESSION_ID, DIRECTOR).catch((err) => expect(err.code).not.toBe('NOT_A_VIDEO_EVENT'));
    expect(mockQuery.mock.calls.some(([sql]) => /FROM session_participants/.test(sql as string))).toBe(true);
  });
});

describe('someone the host removed cannot register for an in-person event (Review Focus 3)', () => {
  it('is refused with the sentence, and their row stays removed', async () => {
    const { transaction } = jest.requireMock('../../../db') as { transaction: jest.Mock };
    transaction.mockImplementation(async (cb: (client: unknown) => unknown) => cb({ query: mockQuery }));
    mockQuery.mockImplementation(async (sql: string) => {
      if (/FROM sessions WHERE id = \$1/.test(sql)) {
        return { rows: [{ id: SESSION_ID, podId: POD_ID, status: 'scheduled', format: 'physical_event', config: { location: 'Soho', maxParticipants: 25 } }] };
      }
      if (/SELECT visibility FROM pods/.test(sql)) return { rows: [{ visibility: 'public' }] };
      if (/FROM pod_members/.test(sql)) return { rows: [{ role: 'member' }] };
      if (/SELECT COUNT\(\*\)/.test(sql)) return { rows: [{ count: '3' }] };
      if (/SELECT id, status, left_at FROM session_participants/.test(sql)) return { rows: [{ id: 'p1', status: 'removed', left_at: new Date() }] };
      return { rows: [], rowCount: 0 };
    });
    await expect(registerParticipant(SESSION_ID, 'removed-user')).rejects.toMatchObject({
      statusCode: 403, code: 'REMOVED_FROM_EVENT',
    });
    expect(mockQuery.mock.calls.some(([sql]) => /UPDATE session_participants SET status = 'registered'/.test(sql as string))).toBe(false);
  });
});

// ─── Fix round 1: production's Duplicate (and its old edit form) is never refused for a template ──────────────────
// origin/main client/src/features/sessions/SessionDetailPage.tsx:322-329 posts the source event's stored config as it
// is, with no format. A template stored there that this person may not choose now is dropped, not refused (Global
// Constraint 4, Review Focus 2); a form that sends the format chose its template, and is still told at the field.
describe("production's Duplicate keeps working whatever template the source event stored", () => {
  /** Exactly origin/main's duplicate body for a source event with this stored config. */
  const duplicate = (config: Record<string, unknown>) => ({
    podId: POD_ID, title: 'Founders night (copy)', description: '', scheduledAt: null as unknown as string, config,
  });
  const stored = (matchingTemplateId: string) => ({
    ...{ numberOfRounds: 5, roundDurationSeconds: 480, maxParticipants: 500, timerVisibility: 'last_10s', matchingPolicy: 'within_event' },
    eventType: 'speed_networking', matchingTemplateId,
  });

  it.each([
    ['a stored value that is not a UUID', 'Investor Day', UserRole.ADMIN],
    ['a template deleted since', GONE_TEMPLATE, UserRole.ADMIN],
    ["an admin's template, copied by a director who is not an admin", ADMIN_TEMPLATE, UserRole.MEMBER],
  ])('%s: the copy is made, without that template', async (_label, id, role) => {
    mockGetPodById.mockResolvedValue(pod(PodType.SPEED_NETWORKING));
    answer();
    await expect(createSession(DIRECTOR, duplicate(stored(id)), role)).resolves.toBeDefined();
    const { format, config } = inserted();
    expect(format).toBe('speed_networking');
    expect(config).not.toHaveProperty('matchingTemplateId');
    expect(config).toMatchObject({ numberOfRounds: 5, matchingPolicy: 'within_event' });
  });

  it('a template the person may use is kept on the copy (a preset for anyone, an admin\'s template for an admin)', async () => {
    mockGetPodById.mockResolvedValue(pod(PodType.SPEED_NETWORKING));
    answer();
    await createSession(DIRECTOR, duplicate(stored(MATCHING_PRESET_IDS.foundersInvestors)), UserRole.MEMBER);
    expect(inserted().config.matchingTemplateId).toBe(MATCHING_PRESET_IDS.foundersInvestors);
    mockQuery.mockClear();
    await createSession('admin-user', duplicate(stored(ADMIN_TEMPLATE)), UserRole.ADMIN);
    expect(inserted().config.matchingTemplateId).toBe(ADMIN_TEMPLATE);
  });

  it.each([
    ['not a UUID', 'Investor Day', UserRole.ADMIN, 400],
    ['a deleted template', GONE_TEMPLATE, UserRole.ADMIN, 400],
    ["an admin's template from a director", ADMIN_TEMPLATE, UserRole.MEMBER, 403],
  ])('a form that sends the format with %s is still refused at the field (%s)', async (_label, id, role, status) => {
    mockGetPodById.mockResolvedValue(pod(PodType.SPEED_NETWORKING));
    answer();
    await expect(createSession(DIRECTOR, { ...base, format: 'speed_networking', config: { matchingTemplateId: id } }, role))
      .rejects.toMatchObject({ statusCode: status, details: { matchingTemplateId: [expect.any(String)] } });
    expect(wrote()).toBe(false);
  });

  it("production's edit form (no format) does not take a template the person may not choose: the event keeps its own", async () => {
    answer({
      id: SESSION_ID, podId: POD_ID, status: 'scheduled', hostUserId: DIRECTOR, format: 'speed_networking',
      config: { numberOfRounds: 5, eventType: 'speed_networking', matchingTemplateId: MATCHING_PRESET_IDS.general },
    });
    await expect(updateSession(SESSION_ID, DIRECTOR, { config: { matchingTemplateId: ADMIN_TEMPLATE, numberOfRounds: 4 } }, UserRole.MEMBER))
      .resolves.toBeDefined();
    const call = mockQuery.mock.calls.find(([sql]) => /UPDATE sessions SET/.test(sql as string))!;
    const saved = JSON.parse((call[1] as unknown[]).find((v) => typeof v === 'string' && v.startsWith('{')) as string);
    expect(saved).toMatchObject({ numberOfRounds: 4, matchingTemplateId: MATCHING_PRESET_IDS.general });
  });
});
