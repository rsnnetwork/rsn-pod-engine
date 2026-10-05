// How long a meeting request's message may be is one number, read in three places: the
// route that takes the message in, the cleaning that stores it, and the reason budget
// that words it to fit. Their own tests measure each against REQUEST_MESSAGE_MAX
// (pokes-send.test.ts, poke.service.test.ts, platform-match.test.ts). This reads the
// three sources so that a second, hand-typed copy of the number cannot creep back in.

import * as fs from 'fs';
import * as path from 'path';
import { REQUEST_MESSAGE_MAX } from '../../../services/poke/request-message';

const SERVER_SRC = path.join(__dirname, '../../..');
const readSource = (rel: string) => fs.readFileSync(path.join(SERVER_SRC, rel), 'utf8');

const PLACES = [
  'routes/pokes.ts', // validates the message on the way in
  'services/poke/poke.service.ts', // cleans it for storage
  'services/matching/platform-match.service.ts', // words the introduction to fit
];

describe('the request message cap is one number', () => {
  it('is a positive whole number of characters', () => {
    expect(Number.isInteger(REQUEST_MESSAGE_MAX)).toBe(true);
    expect(REQUEST_MESSAGE_MAX).toBeGreaterThan(0);
  });

  it.each(PLACES)('%s reads it from request-message, and keeps no hand-typed copy', (file) => {
    const source = readSource(file);
    expect(source).toMatch(/import \{[^}]*\bREQUEST_MESSAGE_MAX\b[^}]*\} from '[./]+(?:services\/)?(?:poke\/)?request-message'/);
    // A cap written out as a number: .max(500), .slice(0, 500), = 500.
    expect(source).not.toMatch(/\.max\(\s*500\s*\)|\.slice\(\s*0\s*,\s*500\s*\)|=\s*500\b/);
    // And it is the constant that is actually applied.
    expect(source).toMatch(/\.max\(REQUEST_MESSAGE_MAX\)|\.slice\(0,\s*REQUEST_MESSAGE_MAX\)|REQUEST_MESSAGE_MAX\s*-/);
  });

  it('is declared once, in request-message', () => {
    const declaring = [
      ...PLACES, 'services/poke/request-message.ts',
    ].filter((file) => /\bconst\s+REQUEST_MESSAGE_MAX\b/.test(readSource(file)));
    expect(declaring).toEqual(['services/poke/request-message.ts']);
  });
});
