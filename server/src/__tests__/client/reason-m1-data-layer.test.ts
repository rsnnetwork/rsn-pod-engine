// server/src/__tests__/client/reason-m1-data-layer.test.ts
// The REASON client's pure helpers, EXECUTED. The other client tests here read source as text; these
// import the modules, which is possible because they have no axios, store or router behind them.
import * as fs from 'fs';
import * as path from 'path';
import { primaryActionFor } from '@rsn/shared';
import { errorMessage } from '../../../../client/src/features/reason/errors';
import { personName, stateFromPoke, visibleText } from '../../../../client/src/features/reason/person';
import { NEXT_MOVE, PRIMARY_LABEL, STATE_LABEL } from '../../../../client/src/features/reason/human/labels';

// Working-tree files are CRLF on Windows; normalise so patterns match either way.
const readRepo = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../../', rel), 'utf8').replace(/\r\n/g, '\n');
const readReason = (rel: string) => readRepo(`client/src/features/reason/${rel}`);

const FALLBACK = 'Could not do that. Try again in a moment.';
const CONNECTION_LOST = 'Connection lost. Check your internet and try again.';
const UUID = '3f2b8a4e-1c9d-4e7a-b6f0-2a5c8d1e9f03';

// What axios hands a catch block when the server refused: the error envelope under response.data.
const refused = (status: number, error: { message?: unknown; details?: unknown } = {}) =>
  ({ isAxiosError: true, response: { status, data: { success: false, error } } });

describe('errorMessage: a request that got no answer', () => {
  // What axios throws when the request went out and nothing came back.
  const networkError = Object.assign(new Error('Network Error'), { isAxiosError: true, code: 'ERR_NETWORK', request: {} });
  const timeout = Object.assign(new Error('timeout of 60000ms exceeded'), { isAxiosError: true, code: 'ECONNABORTED', request: {} });

  it('says the connection was lost for a network failure and for a timeout', () => {
    for (const err of [networkError, timeout]) {
      expect(errorMessage(err, FALLBACK)).toBe(CONNECTION_LOST);
      // Never the library's own words (CLAUDE.md section 6).
      expect(errorMessage(err, FALLBACK)).not.toMatch(/Network Error|AxiosError|timeout/i);
    }
  });

  it('knows such an error by any one of its marks: isAxiosError, a request, or a network code', () => {
    expect(errorMessage({ isAxiosError: true }, FALLBACK)).toBe(CONNECTION_LOST);
    expect(errorMessage({ isAxiosError: true, response: undefined }, FALLBACK)).toBe(CONNECTION_LOST);
    expect(errorMessage({ request: {} }, FALLBACK)).toBe(CONNECTION_LOST);
    for (const code of ['ERR_NETWORK', 'ECONNABORTED', 'ETIMEDOUT']) {
      expect(errorMessage({ code }, FALLBACK)).toBe(CONNECTION_LOST);
    }
  });

  it('gives the caller\'s fallback for anything else with no response: a bug in our code is not a lost connection', () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'id')");
    for (const err of [bug, 'boom', 42, undefined, null, {}, { response: undefined }, { code: 'ERR_SOMETHING_ELSE' }, { message: 'Network Error' }]) {
      expect(errorMessage(err, FALLBACK)).toBe(FALLBACK);
    }
  });
});

