// ─── The server's words say REASON, not RSN (21 Oct 2026) ────────────────────
//
// The client's 19 Oct feedback: "Call it REASON everywhere". The emails are rendered and read
// in email-reason-brand.test.ts, and the bells, the calendar entries and the refusal sentence are
// run in their own tests. This is the net under all of them: the files that hold words a person reads
// (an email, a bell, a calendar entry, a download name, a refusal) hold no RSN in code. Comments may
// say RSN, they are history; the address rsn.network and the program identifier a calendar file carries
// are not words anyone reads.

import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '../..');

const FILES = [
  'services/email/email.service.ts',
  'services/calendar/calendar.service.ts',
  'services/invite/invite.service.ts',
  'services/dm/meeting-windows.service.ts',
  'services/join-request/join-request.service.ts',
  'services/join-request/admin-action-tokens.service.ts',
  'services/identity/account-access.ts',
  'routes/invites.ts',
  'routes/meeting.ts',
  'routes/sessions.ts',
  'routes/join-requests.ts',
  'routes/admin.ts',
];

/** What a calendar file says about the program that wrote it. No calendar shows it to a person. */
const NOT_WORDS = ["'PRODID:-//RSN//Pod Engine//EN'"];

/** The file with its comments taken out. A comment starts at a // after a space or at the start of a line. */
const withoutComments = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/.*$/gm, '$1');

const codeLines = (file: string) => withoutComments(fs.readFileSync(path.join(SRC, file), 'utf8')).split(/\r?\n/);

describe('the files that hold words a person reads', () => {
  it.each(FILES)('%s says REASON, never RSN, in code', (file) => {
    const sayingRsn = codeLines(file)
      .filter((line) => /\bRSN\b/.test(line))
      .map((line) => line.trim())
      .filter((line) => !NOT_WORDS.includes(line.replace(/,$/, '')));
    expect(sayingRsn).toEqual([]);
  });

  it.each(FILES)('%s names no download after RSN', (file) => {
    const naming = codeLines(file).filter((line) => /filename="rsn-/.test(line)).map((line) => line.trim());
    expect(naming).toEqual([]);
  });

  it('the downloads are named for REASON', () => {
    expect(codeLines('routes/meeting.ts').join('\n')).toContain('filename="reason-meeting.ics"');
    expect(codeLines('routes/admin.ts').join('\n')).toContain('filename="reason-analytics-${type}.csv"');
  });

  it('every calendar entry an invite or a reminder creates is a "REASON event" with REASON as the fallback organizer', () => {
    for (const file of ['routes/invites.ts', 'services/invite/invite.service.ts']) {
      const code = codeLines(file).join('\n');
      expect(code).toContain('description: `REASON event — ${session.title}`');
      expect(code).toContain("organizerName: host?.display_name || 'REASON'");
    }
  });

  it('the registration email names the event as "your REASON event" when it has no title', () => {
    expect(codeLines('routes/sessions.ts').join('\n')).toContain("calendarEvent?.title ?? 'your REASON event'");
  });

  it('the check itself can see an RSN in code, and ignores it in a comment', () => {
    expect(withoutComments("const a = 'RSN event';\n").match(/\bRSN\b/)).not.toBeNull();
    expect(withoutComments("const a = 1; // the RSN way\n/* RSN */\n").match(/\bRSN\b/)).toBeNull();
    expect(withoutComments("const u = 'https://rsn.network'; // x\n").match(/https:\/\/rsn\.network/)).not.toBeNull();
  });
});
