// ─── Every bell and email about an event reads in the event's zone (10 Nov 2026 spec, Part 3 Task 1; K1) ────────
//
// A Copenhagen evening (zone 'Europe/Copenhagen') told to someone whose own zone is New York: the reminder bell and
// email, the moved notice, the cancellation email, the invite bell and email, the registration email, the "Registration
// opens ..." refusal and the message after the event all print Copenhagen's wall clock and say "CET", never New York's
// and never the server's. The registration email no longer prints a raw "GMT" timestamp. An event with an image shows
// it at the head of the registration, invite and reminder emails.
//
// The database is a stand-in that answers each statement by its text; the email senders are stand-ins that keep what
// they were given, and the pure email builders are the real ones, so the words checked are the words that would go out.

jest.mock('../../../config', () => {
  const config = {
    clientUrl: 'https://app.rsn.network', apiBaseUrl: 'https://api.rsn.network', eventComms: 'on', resendApiKey: '',
  };
  return { __esModule: true, default: config, config };
});
jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
const mockQuery = jest.fn();
jest.mock('../../../db', () => ({ __esModule: true, query: (...a: unknown[]) => mockQuery(...a), transaction: jest.fn() }));
jest.mock('../../../realtime/emit', () => ({
  __esModule: true,
  getRealtimeIo: () => ({ to: () => ({ emit: jest.fn() }) }),
  emitEntities: jest.fn().mockResolvedValue(undefined),
  setRealtimeIo: jest.fn(),
}));
jest.mock('../../../index', () => ({ __esModule: true, io: { to: () => ({ emit: jest.fn() }) } }));
const mockSent: Record<string, Array<{ to: string; data: Record<string, unknown> }>> = {};
jest.mock('../../../services/email/email.service', () => {
  const actual = jest.requireActual('../../../services/email/email.service');
  const keep = (name: string) => async (to: string, data: Record<string, unknown>) => {
    (mockSent[name] ??= []).push({ to, data });
    return { sent: true };
  };
  return {
    __esModule: true,
    buildInviteEmail: actual.buildInviteEmail,
    buildRegistrationConfirmationEmail: actual.buildRegistrationConfirmationEmail,
    isEmailTypeEnabled: async () => true,
    asBulkEmail: <T,>(send: () => Promise<T>) => send(),
    sendEventReminderEmail: keep('reminder'),
    sendEventRescheduledEmail: keep('rescheduled'),
    sendEventCancelledEmail: keep('cancelled'),
    sendInviteEmail: keep('invite'),
    sendSessionRegistrationConfirmationEmail: keep('registration'),
  };
});

import { InviteType } from '@rsn/shared';
import { buildInviteEmail, buildRegistrationConfirmationEmail } from '../../../services/email/email.service';
import { DUE_EVENTS_SQL, CLAIM_SQL, processEventReminders } from '../../../services/session/event-reminder.worker';
import { notifyEventRescheduled } from '../../../services/session/event-notices';
import { emailCancellation } from '../../../services/session/event-lifecycle.service';
import { buildInviteContext, emailInvite, notifyInvitee } from '../../../services/invite/invite.service';
import { sendRegistrationEmail } from '../../../services/session/registration-email';
import { buildSessionCalendarEvent } from '../../../services/calendar/calendar.service';
import { readEventAccessFacts, registrationNotOpenRefusal } from '../../../services/session/event-access';

const CPH = 'Europe/Copenhagen';
const NY = 'America/New_York';
const EVENT = '22222222-2222-4222-8222-222222222222';
const HOST = '33333333-3333-4333-8333-333333333333';
const MEMBER = '44444444-4444-4444-8444-444444444444';
const STARTS = new Date('2026-11-17T13:00:00.000Z'); // 14:00 in Copenhagen, 08:00 in New York
const IMAGE_AT = new Date('2026-11-10T09:00:00.000Z');
const IMAGE_URL = `https://api.rsn.network/api/sessions/${EVENT}/image?v=${IMAGE_AT.getTime()}`;