describe('errorMessage: copy keyed on the HTTP status', () => {
  it('429 asks the member to slow down, whatever the server wrote', () => {
    expect(errorMessage(refused(429, { message: 'Too many requests. Please try again later.' }), FALLBACK))
      .toBe('Slow down a moment, then try again.');
    expect(errorMessage(refused(429), FALLBACK)).toBe('Slow down a moment, then try again.');
  });

  it('404 says the person is no longer available, and the id in the server text never reaches the member', () => {
    const notFound = errorMessage(refused(404, { message: `User with id ${UUID} not found` }), FALLBACK);
    expect(notFound).toBe('This person is no longer available.');
    expect(notFound).not.toContain(UUID);
    expect(notFound).not.toContain(UUID.slice(0, 8));
    expect(errorMessage(refused(404, { message: 'Route GET /people/x/brief not found' }), FALLBACK))
      .toBe('This person is no longer available.');
  });

  it('every other status (5xx, 401, 413, 422, no status at all) gives the caller\'s fallback and none of the server text', () => {
    for (const status of [500, 502, 503, 401, 402, 413, 422]) {
      expect(errorMessage(refused(status, { message: `Something broke for ${UUID}: relation "user_pokes" does not exist` }), FALLBACK))
        .toBe(FALLBACK);
    }
    expect(errorMessage({ response: { data: { error: { message: 'Hello' } } } }, FALLBACK)).toBe(FALLBACK);
  });

  it('a body that is not the usual envelope (a proxy\'s HTML page, nothing at all) gives the fallback instead of crashing', () => {
    for (const status of [400, 403, 409, 500, 502]) {
      expect(errorMessage({ response: { status, data: '<html><body>Bad gateway</body></html>' } }, FALLBACK)).toBe(FALLBACK);
      expect(errorMessage({ response: { status, data: null } }, FALLBACK)).toBe(FALLBACK);
      expect(errorMessage({ response: { status } }, FALLBACK)).toBe(FALLBACK);
    }
  });
});

describe('errorMessage: 400', () => {
  it('with details gives the first details line, which is written for members, not the generic "Validation failed"', () => {
    expect(errorMessage(refused(400, {
      message: 'Validation failed',
      details: { note: ['Keep the note to 300 characters or fewer.'] },
    }), FALLBACK)).toBe('Keep the note to 300 characters or fewer.');
  });

  it('takes the first line of the first field that has one', () => {
    expect(errorMessage(refused(400, {
      message: 'Validation failed',
      details: { note: ['First line.', 'Second line.'], format: ['Other field.'] },
    }), FALLBACK)).toBe('First line.');
    expect(errorMessage(refused(400, {
      message: 'Validation failed',
      details: { note: [], format: ['Choose one of the offered formats.'] },
    }), FALLBACK)).toBe('Choose one of the offered formats.');
  });

  it('never shows an id from a details line either, and never falls back to "Validation failed"', () => {
    expect(errorMessage(refused(400, {
      message: 'Validation failed',
      details: { userId: [`Not a member id: ${UUID}`] },
    }), FALLBACK)).toBe(FALLBACK);
    // Details present but with no line to show: still the caller's fallback, not the generic message.
    for (const details of [{}, { note: [] }, { note: [''] }, { note: [42] }]) {
      expect(errorMessage(refused(400, { message: 'Validation failed', details }), FALLBACK)).toBe(FALLBACK);
    }
  });

  it('with no details gives the server\'s sentence when it is safe to show', () => {
    expect(errorMessage(refused(400, { message: 'You can already message them.' }), FALLBACK)).toBe('You can already message them.');
    expect(errorMessage(refused(400, { message: '  This is your own profile  ' }), FALLBACK)).toBe('This is your own profile');
    expect(errorMessage(refused(400, { message: `Bad request for ${UUID}` }), FALLBACK)).toBe(FALLBACK);
  });
});

// Every 400 (with no details), 403 and 409 a member can reach from Save, Pass, Meet, the outcome form and
// the profile brief, read off the throw sites in server/src/services (poke, people, matching, block). Each
// one reads well to a member, so each is shown as the server wrote it. The tripwire below fails if the
// server rewords one, so the copy gets read again before the client keeps showing it.
const FRIENDLY: Array<{ status: number; message: string; site: string }> = [
  { status: 403, message: 'They declined your earlier request, so you cannot send another one.', site: 'services/poke/poke.service.ts' },
  { status: 409, message: 'You have already asked to meet them — they have not answered yet.', site: 'services/poke/poke.service.ts' },
  { status: 400, message: 'You can already message them.', site: 'services/poke/poke.service.ts' },
  { status: 409, message: 'You can record what happened once you two are connected.', site: 'services/people/meeting-outcome.service.ts' },
  { status: 400, message: 'You cannot save or pass yourself', site: 'services/people/person-response.service.ts' },
  { status: 400, message: 'You cannot record a meeting with yourself', site: 'services/people/meeting-outcome.service.ts' },
  { status: 400, message: 'This is your own profile', site: 'services/people/person-brief.service.ts' },
];

