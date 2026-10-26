// ─── Nothing a person types becomes markup in an email from REASON (21 Oct 2026) ──────────────
//
// The final review of 21 Oct: a request to join needs no account, and the confirmation it sends put the
// name from the form into the email's HTML as it was typed, so anyone could send their own link or picture
// from REASON <noreply@rsn.network> to any address. Names, event, pod and circle names, a direct message,
// a meeting note and an admin's message reached the other emails the same way. Every value an email puts
// into its HTML is now escaped, the way the admin review email always did it, so what a person typed is
// shown as text and never read as markup. The plain text and the subject are not HTML: they carry it as typed.
//
// Every email builder runs here with every field of its input filled in (the Filled type makes leaving one
// out a compile error), and then once for every string in that input with that string replaced by a hostile
// one. The HTML that comes back must have exactly the tags and attributes the same email has with plain
// words in that field: nothing added, no handler, no link to another site.
//
// The real email service runs. Only the sending library, the config, the logger and the database are
// replaced, so nothing is sent: the library's send() keeps what would have gone out.

const mockSend = jest.fn();
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: (...a: unknown[]) => mockSend(...a) } })),
}));
jest.mock('../../config', () => ({
  __esModule: true,
  default: {
    resendApiKey: 'test-key',
    emailFrom: 'noreply@rsn.network',
    clientUrl: 'https://app.rsn.network',
    magicLinkExpiryMinutes: 15,
  },
}));
jest.mock('../../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../db', () => ({ query: jest.fn(), transaction: jest.fn() }));

import * as emailService from '../../services/email/email.service';

// ── The emails, each with every field filled in ──────────────────────────────────────────────────

type Exported = typeof emailService;
/** The exports that build or send an email. */
type BuilderName = { [K in keyof Exported]: K extends `send${string}Email` | `build${string}Email` ? K : never }[keyof Exported];
type ArgsOf<F> = F extends (...args: infer P) => unknown ? P : never;
/** Every field present and none of them null or undefined, all the way down. A Date stays a Date. */
type Filled<T> =
  T extends Date ? T
    : T extends readonly unknown[] ? { [K in keyof T]: Filled<T[K]> }
      : T extends object ? { [K in keyof T]-?: Filled<NonNullable<T[K]>> }
        : NonNullable<T>;

interface Rendered { subject: string; html: string; text: string }

interface Case {
  fn: BuilderName;
  label: string;
  /** The name of each argument, so a failure says which field it was. */
  params: string[];
  args: unknown[];
}

/** One email. TypeScript checks the arguments against the builder's own, with nothing left out. */
function email<K extends BuilderName>(fn: K, label: string, params: string[], args: Filled<ArgsOf<Exported[K]>>): Case {
  return { fn, label, params, args: args as unknown[] };
}

const STARTS = new Date('2026-11-05T17:00:00Z');
const APP = 'https://app.rsn.network';
const calendarEvent = {
  title: 'Founders Evening', description: 'An evening of founders.', startTime: STARTS, durationMinutes: 60,
  organizerName: 'Host', organizerEmail: 'host@example.com', sessionId: 's-1',
};
const inviteData = {
  inviterName: 'Stefan', type: 'session' as const, targetName: 'Founders Evening', inviteUrl: `${APP}/invite/ABC123`, calendarEvent,
};