const member = { id: MEMBER, user_id: MEMBER, email: 'member@example.test', timezone: NY, notify_email: true };
const sessionRow = {
  id: EVENT, title: 'Founders evening', scheduled_at: STARTS, status: 'scheduled', publication: 'published',
  archived_at: null, registration_opens_at: null, timezone: CPH, host_user_id: HOST, config: {}, event_format: null,
  has_image: true, image_updated_at: IMAGE_AT,
};

let bells: Array<{ titles: string[]; body: string }>;

beforeEach(() => {
  for (const key of Object.keys(mockSent)) delete mockSent[key];
  bells = [];
  mockQuery.mockReset().mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql === DUE_EVENTS_SQL) return { rows: [{ ...sessionRow, scheduled_at: new Date('2026-11-17T08:00:00.000Z'), now_at: params[0] }] };
    if (sql === CLAIM_SQL) return { rows: [member] };
    if (/INSERT INTO notifications \(user_id, type, title, body, link\)\s+SELECT t\.user_id/.test(sql)) {
      const [ids, titles, , body] = params as [string[], string[], string, string];
      bells.push({ titles, body });
      return { rows: ids.map((id, i) => ({ id: `n${i}`, user_id: id, title: titles[i], created_at: new Date() })) };
    }
    if (/INSERT INTO notifications \(user_id, type, title, body, link\) VALUES/.test(sql)) {
      bells.push({ titles: [params[2] as string], body: params[3] as string });
      return { rows: [{ id: 'n1', created_at: new Date() }] };
    }
    // The recipients first: their statement also names "FROM sessions s WHERE s.id = $1" (the host).
    if (/FROM users u\s+WHERE u\.id <> \$2/.test(sql)) return { rows: [member] };
    if (/FROM sessions s WHERE s\.id = \$1/.test(sql)) return { rows: [sessionRow] };
    if (/FROM sessions WHERE id = \$1/.test(sql)) return { rows: [sessionRow] };
    if (/SELECT display_name, email FROM users WHERE id = \$1/.test(sql)) return { rows: [{ display_name: 'Stefan', email: 'host@example.test' }] };
    if (/SELECT email, display_name FROM users WHERE id = \$1/.test(sql)) return { rows: [{ email: member.email, display_name: 'Ian' }] };
    if (/SELECT display_name AS "displayName" FROM users/.test(sql)) return { rows: [{ displayName: 'Stefan' }] };
    if (/SELECT display_name FROM users WHERE id = \$1/.test(sql)) return { rows: [{ display_name: 'Stefan' }] };
    return { rows: [] };
  });
});

describe('the reminder', () => {
  it('bell and email say tomorrow at 09:00 (CET), judged in Copenhagen, and the email carries the image', async () => {
    const now = new Date('2026-11-16T22:30:00.000Z'); // 23:30 in Copenhagen, 17:30 in New York
    const result = await processEventReminders(now, 'on');
    expect(result.belled).toBe(1);
    expect(bells[0].titles).toEqual(['Founders evening starts tomorrow at 09:00 (CET)']);
    expect(mockSent.reminder[0].data).toMatchObject({ when: 'tomorrow at 09:00 (CET)', imageUrl: IMAGE_URL });
  });
});

describe('the moved notice', () => {
  it('bell and email name the new and old times on Copenhagen\'s clock', async () => {
    await notifyEventRescheduled(EVENT, STARTS, new Date('2026-12-02T13:00:00.000Z'), HOST);
    expect(bells[0].titles).toEqual(['Founders evening has moved to Wednesday 2 December, 14:00 (CET)']);
    expect(mockSent.rescheduled[0].data).toMatchObject({
      previousWhen: 'Tuesday 17 November, 14:00 (CET)', when: 'Wednesday 2 December, 14:00 (CET)',
    });
  });
});

