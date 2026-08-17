// 13 Aug 2026 overhaul (task A5) — "unclear who's messaging you". The inbox
// used to return a name and nothing else, so a member couldn't tell a
// stranger from a colleague. listConversations now also surfaces job
// title, company, and a truncated bio so the message view can say WHO is
// writing, not just their name.
//
// Follows the same live-query-mocking pattern as meeting-windows.test.ts
// (as opposed to the source-grep pattern in phaseC-dm-service.test.ts) so
// the actual row-to-object mapping is exercised, not just the SQL text.

const mockQuery = jest.fn();

jest.mock('../../../db', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (cb: Function) => cb({ query: (...a: unknown[]) => mockQuery(...a) }),
  __esModule: true,
}));
jest.mock('../../../config/logger', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

import { listConversations } from '../../../services/dm/dm.service';

beforeEach(() => { mockQuery.mockReset(); });

function armCount(count = '1') {
  mockQuery.mockImplementation((sql: string) => {
    if (/COUNT\(\*\)::text AS count FROM dm_conversations/.test(sql)) {
      return Promise.resolve({ rows: [{ count }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

describe('listConversations() — inbox carries who-is-writing context', () => {
  it('the inbox query selects job_title, company, and bio alongside the display name', async () => {
    armCount('0');
    await listConversations('u-1');
    const inboxCall = mockQuery.mock.calls.find(([sql]) => /FROM dm_conversations c/.test(String(sql)));
    expect(inboxCall).toBeDefined();
    const sql = String(inboxCall![0]);
    expect(sql).toMatch(/job_title/);
    expect(sql).toMatch(/company/);
    expect(sql).toMatch(/bio/);
  });

  it('truncates the bio at the SQL layer (a line, not an essay)', async () => {
    armCount('0');
    await listConversations('u-1');
    const inboxCall = mockQuery.mock.calls.find(([sql]) => /FROM dm_conversations c/.test(String(sql)));
    const sql = String(inboxCall![0]);
    expect(sql).toMatch(/LEFT\(u\.bio,\s*180\)/);
  });

  it('maps the row into otherJobTitle / otherCompany / otherBio on the summary', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/COUNT\(\*\)::text AS count FROM dm_conversations/.test(sql)) {
        return Promise.resolve({ rows: [{ count: '1' }] });
      }
      return Promise.resolve({
        rows: [{
          conversation_id: 'conv-1',
          other_user_id: 'u-2',
          other_display_name: 'Jane Doe',
          other_avatar_url: null,
          other_job_title: 'Senior React Developer',
          other_company: 'Acme Corp',
          other_bio: 'Building things that matter.',
          last_message: 'hey',
          last_message_at: new Date('2026-08-13T00:00:00Z'),
          last_message_from: 'u-2',
          last_attachment_type: null,
          unread_count: '1',
        }],
      });
    });

    const { conversations } = await listConversations('u-1');
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      otherJobTitle: 'Senior React Developer',
      otherCompany: 'Acme Corp',
      otherBio: 'Building things that matter.',
    });
  });

  it('passes through null job title / company / bio without throwing (profile fields are optional)', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/COUNT\(\*\)::text AS count FROM dm_conversations/.test(sql)) {
        return Promise.resolve({ rows: [{ count: '1' }] });
      }
      return Promise.resolve({
        rows: [{
          conversation_id: 'conv-1',
          other_user_id: 'u-2',
          other_display_name: 'Jane Doe',
          other_avatar_url: null,
          other_job_title: null,
          other_company: null,
          other_bio: null,
          last_message: null,
          last_message_at: null,
          last_message_from: null,
          last_attachment_type: null,
          unread_count: '0',
        }],
      });
    });

    const { conversations } = await listConversations('u-1');
    expect(conversations[0].otherJobTitle).toBeNull();
    expect(conversations[0].otherCompany).toBeNull();
    expect(conversations[0].otherBio).toBeNull();
  });
});