const cases: Case[] = [
  email('sendMagicLinkEmail', 'the sign-in link', ['to', 'magicLinkUrl'],
    ['delivered+ana@resend.dev', `${APP}/auth/verify?token=abc&inviteCode=XYZ`]),
  email('sendSessionRecapEmail', 'the event recap', ['to', 'displayName', 'data'], ['delivered+ana@resend.dev', 'Ana', {
    sessionTitle: 'Founders Evening', peopleMet: 5, mutualConnections: 2, avgRating: 4.2, recapUrl: `${APP}/sessions/s-1/recap`,
  }]),
  email('sendDmNotificationEmail', 'a new message', ['to', 'recipientDisplayName', 'data'], ['delivered+ana@resend.dev', 'Ana', {
    senderName: 'Fatima', snippet: 'Are you free on Thursday?', threadUrl: `${APP}/messages/c1`,
  }]),
  email('sendHostRecapEmail', 'the host recap', ['to', 'displayName', 'data'], ['delivered+host@resend.dev', 'Host', {
    sessionTitle: 'Founders Evening', totalParticipants: 12, totalRounds: 5, totalMatches: 20, matchesCreated: 24,
    avgEventRating: 4.1, mutualConnectionsCount: 8, recapUrl: `${APP}/sessions/s-1/recap`,
  }]),
  email('buildInviteEmail', 'an event invite, as built', ['data'], [inviteData]),
  email('sendInviteEmail', 'an event invite', ['to', 'data'], ['delivered+guest@resend.dev', inviteData]),
  email('sendInviteEmail', 'a platform invite', ['to', 'data'], ['delivered+guest@resend.dev', { ...inviteData, type: 'platform' }]),
  email('sendSessionRegistrationConfirmationEmail', 'the event registration', ['to', 'data'], ['delivered+ana@resend.dev', {
    recipientName: 'Ana', sessionTitle: 'Founders Evening', sessionUrl: `${APP}/sessions/s-1`, calendarEvent,
  }]),
  email('sendJoinRequestConfirmationEmail', 'the request received', ['to', 'fullName'], ['delivered+sam@resend.dev', 'Sam Applicant']),
  email('sendJoinRequestWelcomeEmail', 'the welcome after approval', ['to', 'fullName', 'loginUrl'],
    ['delivered+sam@resend.dev', 'Sam Applicant', `${APP}/auth/verify?token=abc`]),
  email('sendJoinRequestDeclineEmail', 'the decline', ['to', 'fullName'], ['delivered+sam@resend.dev', 'Sam Applicant']),
  email('sendJoinRequestReminderEmail', 'the first reminder', ['to', 'fullName', 'loginUrl', 'reminderCount'],
    ['delivered+sam@resend.dev', 'Sam Applicant', `${APP}/login`, 1]),
  email('sendJoinRequestReminderEmail', 'the second reminder', ['to', 'fullName', 'loginUrl', 'reminderCount'],
    ['delivered+sam@resend.dev', 'Sam Applicant', `${APP}/login`, 2]),
  email('sendGenericEmail', 'a message from an admin', ['to', 'recipientName', 'data'],
    ['delivered+sam@resend.dev', 'Sam', { subject: 'A note from the team', body: 'Thanks for your patience.' }]),
  email('sendJoinRequestAdminReviewEmail', 'the admin review', ['to', 'data'], ['delivered+ada@resend.dev', {
    adminDisplayName: 'Ada', applicantName: 'Sam Applicant', applicantEmail: 'sam@example.com',
    applicantLinkedinUrl: 'https://www.linkedin.com/in/sam-applicant', applicantReason: 'I run a studio.',
    approveUrl: `${APP}/admin/jr/aaaa`, rejectUrl: `${APP}/admin/jr/bbbb`, dashboardUrl: `${APP}/admin/join-requests`,
    expiresInHours: 48,
  }]),
  email('sendPokeReceivedEmail', 'a meeting request', ['to', 'recipientDisplayName', 'data'], ['delivered+ana@resend.dev', 'Ana', {
    senderName: 'Fatima', introMessage: 'I would value your view on our seed round.', messagesUrl: `${APP}/messages`,
  }]),
  email('sendPokeAcceptedEmail', 'a meeting request accepted', ['to', 'recipientDisplayName', 'data'],
    ['delivered+ana@resend.dev', 'Ana', { accepterName: 'Bo', messagesUrl: `${APP}/messages` }]),
  email('sendLlmBalanceAlertEmail', 'the balance alert', ['opts'],
    [{ to: 'delivered+ops@resend.dev', where: 'onboarding chat', at: '2026-11-05T17:00:00Z' }]),
  email('sendMeetingConfirmedEmail', 'a confirmed meeting', ['to', 'recipientDisplayName', 'data'], ['delivered+ana@resend.dev', 'Ana', {
    partnerName: 'Bo', startAt: STARTS, durationMin: 30, recipientTimezone: 'Europe/Berlin', threadUrl: `${APP}/messages/c1`,
    googleCalendarUrl: 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=REASON%20meeting',
    icsContent: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n',
    joinUrl: `${APP}/meet/c1?scheduled=1&kind=video`, kind: 'video',
    eventsUrl: `${APP}/sessions`, moved: true,
  }]),
  email('sendMeetingCancelledEmail', 'a cancelled meeting', ['to', 'recipientDisplayName', 'data'], ['delivered+ana@resend.dev', 'Ana', {
    partnerName: 'Bo', cancellerName: 'Bo', cancelledByMe: false, startAt: STARTS, durationMin: 30, kind: 'video',
    recipientTimezone: 'Europe/Berlin', threadUrl: `${APP}/messages/c1`, icsContent: 'BEGIN:VCALENDAR\r\nMETHOD:CANCEL\r\nEND:VCALENDAR\r\n',
  }]),
  email('sendMeetingReminderEmail', 'a meeting reminder', ['to', 'recipientDisplayName', 'data'], ['delivered+ana@resend.dev', 'Ana', {
    partnerName: 'Bo', startAt: STARTS, durationMin: 30, kind: 'audio', recipientTimezone: 'Europe/Berlin', minutesToGo: 10,
    joinUrl: `${APP}/meet/c1?scheduled=1&kind=audio`, eventsUrl: `${APP}/sessions`,
  }]),
];

