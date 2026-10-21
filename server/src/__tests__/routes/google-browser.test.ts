// The browser the Google sign-in route tests use (google-browser.ts) is only worth anything if it keeps and sends cookies the
// way a real one does, because it is what lets those tests see WHICH host holds the cookie and which host Google returns
// to. Its rules, pinned: no server, no Google, no routes.

import express from 'express';
import { Browser } from './google-browser';

const browser = () => new Browser(express(), ['api.rsn.network']);
const API = 'https://api.rsn.network';
const START = `${API}/api/auth/google`;
const CALLBACK = `${API}/api/auth/google/callback`;

describe('a cookie without Domain belongs to the host that set it, and to no other', () => {
  it('is sent back to that host and not to another, whatever the other host\'s name', () => {
    const jar = browser();
    jar.hear(START, 'a=1; Path=/');
    expect(jar.cookieHeaderFor(CALLBACK)).toBe('a=1');
    for (const other of ['https://rsn-api-h04m.onrender.com/', 'https://rsn.network/', 'https://evil.rsn.network/', 'https://xapi.rsn.network/', 'https://api.rsn.network.evil.example/']) {
      expect(jar.cookieHeaderFor(other)).toBeUndefined();
    }
  });

  it('is not sent to a subdomain of the host that set it', () => {
    const jar = browser();
    jar.hear(START, 'a=1; Path=/');
    expect(jar.cookieHeaderFor('https://sub.api.rsn.network/')).toBeUndefined();
  });

  it('reports who holds it', () => {
    const jar = browser();
    jar.hear(START, 'a=1; Path=/api');
    expect(jar.holding('a')).toEqual([{ host: 'api.rsn.network', hostOnly: true, path: '/api', value: '1' }]);
  });
});

describe('a cookie with a Domain goes to that domain and its subdomains', () => {
  it('is kept when the host that set it is inside the domain, and sent to every host inside it', () => {
    const jar = browser();
    jar.hear('https://evil.rsn.network/', 'a=1; Domain=rsn.network; Path=/');
    expect(jar.cookieHeaderFor(CALLBACK)).toBe('a=1');
    expect(jar.cookieHeaderFor('https://rsn.network/')).toBe('a=1');
    expect(jar.cookieHeaderFor('https://rsn-api-h04m.onrender.com/')).toBeUndefined();
  });

  it('is dropped when the host that set it is not inside the domain', () => {
    const jar = browser();
    jar.hear('https://evil.example/', 'a=1; Domain=rsn.network; Path=/');
    jar.hear(START, 'b=1; Domain=evil.example; Path=/');
    expect(jar.holding('a')).toEqual([]);
    expect(jar.holding('b')).toEqual([]);
  });

  it('a leading dot on the Domain makes no difference', () => {
    const jar = browser();
    jar.hear(START, 'a=1; Domain=.rsn.network; Path=/');
    expect(jar.cookieHeaderFor('https://evil.rsn.network/')).toBe('a=1');
  });
});

describe('a cookie is sent only to paths under its Path', () => {
  it('matches the path itself, and paths below it at a "/" boundary, but not a longer word', () => {
    const jar = browser();
    jar.hear(START, 'a=1; Path=/api/auth/google');
    expect(jar.cookieHeaderFor(`${API}/api/auth/google`)).toBe('a=1');
    expect(jar.cookieHeaderFor(`${API}/api/auth/google/callback`)).toBe('a=1');
    expect(jar.cookieHeaderFor(`${API}/api/auth/googlefoo`)).toBeUndefined();
    expect(jar.cookieHeaderFor(`${API}/api/auth`)).toBeUndefined();
    expect(jar.cookieHeaderFor(`${API}/`)).toBeUndefined();
  });

  it('Path=/ matches everything', () => {
    const jar = browser();
    jar.hear(START, 'a=1; Path=/');
    expect(jar.cookieHeaderFor(`${API}/anything/at/all?x=1`)).toBe('a=1');
  });

  it('with no Path, the cookie takes the directory of the request path', () => {
    const jar = browser();
    jar.hear(START, 'a=1');
    expect(jar.holding('a')[0].path).toBe('/api/auth');
    jar.hear(`${API}/`, 'b=1');
    expect(jar.holding('b')[0].path).toBe('/');
  });
});