describe('errorMessage: 403 and 409 are business refusals the member should read', () => {
  it.each(FRIENDLY)('$status "$message" is shown as written', ({ status, message }) => {
    expect(errorMessage(refused(status, { message }), FALLBACK)).toBe(message);
  });

  it.each(FRIENDLY)('$status "$message" is still what the server says (re-read the copy if this fails)', ({ message, site }) => {
    expect(readRepo(`server/src/${site}`)).toContain(message);
  });

  it('403 and 409 carrying an id or an id fragment give the fallback', () => {
    for (const status of [403, 409]) {
      expect(errorMessage(refused(status, { message: `Request ${UUID} was already answered.` }), FALLBACK)).toBe(FALLBACK);
      expect(errorMessage(refused(status, { message: 'Request 3f2b8a4e is still open.' }), FALLBACK)).toBe(FALLBACK);
      expect(errorMessage(refused(status, { message: 'Participant 3f2b8a is blocked.' }), FALLBACK)).toBe(FALLBACK);
      expect(errorMessage(refused(status, { message: 'Seen at 3f2b8a4e-1c9d.' }), FALLBACK)).toBe(FALLBACK);
    }
  });

  it('plain numbers and ordinary words are not mistaken for ids', () => {
    expect(errorMessage(refused(409, { message: 'Try again in 60 seconds, after the 300 character limit.' }), FALLBACK))
      .toBe('Try again in 60 seconds, after the 300 character limit.');
    expect(errorMessage(refused(403, { message: 'A decade of facade defaced.' }), FALLBACK)).toBe('A decade of facade defaced.');
  });

  it('403 and 409 with an empty, over-long or non-text message give the fallback', () => {
    for (const status of [403, 409, 400]) {
      for (const message of ['', '   ', 'x'.repeat(201), undefined, 42, { text: 'no' }, ['no']]) {
        expect(errorMessage(refused(status, { message }), FALLBACK)).toBe(FALLBACK);
      }
    }
    // The cap is generous: a real sentence of 200 characters still gets through.
    expect(errorMessage(refused(409, { message: 'x'.repeat(200) }), FALLBACK)).toBe('x'.repeat(200));
  });

  it('keeps the server\'s own word "poke" away from members: it means a meeting request, and only the code says it', () => {
    // The two technical messages on these routes (sendPoke: blocked, and asking yourself).
    expect(errorMessage(refused(403, { message: 'Cannot poke this user' }), FALLBACK)).toBe(FALLBACK);
    expect(errorMessage(refused(400, { message: 'You cannot poke yourself' }), FALLBACK)).toBe(FALLBACK);
    expect(errorMessage(refused(409, { message: 'Poke already accepted' }), FALLBACK)).toBe(FALLBACK);
    // "poker" is a different word.
    expect(errorMessage(refused(403, { message: 'The poker night is full.' }), FALLBACK)).toBe('The poker night is full.');
  });
});

describe('stateFromPoke: where a meeting request stands, for the card', () => {
  it.each([
    ['accepted', true, 'connected'],
    ['accepted', false, 'connected'],
    ['accepted', null, 'connected'],
    ['pending', true, 'requested'],
    ['pending', false, 'incoming'],
    ['pending', null, 'incoming'],
    [null, null, 'none'],
    [null, true, 'none'],
  ] as const)('%s, sent by the member: %s gives %s', (status, sentByOwner, state) => {
    expect(stateFromPoke(status, sentByOwner)).toBe(state);
  });

  it('a missing status (a server that leaves the key out) is no request at all', () => {
    expect(stateFromPoke(undefined as unknown as null, null)).toBe('none');
  });

  it('gives the main button the right job: Meet, nothing to press, Respond, Continue', () => {
    expect(primaryActionFor(stateFromPoke(null, null))).toBe('meet');
    expect(primaryActionFor(stateFromPoke('pending', true))).toBe('requested');
    expect(primaryActionFor(stateFromPoke('pending', false))).toBe('respond');
    expect(primaryActionFor(stateFromPoke('accepted', true))).toBe('continue');
  });
});

