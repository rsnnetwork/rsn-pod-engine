// ─── An organiser's export: the files themselves (Shirley pilot S7, 11 Nov 2026; item 20, D6) ────────────────────
// The four files from rows the reads found: a BOM for Excel, CRLF line ends, every cell formula-guarded (names and post
// text a member wrote may start with =, +, - or @), no email column anywhere, and a file name made of fixed words and
// the date only. A 2,000-member file is built by joining strings, never by a regex over the file.

import {
  eventRows, exportFile, exportFileName, memberRows, postRows, spaceRows, utcDay, utcMinute,
  type MemberRow, type SpaceDetails,
} from '../../../services/space/space-export-csv';
import { CSV_BOM } from '../../../lib/csv';

const AT = new Date('2026-11-11T14:05:09Z');

/** The file's lines, without the BOM, as a spreadsheet splits them. */
const lines = (body: string) => body.slice(1).split('\r\n');

describe('file names: fixed words and the date, never the space\'s own name', () => {
  it.each([
    ['circle', 'members', 'reason-circle-members-2026-11-11.csv'],
    ['pod', 'posts', 'reason-pod-posts-2026-11-11.csv'],
    ['pod', 'space', 'reason-pod-space-2026-11-11.csv'],
    ['circle', 'events', 'reason-circle-events-2026-11-11.csv'],
  ] as const)('%s %s', (kind, section, name) => {
    expect(exportFileName(kind, section, AT)).toBe(name);
    expect(exportFile(kind, section, [['a']], AT).filename).toBe(name);
  });

  it('the day is UTC\'s', () => {
    expect(utcDay(new Date('2026-12-31T23:30:00-05:00'))).toBe('2027-01-01');
    expect(utcMinute(AT)).toBe('2026-11-11 14:05');
    expect(utcMinute(null)).toBe('');
  });
});

describe('members.csv', () => {
  const members: MemberRow[] = [
    { name: 'Shirley Palmer', role: 'owner', joinedAt: new Date('2026-11-01T09:00:00Z') },
    { name: '=HYPERLINK("https://evil.example","click")', role: 'moderator', joinedAt: new Date('2026-11-02T09:00:00Z') },
    { name: '+44 7700 900123', role: 'member', joinedAt: new Date('2026-11-03T09:00:00Z') },
    { name: '-Dash', role: 'member', joinedAt: new Date('2026-11-03T09:00:00Z') },
    { name: '@handle', role: 'member', joinedAt: new Date('2026-11-03T09:00:00Z') },
    { name: 'Zoë, "Z" Søren', role: 'director', joinedAt: new Date('2026-11-04T09:00:00Z') },
    { name: 'Hana', role: 'host', joinedAt: new Date('2026-11-04T09:00:00Z') },
  ];

  it('a BOM, CRLF, a header of name, role and joined, and no email column', () => {
    const file = exportFile('circle', 'members', memberRows(members), AT);
    expect(file.body.startsWith(CSV_BOM)).toBe(true);
    expect(file.body.endsWith('\r\n')).toBe(true);
    expect(file.body.slice(1).replace(/\r\n/g, '')).not.toMatch(/\n/);
    expect(lines(file.body)[0]).toBe('Name,Role,Joined');
    expect(file.body).not.toMatch(/email|@example|E-mail/i);
    expect(file.rows).toBe(members.length);
  });

  it('formula injection in names is written as text', () => {
    const l = lines(exportFile('circle', 'members', memberRows(members), AT).body);
    expect(l[2]).toBe('"\'=HYPERLINK(""https://evil.example"",""click"")",Moderator,2026-11-02');
    expect(l[3]).toBe("'+44 7700 900123,Member,2026-11-03");
    expect(l[4]).toBe("'-Dash,Member,2026-11-03");
    expect(l[5]).toBe("'@handle,Member,2026-11-03");
    expect(l[6]).toBe('"Zoë, ""Z"" Søren",Director,2026-11-04');
    expect(l[7]).toBe('Hana,Host,2026-11-04');
  });

  it('an empty space is a header and nothing else', () => {
    const file = exportFile('pod', 'members', memberRows([]), AT);
    expect(file.body).toBe(`${CSV_BOM}Name,Role,Joined\r\n`);
    expect(file.rows).toBe(0);
  });

  it('2,000 members: every one, in order, quickly', () => {
    const many: MemberRow[] = Array.from({ length: 2000 }, (_, i) => ({
      name: i % 7 === 0 ? `=cmd|' /C calc'!A${i}` : `Member ${i}, the ${i}th`, role: i === 0 ? 'owner' : 'member',
      joinedAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000),
    }));
    const started = Date.now();
    const file = exportFile('circle', 'members', memberRows(many), AT);
    expect(Date.now() - started).toBeLessThan(1000);
    const l = lines(file.body);
    expect(l).toHaveLength(2002); // header, 2,000 rows, and the empty piece after the last CRLF
    expect(file.rows).toBe(2000);
    expect(l[1]).toBe("'=cmd|' /C calc'!A0,Owner,2026-01-01"); // a ' in front: a spreadsheet reads it as text
    expect(l[2000]).toBe('"Member 1999, the 1999th",Member,2026-01-02');
  });
});

