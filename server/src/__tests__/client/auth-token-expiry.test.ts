// ─── The proactive token refresh reads every token ───────────────────────────
// (8 Oct 2026)
//
// authStore's getTokenExpiryMs reads a JWT's `exp` so the store can refresh the access token two
// minutes before it runs out. It decoded the payload with a plain atob, which throws on the
// base64url characters "-" and "_" (a JWT is base64url, not base64). The function swallows the
// throw and answers "no expiry", so a token whose payload held either character was never
// refreshed ahead of time: the member met a 401 first, and the interceptor had to recover.
//
// The client has no test runner of its own, and the store needs a browser (localStorage, the app's
// api module), so this lifts the real function out of the store's source, compiles it to plain
// JavaScript and runs it. What is tested is the code that ships, not a copy of it.

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const STORE = fs.readFileSync(path.join(__dirname, '../../../../client/src/stores/authStore.ts'), 'utf8')
  .replace(/\r\n/g, '\n');

/**
 * The function, lifted out of `source` (the store's text) and compiled to plain JavaScript. If it cannot be
 * found the error says what to do about it, rather than a bare "expected -1 to be >= 0" from the lookup.
 */
function loadGetTokenExpiryMs(source: string = STORE): (token: string) => number | null {
  const start = source.indexOf('function getTokenExpiryMs(');
  if (start < 0) {
    throw new Error(
      'auth-token-expiry.test: could not find "function getTokenExpiryMs(" in client/src/stores/authStore.ts. '
      + 'This test lifts that function out of the store\'s source and runs it, so if it was renamed, moved or '
      + 'rewritten (an arrow function, say), update the lookup here and keep a test for base64url tokens.',
    );
  }
  const end = source.indexOf('\n}\n', start);
  if (end < 0) {
    throw new Error(
      'auth-token-expiry.test: found getTokenExpiryMs in client/src/stores/authStore.ts but not where it ends '
      + '(a "}" in column 0 on a line of its own). Update the lookup here.',
    );
  }
  const { outputText } = ts.transpileModule(source.slice(start, end + 2), {
    compilerOptions: { target: ts.ScriptTarget.ES2019 },
  });
  return new Function('atob', `${outputText}\nreturn getTokenExpiryMs;`)(atob);
}

const getTokenExpiryMs = loadGetTokenExpiryMs();

describe('finding the function to test', () => {
  it('says plainly when the store no longer has getTokenExpiryMs', () => {
    expect(() => loadGetTokenExpiryMs('const x = 1;\n')).toThrow(
      /could not find "function getTokenExpiryMs\(" in client\/src\/stores\/authStore\.ts/,
    );
  });

  it('says plainly when it cannot tell where the function ends', () => {
    expect(() => loadGetTokenExpiryMs('function getTokenExpiryMs(token: string) { return null;\n')).toThrow(
      /not where it ends/,
    );
  });
});

const EXPIRES = 1893456000; // 1 Jan 2030, in seconds, as a JWT carries it

const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const tokenWith = (payload: object) => `${segment({ alg: 'HS256', typ: 'JWT' })}.${segment(payload)}.signature`;
const payloadOf = (token: string) => token.split('.')[1];

describe('getTokenExpiryMs', () => {
  // ">>>" encodes to a base64 "+" (a "-" in base64url) and "???" to a "/" (a "_"); one to three
  // letters in front move them across every alignment a payload can have.
  const FILLERS = ['', 'a', 'aa', 'aaa'];

  it.each(FILLERS)('reads the expiry when the payload holds a "-" (filler "%s")', (filler) => {
    const token = tokenWith({ exp: EXPIRES, note: `${filler}>>>` });
    expect(payloadOf(token)).toMatch(/-/);
    expect(getTokenExpiryMs(token)).toBe(EXPIRES * 1000);
  });

  it.each(FILLERS)('reads the expiry when the payload holds a "_" (filler "%s")', (filler) => {
    const token = tokenWith({ exp: EXPIRES, note: `${filler}???` });
    expect(payloadOf(token)).toMatch(/_/);
    expect(getTokenExpiryMs(token)).toBe(EXPIRES * 1000);
  });

  it('reads the expiry when the payload holds both', () => {
    const token = tokenWith({ exp: EXPIRES, note: '>>>???' });
    expect(payloadOf(token)).toMatch(/-.*_|_.*-/);
    expect(getTokenExpiryMs(token)).toBe(EXPIRES * 1000);
  });

  it('still reads the expiry of a payload that holds neither', () => {
    const token = tokenWith({ sub: 'u1', exp: EXPIRES });
    expect(payloadOf(token)).not.toMatch(/[-_]/);
    expect(getTokenExpiryMs(token)).toBe(EXPIRES * 1000);
  });

  it('answers "no expiry" for anything that is not a token with a numeric exp', () => {
    expect(getTokenExpiryMs('')).toBeNull();
    expect(getTokenExpiryMs('not-a-token')).toBeNull();
    expect(getTokenExpiryMs('a.b.c')).toBeNull();
    expect(getTokenExpiryMs(tokenWith({ sub: 'u1' }))).toBeNull();
    expect(getTokenExpiryMs(tokenWith({ exp: String(EXPIRES) }))).toBeNull();
  });
});
