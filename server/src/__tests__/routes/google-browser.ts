// A browser, as far as a Google sign-in is concerned (for the route tests, 7 Oct 2026).
//
// In production the API answers on two hosts, and the cookie that ties a sign-in to a browser belongs to ONE of
// them. The first version of that cookie was set on the host the client starts from and was never sent to the
// host Google returns to, which would have refused every sign-in; a test that holds "the cookie" in a variable
// cannot see that. This keeps a jar per host, with the rules a real browser applies, and follows the API's own
// redirects the way a top-level navigation does, so a test exercises what actually reaches which host.
//
//  - A cookie without Domain belongs to the host that set it and is sent to no other; a Domain cookie goes to that
//    domain and every subdomain. (So a cookie set by host A is never sent to host B.)
//  - A cookie is sent only to paths under its Path, and a Secure cookie only over https. The most specific path
//    goes first, then the oldest.
//  - A browser silently drops what it does not accept: Secure over http, a Domain the host does not match, and a
//    __Host- cookie that is not Secure, is not Path=/, names a Domain, or came over http.
//  - A cookie with Max-Age=0 removes the cookie with the same name, host and path, and no other.
//  - A redirect keeps the page's Referer unless the redirect carries Referrer-Policy: no-referrer (Helmet's default).
//  - A navigation follows redirects among the hosts it is given, and stops at the first other host (Google).

import request from 'supertest';
import type { Express } from 'express';

// supertest types every header as a string, but Express sends one Set-Cookie header per cookie, so this one is a list.
export const setCookieLines = (res: request.Response): string[] => (res.headers['set-cookie'] ?? []) as unknown as string[];

export function parseSetCookie(line: string) {
  const [pair, ...attributes] = line.split(';').map((part) => part.trim());
  const eq = pair.indexOf('=');
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attributes };
}

const attribute = (attributes: string[], key: string) =>
  attributes.find((a) => a.toLowerCase().startsWith(`${key.toLowerCase()}=`))?.slice(key.length + 1);
const hasFlag = (attributes: string[], key: string) => attributes.some((a) => a.toLowerCase() === key.toLowerCase());
const isLoopback = (hostname: string) => hostname === 'localhost' || hostname === '127.0.0.1';

/** RFC 6265 5.1.4: the cookie's path is the request path, or a prefix of it that ends at a "/" boundary. */
function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/';
}

/** RFC 6265 5.1.4: with no Path attribute the cookie takes the directory of the request path. */
const defaultPath = (requestPath: string) => (requestPath.lastIndexOf('/') > 0 ? requestPath.slice(0, requestPath.lastIndexOf('/')) : '/');

interface Held {
  name: string;
  value: string;
  host: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  order: number;
}

export interface Navigation {
  /** The last response: the one that sent the browser to Google, or the one that ended the navigation. */
  res: request.Response;
  /** Every request the browser made, in order, with the Referer it sent (none when it sent none). */
  chain: Array<{ url: string; status: number; referer?: string }>;
  /** Where the browser went when it left our hosts (Google), if it did. */
  leftFor?: URL;
}

export class Browser {
  private held: Held[] = [];
  private order = 0;

  constructor(private readonly app: Express, private readonly ourHosts: readonly string[]) {}

  /** What this browser does with one Set-Cookie line that `address` sent: keep it, replace it, remove it, or drop it. */
  hear(address: string | URL, setCookie: string): void {
    const url = new URL(address);
    const { name, value, attributes } = parseSetCookie(setCookie);
    const secure = hasFlag(attributes, 'Secure');
    const domain = attribute(attributes, 'Domain')?.replace(/^\./, '').toLowerCase();
    const path = attribute(attributes, 'Path') ?? defaultPath(url.pathname);
    const overHttps = url.protocol === 'https:' || isLoopback(url.hostname);

    if (secure && !overHttps) return;
    if (domain && url.hostname !== domain && !url.hostname.endsWith(`.${domain}`)) return;
    if (name.startsWith('__Host-') && !(secure && overHttps && path === '/' && !domain)) return;

    const host = domain ?? url.hostname;
    const hostOnly = domain === undefined;
    this.held = this.held.filter((c) => !(c.name === name && c.host === host && c.hostOnly === hostOnly && c.path === path));
    const maxAge = attribute(attributes, 'Max-Age');
    if (maxAge !== undefined && Number(maxAge) <= 0) return;
    this.held.push({ name, value, host, hostOnly, path, secure, order: this.order++ });
  }

  /** The Cookie header this browser would send to `address`, or nothing. */
  cookieHeaderFor(address: string | URL): string | undefined {
    const url = new URL(address);
    const overHttps = url.protocol === 'https:' || isLoopback(url.hostname);
    const sent = this.held
      .filter((c) => (c.hostOnly ? url.hostname === c.host : url.hostname === c.host || url.hostname.endsWith(`.${c.host}`)))
      .filter((c) => pathMatches(url.pathname, c.path) && (!c.secure || overHttps))
      .sort((a, b) => b.path.length - a.path.length || a.order - b.order);
    return sent.length ? sent.map((c) => `${c.name}=${c.value}`).join('; ') : undefined;
  }

  /** Every cookie of that name the browser holds, with who it belongs to: for assertions about WHERE a cookie lives. */
  holding(name: string): Array<{ host: string; hostOnly: boolean; path: string; value: string }> {
    return this.held.filter((c) => c.name === name).map(({ host, hostOnly, path, value }) => ({ host, hostOnly, path, value }));
  }

  /** The value of the cookie of that name that `address` would be sent, if any. */
  valueSentTo(name: string, address: string | URL): string | undefined {
    const header = this.cookieHeaderFor(address);
    const first = header?.split('; ').find((pair) => pair.startsWith(`${name}=`));
    return first?.slice(name.length + 1);
  }

  /** A top-level navigation to `address`: follow redirects among our hosts, send and keep cookies as a browser does. */
  async navigate(address: string, options: { referer?: string } = {}): Promise<Navigation> {
    const chain: Navigation['chain'] = [];
    let url = new URL(address);
    let referer = options.referer;
    for (let step = 0; step < 6; step += 1) {
      const req = request(this.app).get(`${url.pathname}${url.search}`).set('Host', url.host);
      const cookie = this.cookieHeaderFor(url);
      if (cookie) req.set('Cookie', cookie);
      if (referer) req.set('Referer', referer);
      const res = await req;
      for (const line of setCookieLines(res)) this.hear(url, line);
      chain.push({ url: url.href, status: res.status, ...(referer ? { referer } : {}) });

      const location = res.status >= 300 && res.status < 400 ? (res.headers.location as string | undefined) : undefined;
      if (!location) return { res, chain };
      const next = new URL(location, url);
      if (!this.ourHosts.includes(next.host)) return { res, chain, leftFor: next };
      // A redirect that says no-referrer takes the Referer away from the request it leads to.
      if (/no-referrer/.test(String(res.headers['referrer-policy'] ?? ''))) referer = undefined;
      url = next;
    }
    throw new Error(`too many redirects: ${chain.map((hop) => hop.url).join(' -> ')}`);
  }
}