describe('personName: the server can send a null name', () => {
  it('returns the trimmed name', () => {
    expect(personName('Ada Lovelace')).toBe('Ada Lovelace');
    expect(personName('  Ada Lovelace \n')).toBe('Ada Lovelace');
    expect(personName('Ada  Lovelace')).toBe('Ada  Lovelace');
  });
  it('uses the app\'s existing word for a member with no name when there is none to show', () => {
    for (const blank of [null, undefined, '', '   ', '\n\t', ' ']) {
      expect(personName(blank)).toBe('Member');
    }
  });
});

describe('visibleText: an optional field is shown only when it has text a member can see', () => {
  it('is null for nothing, empty and whitespace-only values', () => {
    for (const blank of [null, undefined, '', ' ', '   ', '\n', '\t \n']) {
      expect(visibleText(blank)).toBeNull();
    }
  });
  it('is the trimmed text otherwise', () => {
    expect(visibleText('Founder')).toBe('Founder');
    expect(visibleText('  Fintech  ')).toBe('Fintech');
  });
});

describe('labels: every relationship state has its words', () => {
  const states = Object.keys(STATE_LABEL) as Array<keyof typeof STATE_LABEL>;
  it.each(states)('%s has a button label, a state label and a next move', (state) => {
    expect(PRIMARY_LABEL[primaryActionFor(state)]).toBeTruthy();
    expect(STATE_LABEL[state]).toBeTruthy();
    expect(NEXT_MOVE[state]).toBeTruthy();
  });
  it('says "event", never "session", and the buttons read as the end-to-end specs select them', () => {
    expect([...Object.values(PRIMARY_LABEL), ...Object.values(STATE_LABEL), ...Object.values(NEXT_MOVE)].join(' ')).not.toMatch(/session/i);
    expect(PRIMARY_LABEL.meet).toBe('Meet');
    expect(PRIMARY_LABEL.requested).toBe('Request sent');
    expect(PRIMARY_LABEL.declined).toBe('Request declined');
  });
});