describe('the cancellation email', () => {
  it('names the time on Copenhagen\'s clock', async () => {
    await emailCancellation(
      { id: EVENT, title: 'Founders evening', scheduled_at: STARTS, timezone: CPH },
      { userId: HOST, role: 'member' } as never, null, [member],
    );
    expect(mockSent.cancelled[0].data).toMatchObject({ when: 'Tuesday 17 November, 14:00 (CET)' });
  });
});

describe('the invite', () => {
  it('bell names the event time on Copenhagen\'s clock, and the email says When with the image at its head', async () => {
    const ctx = await buildInviteContext(HOST, InviteType.SESSION, { sessionId: EVENT });
    expect(ctx.timezone).toBe(CPH);
    await notifyInvitee(ctx, { code: 'abc', inviteeEmail: member.email, inviteeUserId: MEMBER });
    expect(bells[0].body).toBe('Founders evening · Tue 17 Nov, 14:00 CET');

    await emailInvite(ctx, { code: 'abc', inviteeEmail: member.email });
    const built = buildInviteEmail(mockSent.invite[0].data as never);
    expect(built.text).toContain('When: Tuesday 17 November, 14:00 (CET)');
    expect(built.html).toContain('When: Tuesday 17 November, 14:00 (CET)');
    expect(built.html).toContain(`<img src="${IMAGE_URL}" alt="" width="480"`);
  });

  it('an invite to a pod has no When line and no image', () => {
    const built = buildInviteEmail({ inviterName: 'Stefan', type: 'pod', targetName: 'Pod', inviteUrl: 'https://x/invite/a' });
    expect(built.text).not.toContain('When:');
    expect(built.html).not.toContain('<img src="https://api');
  });
});

describe('the registration email', () => {
  it('names the time on Copenhagen\'s clock, never a raw GMT timestamp, with the image at its head', async () => {
    const event = await buildSessionCalendarEvent(EVENT);
    expect(event).toMatchObject({ timezone: CPH, imageUrl: IMAGE_URL });
    await sendRegistrationEmail(EVENT, MEMBER);
    const data = mockSent.registration[0].data;
    const built = buildRegistrationConfirmationEmail(data as never);
    expect(built.html).toContain('Tuesday 17 November, 14:00 (CET)');
    expect(built.text).toContain('When: Tuesday 17 November, 14:00 (CET)');
    expect(built.html).not.toContain('GMT');
    expect(built.html).toContain(`<img src="${IMAGE_URL}" alt="" width="480"`);
  });

  it('an event with no image sends no image', async () => {
    const built = buildRegistrationConfirmationEmail({
      sessionTitle: 'Founders evening', sessionUrl: 'https://app/sessions/x',
      calendarEvent: { title: 'Founders evening', startTime: STARTS, durationMinutes: 60, timezone: CPH, imageUrl: null },
    });
    expect(built.html).not.toContain('width="560"');
  });
});

describe('"Registration opens ..."', () => {
  it('reads on Copenhagen\'s clock, from the event\'s own zone', async () => {
    mockQuery.mockImplementationOnce(async () => ({
      rows: [{
        visibility: 'public', pod_id: 'pod', pod_visibility: 'public', is_host: false, is_cohost: false, is_pod_organiser: false,
        in_audience: false, is_invited: false, participant_status: null, account_active: true, my_request: null,
        outside_closed_circle: false, publication: 'published', archived: false,
        registration_opens_at: '2026-11-20T08:00:00.000Z', event_timezone: CPH,
      }],
    }));
    const facts = await readEventAccessFacts(EVENT, MEMBER);
    expect(facts!.eventTimezone).toBe(CPH);
    const refusal = registrationNotOpenRefusal(facts!, 'member', {}, new Date('2026-11-11T12:00:00.000Z'));
    expect(refusal).toMatchObject({ ok: false, message: 'Registration for this event opens Friday 20 November, 09:00 (CET).' });
    // The statement reads the event's zone, not the viewer's.
    expect(mockQuery.mock.calls[0][0]).toContain('s.timezone AS event_timezone');
    expect(mockQuery.mock.calls[0][0]).not.toContain('viewer_timezone');
  });
});