describe('space.csv', () => {
  const circle: SpaceDetails = {
    kind: 'circle', name: 'Curious Humans', description: '=1+1 is a formula', access: 'closed', createdAt: new Date('2026-10-01T00:00:00Z'), status: 'archived',
    currentMembers: 12, formerMembers: 2, linked: ['Curious 12'], organisations: ['Acme Ltd'],
  };
  it('a circle: who can join, counts, the pods and organisations it names, and when it was taken', () => {
    const l = lines(exportFile('circle', 'space', spaceRows(circle, AT), AT).body);
    expect(l).toEqual([
      'Field,Value', 'Kind,Circle', 'Name,Curious Humans', "Description,'=1+1 is a formula",
      'Who can join,Closed: people ask to join and an organiser lets them in', 'Status,Archived', 'Created,2026-10-01', 'Current members,12',
      'Members removed by an organiser,2', 'Pod,Curious 12', 'Organisation,Acme Ltd', 'Exported (UTC),2026-11-11 14:05', '',
    ]);
  });

  it('a pod: its setting in the shared words (an old invite-only reads as Private), type, status, rules and its circles', () => {
    const pod: SpaceDetails = {
      kind: 'pod', name: 'Human Edge Collective', description: null, access: 'invite_only', createdAt: new Date('2026-10-02T00:00:00Z'),
      podType: 'reason', status: 'active', rules: 'Be kind.', currentMembers: 0, formerMembers: 3, linked: ['Curious Humans'],
    };
    const l = lines(exportFile('pod', 'space', spaceRows(pod, AT), AT).body);
    expect(l).toContain('Visibility,Private');
    expect(l).toContain('Type,Reason Pod');
    expect(l).toContain('Status,Active');
    expect(l).toContain('Rules,Be kind.');
    expect(l).toContain('Description,');
    expect(l).toContain('Former members (left or removed),3');
    expect(l).toContain('Circle,Curious Humans');
    expect(l.some((x) => x.startsWith('Organisation'))).toBe(false);
  });
});

describe('events.csv: counts only, on each event\'s own clock', () => {
  it('title, start in its zone, status words, format, registered and came', () => {
    const l = lines(exportFile('pod', 'events', eventRows([
      { title: '@Founders breakfast', scheduledAt: new Date('2026-11-17T14:00:00Z'), timezone: 'Europe/London', status: 'completed', publication: 'published', format: 'speed_networking', config: null, registered: 12, came: 9 },
      { title: 'Draft one', scheduledAt: new Date('2026-12-01T09:00:00Z'), timezone: null, status: 'scheduled', publication: 'draft', format: null, config: null, registered: 0, came: 0 },
      { title: 'Off', scheduledAt: new Date('2026-12-02T09:00:00Z'), timezone: 'Asia/Kolkata', status: 'cancelled', publication: 'published', format: 'video_meeting', config: null, registered: 3, came: 0 },
      { title: 'Now', scheduledAt: new Date('2026-11-11T09:00:00Z'), timezone: 'UTC', status: 'round_active', publication: 'published', format: null, config: null, registered: 4, came: 4 },
      { title: 'Soon', scheduledAt: new Date('2026-11-20T09:00:00Z'), timezone: 'UTC', status: 'scheduled', publication: 'published', format: null, config: null, registered: 1, came: 0 },
    ]), AT).body);
    expect(l[0]).toBe("Title,Starts (on the event's clock),Time zone,Status,Format,Registered,Came");
    expect(l[1]).toBe("'@Founders breakfast,2026-11-17 14:00,Europe/London,Ended,Speed networking,12,9");
    expect(l[2]).toMatch(/^Draft one,2026-12-01 09:00,[^,]+,Draft,Speed networking,0,0$/);
    expect(l[3]).toMatch(/^Off,2026-12-02 14:30,Asia\/Kolkata,Cancelled,[^,]+,3,0$/);
    expect(l[4]).toMatch(/,Live,/);
    expect(l[5]).toMatch(/,Upcoming,/);
  });
});

describe('posts.csv: the organiser\'s own posts', () => {
  it('formula injection and line breaks in a post are kept as text in one cell', () => {
    const body = exportFile('circle', 'posts', postRows('circle', [
      { createdAt: AT, editedAt: null, content: '=IMPORTXML("https://evil.example","//a")\nsecond line, with a comma', linkUrl: 'https://acme.com', mediaCount: 2, commentCount: 5, pinned: true, shared: false },
      { createdAt: AT, editedAt: AT, content: '-10% off', linkUrl: null, mediaCount: 0, commentCount: 0, pinned: false, shared: true },
    ]), AT).body;
    const header = lines(body)[0];
    expect(header).toBe('Posted (UTC),Edited (UTC),Text,Link,Pictures or videos,Comments,Pinned,Shares another post');
    expect(body).toContain('2026-11-11 14:05,,"\'=IMPORTXML(""https://evil.example"",""//a"")\nsecond line, with a comma",https://acme.com,2,5,Yes,No\r\n');
    expect(body).toContain("2026-11-11 14:05,2026-11-11 14:05,'-10% off,,0,0,No,Yes\r\n");
  });

  it('a pod\'s posts have no share column', () => {
    expect(lines(exportFile('pod', 'posts', postRows('pod', []), AT).body)[0]).toBe('Posted (UTC),Edited (UTC),Text,Link,Pictures or videos,Comments,Pinned');
  });
});