describe('the data layer keeps the surface the pages import', () => {
  const api = () => readReason('api.ts');
  it('exports the keys, fetchers and writers by name', () => {
    for (const name of ['reasonKeys', 'fetchForYou', 'fetchBrief', 'fetchRecentConnections', 'setPersonResponse', 'sendMeetRequest', 'recordOutcomeRequest']) {
      expect(api()).toMatch(new RegExp(`^export const ${name}\\b`, 'm'));
    }
    expect(api()).toMatch(/^export interface ForYouMatch\b/m);
    expect(api()).toMatch(/^export interface ForYouPayload\b/m);
  });
  it('re-exports the pure helpers, so every page still imports them from ../api', () => {
    expect(api()).toMatch(/^export \{ errorMessage \} from '\.\/errors';/m);
    expect(api()).toMatch(/^export \{ personName, stateFromPoke \} from '\.\/person';/m);
  });
  it('types the name as the server sends it: it can be null', () => {
    expect(api()).toMatch(/export interface ForYouMatch \{[^}]*\n  displayName: string \| null;/);
    // The card takes a real name: the page maps the null through personName.
    expect(readReason('human/HumanCard.tsx')).toMatch(/export interface HumanCardPerson \{[^}]*\n  displayName: string;/);
  });
  it('keeps the pure helpers free of anything Jest could not import (no store, router, axios or alias)', () => {
    for (const file of ['errors.ts', 'person.ts']) {
      // Type-only imports are erased, so they are fine; any other import is something Jest would have to load.
      const runtimeImports = [...readReason(file).matchAll(/^import\b(?!\s+type\b)[\s\S]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
      expect({ file, runtimeImports }).toEqual({ file, runtimeImports: [] });
    }
  });
});

// WCAG relative luminance and contrast ratio, for the one pair in the card that the prototype left under AA.
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('the Human Card: faults found by looking at it', () => {
  const card = () => readReason('human/HumanCard.tsx');

  it('every button on it is at least 44px tall', () => {
    const buttons = card().match(/<button\b/g)?.length ?? 0;
    expect(buttons).toBe(2);
    expect(card().match(/min-h-\[44px\]/g)?.length).toBe(buttons);
  });
  it('a busy card looks busy, not only disabled: progress cursor, a pulse (still, but dimmed, for reduced motion) and aria-busy', () => {
    expect(card()).toMatch(/cursor-progress/);
    expect(card()).toMatch(/motion-safe:animate-pulse/);
    expect(card()).toMatch(/motion-reduce:opacity-60/);
    expect(card()).toMatch(/aria-busy=\{busy \|\| undefined\}/);
  });
  it('the inert "Request sent" / "Request declined" button is never dimmed, so it stays readable', () => {
    // Busy styling is for buttons that are doing something; the inert one has nothing to do.
    expect(card()).toMatch(/busy && !inert && BUSY/);
    expect(card()).not.toMatch(/disabled:opacity/);
  });
  it('the red button only reacts to a hover while it can be pressed', () => {
    expect(card()).toMatch(/enabled:hover:bg-reason-red-hover/);
  });
  it('optional fields and tags are shown only when they have text', () => {
    for (const field of ['person.role', 'person.company', 'person.reason', 'person.theyCanBring', 'person.youAreLookingFor']) {
      expect(card()).toContain(`visibleText(${field})`);
    }
    expect(card()).toMatch(/person\.tags\.map\(visibleText\)\.filter\(/);
  });
  it('long unbroken text in any field wraps instead of being clipped by the card', () => {
    // name, role, company, tags, reason and both offer/want blocks
    expect(card().match(/\[overflow-wrap:anywhere\]/g)?.length).toBeGreaterThanOrEqual(7);
  });
  it('the inert label reads: at least 4.5:1 (AA) on its grey', () => {
    const pair = card().match(/inert\s*\?\s*'bg-\[(#[0-9a-f]{6})\] text-\[(#[0-9a-f]{6})\]'/i);
    expect(pair).not.toBeNull();
    expect(contrast(pair![1], pair![2])).toBeGreaterThanOrEqual(4.5);
  });
  it('words the name inside the card, so a page that passes a blank one does not draw an empty heading', () => {
    expect(card()).toMatch(/const name = personName\(person\.displayName\);/);
    // Every place the name is drawn or used goes through it.
    expect(card()).not.toMatch(/\{person\.displayName\}/);
    expect(card()).not.toMatch(/name=\{person\.displayName\}/);
  });
  it('the photo is a pointer-only target, so the name is the one link a keyboard or a screen reader meets', () => {
    expect(card()).toMatch(/<Link to=\{profileUrl\} aria-hidden="true" tabIndex=\{-1\} className="block">/);
    expect(card()).not.toMatch(/aria-label=\{`Open /);
  });
  it('the Save button says its state in its label only, with no aria-pressed announcing it twice', () => {
    expect(card()).not.toMatch(/aria-pressed=/);
    expect(card()).toMatch(/\{person\.saved \? 'Saved' : 'Save'\}/);
  });
  it('the card is named by its heading, so a screen reader can tell one card from the next', () => {
    expect(card()).toMatch(/const headingId = useId\(\);/);
    expect(card()).toMatch(/aria-labelledby=\{headingId\}/);
    expect(card()).toMatch(/<h3 id=\{headingId\}/);
  });
});