describe('Secure', () => {
  it('a Secure cookie is sent over https only', () => {
    const jar = browser();
    jar.hear(START, 'a=1; Path=/; Secure');
    expect(jar.cookieHeaderFor(CALLBACK)).toBe('a=1');
    expect(jar.cookieHeaderFor('http://api.rsn.network/')).toBeUndefined();
  });

  it('is not accepted from an http page, except on localhost, which a browser treats as secure', () => {
    const jar = browser();
    jar.hear('http://api.rsn.network/', 'a=1; Path=/; Secure');
    jar.hear('http://localhost:3001/', 'b=1; Path=/; Secure');
    expect(jar.holding('a')).toEqual([]);
    expect(jar.holding('b')).toHaveLength(1);
  });
});

describe('the __Host- prefix: kept only when Secure, Path=/, no Domain, over https', () => {
  const good = '__Host-n=1; Path=/; Secure';

  it('keeps a cookie that meets all four', () => {
    const jar = browser();
    jar.hear(START, good);
    expect(jar.holding('__Host-n')).toHaveLength(1);
  });

  it.each([
    ['not Secure', '__Host-n=1; Path=/'],
    ['a Path other than /', '__Host-n=1; Path=/api/auth/google; Secure'],
    ['no Path at all, so the directory of the request', '__Host-n=1; Secure'],
    ['a Domain', '__Host-n=1; Path=/; Secure; Domain=rsn.network'],
  ])('drops one with %s', (_what, line) => {
    const jar = browser();
    jar.hear(START, line);
    expect(jar.holding('__Host-n')).toEqual([]);
  });

  it('drops one that came over http', () => {
    const jar = browser();
    jar.hear('http://api.rsn.network/', good);
    expect(jar.holding('__Host-n')).toEqual([]);
  });

  it('is not the same cookie as the plain name', () => {
    const jar = browser();
    jar.hear(START, good);
    jar.hear(START, 'n=2; Path=/');
    expect(jar.cookieHeaderFor(CALLBACK)).toBe('__Host-n=1; n=2');
  });
});

describe('removing, replacing and ordering', () => {
  it('Max-Age=0 removes the cookie of the same name, host and path, and no other', () => {
    const jar = browser();
    jar.hear(START, 'a=1; Path=/');
    jar.hear(START, 'a=2; Path=/api');
    jar.hear(START, 'b=1; Path=/');
    jar.hear('https://other.example/', 'a=3; Path=/');
    jar.hear(START, 'a=; Path=/; Max-Age=0');
    expect(jar.holding('a').map((c) => [c.host, c.path, c.value])).toEqual([['api.rsn.network', '/api', '2'], ['other.example', '/', '3']]);
    expect(jar.holding('b')).toHaveLength(1);
  });

  it('a removal with another path leaves the cookie where it is', () => {
    const jar = browser();
    jar.hear(START, 'a=1; Path=/');
    jar.hear(START, 'a=; Path=/api/auth/google; Max-Age=0');
    expect(jar.holding('a')).toHaveLength(1);
  });

  it('a cookie of the same name, host and path replaces the old one', () => {
    const jar = browser();
    jar.hear(START, 'a=1; Path=/');
    jar.hear(START, 'a=2; Path=/');
    expect(jar.holding('a').map((c) => c.value)).toEqual(['2']);
  });

  it('sends the most specific path first, then the oldest', () => {
    const jar = browser();
    jar.hear(START, 'first=1; Path=/');
    jar.hear(START, 'second=2; Path=/');
    jar.hear(START, 'long=3; Path=/api/auth/google/callback');
    expect(jar.cookieHeaderFor(CALLBACK)).toBe('long=3; first=1; second=2');
  });

  it('valueSentTo says what a given address would be sent, and nothing for a host that holds none', () => {
    const jar = browser();
    jar.hear(START, 'a=1; Path=/');
    expect(jar.valueSentTo('a', CALLBACK)).toBe('1');
    expect(jar.valueSentTo('a', 'https://rsn-api-h04m.onrender.com/')).toBeUndefined();
  });
});