/** Exports that build no email: the shared card and the admin switch. Anything new must be put in one list or the other. */
const NOT_BUILDERS = ['emailCardClose', 'emailCardOpen', 'isEmailTypeEnabled'];

// ── Running one ──────────────────────────────────────────────────────────────────────────────────

/** Builds or sends one email and returns what went out. A builder hands it back; a sender gives it to send(). */
async function render(fn: BuilderName, args: unknown[]): Promise<Rendered> {
  mockSend.mockReset();
  mockSend.mockResolvedValue({ error: null });
  const built = await (emailService[fn] as unknown as (...a: unknown[]) => unknown)(...args);
  if (fn.startsWith('build')) return built as Rendered;
  expect(mockSend).toHaveBeenCalledTimes(1);
  return mockSend.mock.calls[0][0] as Rendered;
}

type Path = Array<string | number>;

/** Where every string in a value sits. A Date has none. */
function stringPaths(value: unknown, at: Path = []): Path[] {
  if (typeof value === 'string') return [at];
  if (value === null || typeof value !== 'object' || value instanceof Date) return [];
  return Object.entries(value).flatMap(([key, v]) => stringPaths(v, [...at, Array.isArray(value) ? Number(key) : key]));
}

/** A copy of `root` with `replacement` at `path`; everything off the path is shared, not copied. */
function withStringAt(root: unknown, path: Path, replacement: string): unknown {
  if (path.length === 0) return replacement;
  const [head, ...rest] = path;
  const copy = (Array.isArray(root) ? [...root] : { ...(root as object) }) as Record<string | number, unknown>;
  copy[head] = withStringAt(copy[head], rest, replacement);
  return copy;
}

const pathName = (c: Case, path: Path) => [c.params[path[0] as number], ...path.slice(1)].join('.');

// ── Reading the HTML the way a browser does ──────────────────────────────────────────────────────

/** The five characters the email escapes, as it escapes them. */
const escaped = (s: string) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const decoded = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

interface Tag { name: string; attributes: Array<[name: string, value: string]> }

/** Every opening tag with its attributes. A quoted attribute value is one value, whatever it holds. */
function tagsOf(html: string): Tag[] {
  const opening = /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
  const attribute = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  return [...html.matchAll(opening)].map((tag) => ({
    name: tag[1].toLowerCase(),
    attributes: [...tag[2].matchAll(attribute)].map((a): [string, string] => [a[1].toLowerCase(), decoded(a[2] ?? a[3] ?? a[4] ?? '')]),
  }));
}

/** Everything that starts like a tag, read or not. */
const tagStarts = (html: string) => [...html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)/g)].map((m) => m[1].toLowerCase());
/** Each tag with the names of its attributes, in order: what the markup is, leaving out what it says. */
const shapeOf = (html: string) => tagsOf(html).map((t) => `${t.name}(${t.attributes.map(([name]) => name).join(' ')})`);

/** What markup `html` has that the same email with plain words (`plain`) does not. Empty when nothing got in. */
function injected(html: string, plain: string): string[] {
  const problems: string[] = [];
  const tags = tagsOf(html);
  if (tags.length !== tagStarts(html).length) problems.push(`a tag the reader could not take apart: ${tagStarts(html).join(' ')}`);
  for (const t of tags) {
    for (const [name, value] of t.attributes) {
      if (name.startsWith('on')) problems.push(`<${t.name} ${name}=...>`);
      if (/^\s*(https?:)?\/\/evil\.example/i.test(value)) problems.push(`<${t.name} ${name}="${value}">`);
    }
  }
  const shape = shapeOf(html);
  const expected = shapeOf(plain);
  if (shape.join(' ') !== expected.join(' ')) {
    problems.push(`tags that are not the email's own: ${shape.filter((s, i) => s !== expected[i]).slice(0, 3).join(', ')}`);
  }
  if (html.includes('<a href="https://evil.example"')) problems.push('a raw <a href="https://evil.example"');
  if (html.includes('<img src=x')) problems.push('a raw <img src=x');
  return problems;
}

