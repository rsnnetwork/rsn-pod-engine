// ─── Coming back from Google does not leave the sign-in button stuck ─────────
// (8 Oct 2026)
//
// "Continue with Google" turns into a disabled "Redirecting..." the moment it is pressed, and the
// browser then leaves the page. Press Back from Google and many browsers (Safari on a phone above
// all) do not load the page again: they put it back from their back-forward cache exactly as it was
// left, button still disabled, and no code runs, so it never comes back to life. The one thing that
// does run is a `pageshow` event with `persisted` set. The client has no test runner of its own, so,
// like the other files here, this reads the source and pins the listener: it resets the button only
// for a restore from the cache, and takes the listener off when the page goes.
//
// That the button really is usable again after such an event is proven in a real browser by
// e2e/tests/login-back-from-google.spec.ts.

import * as fs from 'fs';
import * as path from 'path';

const LOGIN = fs.readFileSync(path.join(__dirname, '../../../../client/src/features/auth/LoginPage.tsx'), 'utf8')
  .replace(/\r\n/g, '\n');

/** The effect that listens for `pageshow`: its body, and what is in its dependency list. */
function pageshowEffect(source: string): { body: string; deps: string } {
  const at = source.indexOf("addEventListener('pageshow'");
  expect(at).toBeGreaterThanOrEqual(0);
  const start = source.lastIndexOf('useEffect(', at);
  expect(start).toBeGreaterThanOrEqual(0);
  const closing = '\n  }, [';
  const close = source.indexOf(closing, start);
  expect(close).toBeGreaterThan(at);
  const depsEnd = source.indexOf(']);', close);
  expect(depsEnd).toBeGreaterThan(close);
  return { body: source.slice(start, close), deps: source.slice(close + closing.length, depsEnd) };
}

describe('the sign-in page when the browser brings it back from its cache', () => {
  const { body, deps } = pageshowEffect(LOGIN);

  it('listens for pageshow on the window', () => {
    expect(body).toMatch(/window\.addEventListener\('pageshow', onPageShow\)/);
  });

  it('turns the Google button back on only when the page was restored from the cache', () => {
    expect(body).toMatch(/if \(event\.persisted\) setGoogleLoading\(false\);/);
    expect(body).not.toMatch(/setGoogleLoading\(true\)/);
  });

  it('takes the listener off when the page goes, with the same handler it put on', () => {
    expect(body).toMatch(/return \(\) => window\.removeEventListener\('pageshow', onPageShow\);/);
  });

  it('is set up once, not on every render: the effect depends on nothing', () => {
    expect(deps).toBe('');
  });

  it('still disables the button, and says Redirecting, for exactly as long as googleLoading is set', () => {
    expect(LOGIN).toMatch(/disabled=\{googleLoading\}/);
    expect(LOGIN).toMatch(/\{googleLoading \? 'Redirecting\.\.\.' : 'Continue with Google'\}/);
  });
});
