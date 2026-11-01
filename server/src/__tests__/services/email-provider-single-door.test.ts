// ─── One door to the mail provider (26 Oct 2026) ─────────────────────────────────────────────────────
//
// Whether an email is offered to the mail provider is decided in one place: sendEmail in email.service.ts, which
// does not offer one to an address reserved for testing (email-reserved-test-addresses.test.ts runs that). That
// only holds while nothing else talks to the provider. A second call, or a second provider, anywhere in the
// server would send test-account emails again and spend the production quota the platform's own runs once used up.
//
// This reads the source, because a new call is a new line of code and no behaviour test can be written for a
// line nobody has written yet. A change that has a reason to talk to the provider elsewhere must route it through
// sendEmail, or change this test on purpose and say why.

import * as fs from 'fs';
import * as path from 'path';

const SERVER = path.join(__dirname, '../../..');
const DOOR = path.join(SERVER, 'src', 'services', 'email', 'email.service.ts');

/** Every source file the server runs or ships: the code under src (tests left out) and the scripts. */
function sourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' || entry.name === 'node_modules' ? [] : sourceFiles(full);
    return /\.(?:ts|js|mjs|cjs)$/.test(entry.name) && !/\.(?:test|spec|d)\.[tj]s$/.test(entry.name) ? [full] : [];
  });
}

/** The file with its comments taken out. A comment starts at a // after a space or at the start of a line. */
const withoutComments = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/.*$/gm, '$1');

const codeOf = (file: string) => withoutComments(fs.readFileSync(file, 'utf8'));
const relative = (file: string) => path.relative(SERVER, file).split(path.sep).join('/');
const count = (text: string, pattern: RegExp) => (text.match(new RegExp(pattern.source, 'g')) ?? []).length;

const SOURCES = [...sourceFiles(path.join(SERVER, 'src')), ...sourceFiles(path.join(SERVER, 'scripts'))];
const OTHERS = SOURCES.filter((file) => file !== DOOR);

/** The ways to reach a mail provider: its library, its HTTP address, another provider's library, a send call. */
const WAYS_IN: Array<[string, RegExp]> = [
  ['the provider\'s library', /(?:from|require\(|import\()\s*['"]resend['"]/],
  ['the provider\'s HTTP API', /api\.resend\.com/i],
  ['a send call on a client', /\.(?:emails|batch)\.send\s*\(/],
  ['another provider\'s library', /['"](?:nodemailer|@sendgrid\/[\w-]+|mailgun[\w.-]*|postmark|@aws-sdk\/client-ses[\w-]*|@mailchimp\/[\w-]+)['"]/i],
];

describe('nothing but email.service.ts talks to a mail provider', () => {
  it('the scan reaches the door and the code around it', () => {
    expect(SOURCES).toContain(DOOR);
    expect(SOURCES.some((file) => relative(file) === 'src/index.ts')).toBe(true);
    expect(SOURCES.some((file) => relative(file).startsWith('src/routes/'))).toBe(true);
    expect(SOURCES.some((file) => relative(file).startsWith('src/__tests__/'))).toBe(false);
  });

  it.each(WAYS_IN)('%s is not used anywhere else', (_way, pattern) => {
    const offenders = OTHERS.filter((file) => pattern.test(codeOf(file))).map(relative);
    expect(offenders).toEqual([]);
  });

  it('the check sees what it is there to see', () => {
    const door = codeOf(DOOR);
    expect(WAYS_IN.filter(([, pattern]) => pattern.test(door)).map(([way]) => way)).toEqual([
      'the provider\'s library',
      'a send call on a client',
    ]);
    expect(withoutComments('const a = 1; // client.emails.send(x)\n/* new Resend(k) */ const b = 2;')).not.toMatch(/emails\.send|Resend/);
  });
});

describe('inside email.service.ts, the provider is reached once, by sendEmail, after the reserved-address check', () => {
  const door = codeOf(DOOR);
  const start = door.indexOf('async function sendEmail(');
  const length = door.slice(start + 1).search(/\r?\n(?:export )?(?:async )?function /);
  const sendEmail = door.slice(start, start + 1 + length);

  it('sendEmail is found, and is the function that ends before the next one', () => {
    expect(start).toBeGreaterThan(-1);
    expect(length).toBeGreaterThan(0);
    expect(sendEmail).toMatch(/^async function sendEmail\(/);
    expect(sendEmail.match(/\basync function\b|\bfunction\b/g)).toHaveLength(1);
  });

  it('there is one library client, made once, and one send call', () => {
    expect(count(door, /new Resend\(/)).toBe(1);
    expect(count(door, /\.emails\.send\s*\(/)).toBe(1);
    expect(count(door, /\.batch\.send\s*\(/)).toBe(0);
  });

  it('the send call and the making of the client are inside sendEmail, and nowhere else', () => {
    expect(count(sendEmail, /\.emails\.send\s*\(/)).toBe(1);
    expect(count(sendEmail, /getResendClient\(\)/)).toBe(1);
    // Everything of the file outside sendEmail: the client is made in getResendClient, and no other function asks for it.
    const outside = door.slice(0, start) + door.slice(start + 1 + length);
    expect(count(outside, /getResendClient\(\)/)).toBe(1);
    expect(outside).toMatch(/function getResendClient\(\): Resend \{/);
  });

  it('the reserved-address check runs before the client is made and before the send call', () => {
    const check = sendEmail.indexOf('isReservedTestAddress(');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(sendEmail.indexOf('getResendClient()'));
    expect(check).toBeLessThan(sendEmail.indexOf('.emails.send('));
    expect(door).toMatch(/import \{[^}]*\bisReservedTestAddress\b[^}]*\} from '..\/identity\/reserved-address'/);
  });

  it('the check ends in a return, so the send call is not reached for a reserved address', () => {
    const block = sendEmail.match(/if \(isReservedTestAddress\(opts\.to\)\) \{[\s\S]*?\r?\n {2}\}/)?.[0] ?? '';
    expect(block).toMatch(/\breturn \{ sent: true\b/);
  });
});