/** An escape a mail client would show as the characters themselves: never right in a plain-text copy or a subject. */
const htmlEscapesIn = (s: string) => s.match(/&(?:lt|gt|quot|amp|#39);/g) ?? [];

// ── The hostile strings ──────────────────────────────────────────────────────────────────────────

const HOSTILE = [
  '<a href="https://evil.example">x</a>',
  '<img src=x onerror=alert(1)>',
  // Ends an attribute and the tag it is in, for a value that lands inside href="...".
  '"><img src=x onerror=alert(1)>',
];
const PLAIN = 'Plain words';

const variants = cases.flatMap((c) => stringPaths(c.args).flatMap((path) =>
  HOSTILE.map((payload) => ({ c, path, payload, field: `${c.label}: ${pathName(c, path)}` }))));

/**
 * The fields where any text that is not a real value stops the email, plain words included, so nothing is
 * sent and there is no HTML to read. None since 26 Oct 2026: a meeting's time is written in the recipient's
 * time zone, and a zone Intl does not know (it used to stop the confirmation email) now reads as UTC,
 * named, so the email still goes out.
 */
const REFUSED_WHATEVER_IT_HOLDS: string[] = [];

describe('the check itself', () => {
  it('sees markup that got into the HTML', () => {
    const plain = '<p style="a">Hi Plain words,</p><a href="https://app.rsn.network/x">Open</a>';
    expect(injected('<p style="a">Hi <img src=x onerror=alert(1)>,</p><a href="https://app.rsn.network/x">Open</a>', plain)).not.toEqual([]);
    expect(injected('<p style="a">Hi <a href="https://evil.example">x</a>,</p><a href="https://app.rsn.network/x">Open</a>', plain)).not.toEqual([]);
    expect(injected('<p style="a">Hi Plain words,</p><a href=""><img src=x onerror=alert(1)>">Open</a>', plain)).not.toEqual([]);
  });

  it('reads the same characters escaped, or inside a quoted value, as the text they are', () => {
    const plain = '<p style="a">Hi Plain words,</p><a href="Plain words">Open</a>';
    expect(injected(`<p style="a">Hi ${escaped('<img src=x onerror=alert(1)>')},</p><a href="${escaped('"><img src=x onerror=alert(1)>')}">Open</a>`, plain)).toEqual([]);
  });
});

describe('every email is fed hostile text in every field', () => {
  it('every export that builds or sends an email has a case here, and every other export is named as building none', () => {
    const exported = Object.keys(emailService).sort();
    const covered = [...new Set(cases.map((c) => c.fn))];
    expect(exported.filter((name) => !covered.includes(name as BuilderName))).toEqual(NOT_BUILDERS);
  });

  it.each(cases.map((c) => [c.label, c] as const))('%s: every argument has a name, and there is text in it to replace', (_label, c) => {
    expect(c.params).toHaveLength(c.args.length);
    expect(stringPaths(c.args).length).toBeGreaterThan(0);
  });

  it('no field stops an email whatever it holds: a meeting\'s time zone no calendar knows reads as UTC', async () => {
    const refused: string[] = [];
    for (const c of cases) {
      for (const path of stringPaths(c.args)) {
        await render(c.fn, withStringAt(c.args, path, PLAIN) as unknown[]).catch(() => refused.push(`${c.label}: ${pathName(c, path)}`));
      }
    }
    expect(refused).toEqual(REFUSED_WHATEVER_IT_HOLDS);
  });

  it.each(variants.map((v) => [`${v.field} = ${v.payload}`, v] as const))(
    '%s',
    async (_name, { c, path, payload, field }) => {
      const hostile = withStringAt(c.args, path, payload) as unknown[];
      if (REFUSED_WHATEVER_IT_HOLDS.includes(field)) {
        await expect(render(c.fn, hostile)).rejects.toThrow();
        expect(mockSend).not.toHaveBeenCalled();
        return;
      }
      const plain = await render(c.fn, withStringAt(c.args, path, PLAIN) as unknown[]);
      const sent = await render(c.fn, hostile);

      expect(injected(sent.html, plain.html)).toEqual([]);
      // The plain text and the subject are not HTML: they say what was typed, as it was typed.
      expect(htmlEscapesIn(sent.text)).toEqual([]);
      expect(htmlEscapesIn(sent.subject)).toEqual([]);
      // Whatever reaches the plain text is in the HTML too, as text: escaped, not dropped.
      if (sent.text.includes(payload)) expect(sent.html).toContain(escaped(payload));
    },
  );
});

describe('what people typed reads as they typed it', () => {
  const NAME = '<a href="https://evil.example">x</a>';

  it('the request to join, which needs no account, greets the name it was given as text', async () => {
    const sent = await render('sendJoinRequestConfirmationEmail', ['delivered+anyone@resend.dev', NAME]);
    expect(sent.html).toContain(`Hi ${escaped(NAME)},`);
    expect(sent.html).not.toContain(NAME);
    expect(sent.text).toContain(`Hi ${NAME},`);
  });

  it('a direct message is shown as the words that were sent', async () => {
    const snippet = 'Use <b>bold</b> & "quotes", it\'s fine';
    const sent = await render('sendDmNotificationEmail', ['delivered+ana@resend.dev', 'Ana', { senderName: 'Fatima', snippet, threadUrl: `${APP}/messages/c1` }]);
    expect(sent.html).toContain('Use &lt;b&gt;bold&lt;/b&gt; &amp; &quot;quotes&quot;, it&#39;s fine');
    expect(sent.text).toContain(`"${snippet}"`);
  });

  it('an admin\'s message keeps its line breaks and shows a tag as text', async () => {
    const body = 'Thanks.\nSee <a href="https://evil.example">this</a>.';
    const sent = await render('sendGenericEmail', ['delivered+sam@resend.dev', 'Sam', { subject: 'A note', body }]);
    expect(sent.html).toContain(`white-space:pre-wrap;">${escaped(body)}</p>`);
    expect(sent.text).toContain(body);
  });

  it('a name with an apostrophe or an ampersand still reads the same', async () => {
    const sent = await render('sendInviteEmail', ['delivered+guest@resend.dev', { ...inviteData, inviterName: "Seán O'Brien", targetName: 'Food & Drink' }]);
    expect(sent.html).toContain('<strong>Seán O&#39;Brien</strong>');
    expect(sent.html).toContain('<strong>Food &amp; Drink</strong>');
    expect(sent.subject).toBe("Seán O'Brien invited you to Food & Drink");
    expect(sent.text).toContain("Seán O'Brien has invited you to join an event — Food & Drink");
  });

  it('a link the server builds still opens the same address: its & is written &amp;, which every mail client reads as &', async () => {
    const link = `${APP}/auth/verify?token=abc&inviteCode=XYZ`;
    const sent = await render('sendMagicLinkEmail', ['delivered+ana@resend.dev', link]);
    const hrefs = tagsOf(sent.html).filter((t) => t.name === 'a').map((t) => t.attributes.find(([n]) => n === 'href')?.[1]);
    expect(hrefs).toContain(link);
    expect(sent.html).toContain(`href="${APP}/auth/verify?token=abc&amp;inviteCode=XYZ"`);
    expect(sent.text).toContain(link);
  });
});

// ── An address reserved for testing (26 Oct 2026) ────────────────────────────────────────────────
//
// The list above is every email there is, each with the arguments it needs, so it also answers whether any of them
// gets round sendEmail's refusal to offer the provider an email for a reserved address: the throwaway members of the
// platform's own runs (…@rsn-e2e.invalid) must cost the provider's quota nothing, whichever email they are sent.
// email-reserved-test-addresses.test.ts runs the rule itself.

/** The arguments with the recipient put on `address`: the first argument, or the `to` of the options the balance alert takes. */
function addressedTo(c: Case, address: string): unknown[] {
  const [first, ...rest] = c.args;
  return typeof first === 'string' ? [address, ...rest] : [{ ...(first as object), to: address }, ...rest];
}

describe('to an address reserved for testing, every email stops before the provider', () => {
  const senders = cases.filter((c) => c.fn.startsWith('send'));

  it.each(senders.map((c) => [c.label, c] as const))('%s', async (_label, c) => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({ error: null });
    await (emailService[c.fn] as unknown as (...a: unknown[]) => Promise<unknown>)(...addressedTo(c, 'e2etest-1@rsn-e2e.invalid'));
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('and the same emails to a real address do reach it, so the check above is not passing for want of a send', async () => {
    for (const c of senders) {
      const sent = await render(c.fn, addressedTo(c, 'delivered+ana@resend.dev'));
      expect(sent.subject).toBeTruthy();
    }
  });
});
