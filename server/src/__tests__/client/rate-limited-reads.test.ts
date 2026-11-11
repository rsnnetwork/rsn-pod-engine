// ─── A read refused for the rate limit (429) is read again once the limit allows (review I2, 11 Nov 2026) ────────────
//
// On the preview an organiser's event page read the event after Cancel, was refused with 429 (the member's 240 requests
// a minute were spent), retried three times inside the same window, and then kept "Registration open" for as long as
// nothing else named the event. The cache now reads a tagged read refused with 429 again once, after the window has had
// time to reset, one waiting re-read per query, a few times in a row at most.

import * as fs from 'fs';
import * as path from 'path';
import { QueryClient, QueryObserver } from '@tanstack/query-core';
import {
  RATE_LIMIT_FALLBACK_MS, RATE_LIMIT_JITTER_MS, RATE_LIMIT_MAX_TRIES, RATE_LIMIT_MAX_WAIT_MS,
  isRateLimited, rateLimitWaitMs, retryOnceUnlessRateLimited, watchRateLimitedReads,
} from '../../../../client/src/realtime/rate-limited-reads';

const CLIENT = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(CLIENT, rel), 'utf8').replace(/\r\n/g, '\n');
const flush = () => new Promise((r) => setImmediate(r));
const refused = (headers: Record<string, unknown> = {}) => Object.assign(new Error('429'), { response: { status: 429, headers } });
const noJitter = () => 0;

describe('how long a refused read waits', () => {
  it('the fallback is 20 s, with up to 5 s of jitter, never above two minutes, a few tries at most', () => {
    expect(RATE_LIMIT_FALLBACK_MS).toBe(20_000);
    expect(RATE_LIMIT_JITTER_MS).toBe(5_000);
    expect(RATE_LIMIT_MAX_WAIT_MS).toBe(120_000);
    expect(RATE_LIMIT_MAX_TRIES).toBe(4);
  });

  it('with no header the browser can read (a cross-origin response hides them), the fallback plus jitter', () => {
    expect(rateLimitWaitMs(refused(), { random: noJitter })).toBe(20_000);
    expect(rateLimitWaitMs(refused(), { random: () => 0.5 })).toBe(22_500);
    expect(rateLimitWaitMs(refused(), { random: () => 0.999999 })).toBeLessThanOrEqual(25_000);
  });

  it('the reset the server names: Retry-After in seconds or as a date, else RateLimit-Reset, kept between 1 s and 2 min', () => {
    expect(rateLimitWaitMs(refused({ 'retry-after': '30' }), { random: noJitter })).toBe(30_000);
    expect(rateLimitWaitMs(refused({ 'ratelimit-reset': '42' }), { random: noJitter })).toBe(42_000);
    const now = Date.parse('2026-11-11T15:00:00Z');
    expect(rateLimitWaitMs(refused({ 'retry-after': 'Wed, 11 Nov 2026 15:00:45 GMT' }), { now, random: noJitter })).toBe(45_000);
    expect(rateLimitWaitMs(refused({ 'retry-after': '0' }), { random: noJitter })).toBe(1_000);
    expect(rateLimitWaitMs(refused({ 'retry-after': '3600' }), { random: noJitter })).toBe(120_000);
    expect(rateLimitWaitMs(refused({ 'retry-after': 'soon' }), { random: noJitter })).toBe(20_000);
    // Axios hands an AxiosHeaders, read through get().
    const axiosLike = { get: (name: string) => (name === 'ratelimit-reset' ? '12' : undefined) };
    expect(rateLimitWaitMs(refused(axiosLike), { random: noJitter })).toBe(12_000);
  });

  it('only a 429 counts; a page read is retried once as before, but never for a 429', () => {
    expect(isRateLimited(refused())).toBe(true);
    expect(isRateLimited({ response: { status: 500 } })).toBe(false);
    expect(isRateLimited(new Error('network'))).toBe(false);
    expect(isRateLimited(null)).toBe(false);
    expect(retryOnceUnlessRateLimited(0, { response: { status: 500 } })).toBe(true);
    expect(retryOnceUnlessRateLimited(1, { response: { status: 500 } })).toBe(false);
    expect(retryOnceUnlessRateLimited(0, refused())).toBe(false);
  });
});

describe('watchRateLimitedReads: a refused read comes back once the limit allows', () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] }));
  afterEach(() => jest.useRealTimers());

  /** An event read the server refuses `refusals` times (429), then answers with `answer`. */
  function eventRead(qc: QueryClient, refusals: number, answer = 'Cancelled', meta: Record<string, unknown> = { entities: ['session:s1'] }) {
    let calls = 0;
    const observer = new QueryObserver(qc, {
      queryKey: ['session', 's1'], meta, retry: false,
      queryFn: () => { calls += 1; return calls <= refusals ? Promise.reject(refused()) : Promise.resolve(answer); },
    });
    const off = observer.subscribe(() => {});
    return { calls: () => calls, off, observer };
  }

  it('a 429 is read again once after the wait, and the page then shows the answer', async () => {
    const qc = new QueryClient();
    const unwatch = watchRateLimitedReads(qc, { random: noJitter });
    const page = eventRead(qc, 1);
    await flush(); await flush();
    expect(page.calls()).toBe(1);
    expect(page.observer.getCurrentResult().status).toBe('error');
    jest.advanceTimersByTime(RATE_LIMIT_FALLBACK_MS - 1);
    await flush();
    expect(page.calls()).toBe(1);                    // nothing inside the window
    jest.advanceTimersByTime(1);
    await flush(); await flush();
    expect(page.calls()).toBe(2);
    expect(qc.getQueryData(['session', 's1'])).toBe('Cancelled');
    jest.advanceTimersByTime(10 * RATE_LIMIT_FALLBACK_MS);
    await flush();
    expect(page.calls()).toBe(2);                    // and nothing after it: no loop
    page.off(); unwatch(); qc.clear();
  });

  it('refused again, it waits again, at most RATE_LIMIT_MAX_TRIES times in a row, then stops', async () => {
    const qc = new QueryClient();
    const unwatch = watchRateLimitedReads(qc, { random: noJitter });
    const page = eventRead(qc, 100);
    await flush(); await flush();
    for (let i = 0; i < RATE_LIMIT_MAX_TRIES + 3; i++) {
      jest.advanceTimersByTime(RATE_LIMIT_FALLBACK_MS);
      await flush(); await flush();
    }
    expect(page.calls()).toBe(1 + RATE_LIMIT_MAX_TRIES);
    page.off(); unwatch(); qc.clear();
  });

  it('a success starts the count again: a later refusal is read again too', async () => {
    const qc = new QueryClient();
    const unwatch = watchRateLimitedReads(qc, { random: noJitter });
    let calls = 0;
    const answers = ['429', 'ok', '429', 'ok'];
    const observer = new QueryObserver(qc, {
      queryKey: ['session', 's1'], meta: { entities: ['session:s1'] }, retry: false,
      queryFn: () => { const a = answers[calls] ?? 'ok'; calls += 1; return a === '429' ? Promise.reject(refused()) : Promise.resolve(`v${calls}`); },
    });
    const off = observer.subscribe(() => {});
    await flush(); await flush();
    jest.advanceTimersByTime(RATE_LIMIT_FALLBACK_MS); await flush(); await flush();
    expect(calls).toBe(2);
    await qc.invalidateQueries({ queryKey: ['session', 's1'] }).catch(() => undefined); // a change, refused again
    await flush(); await flush();
    expect(calls).toBe(3);
    jest.advanceTimersByTime(RATE_LIMIT_FALLBACK_MS); await flush(); await flush();
    expect(calls).toBe(4);
    expect(qc.getQueryData(['session', 's1'])).toBe('v4');
    off(); unwatch(); qc.clear();
  });

  it('one waiting re-read per query, however many refusals arrive meanwhile', async () => {
    const qc = new QueryClient();
    const spy = jest.spyOn(qc, 'invalidateQueries');
    const unwatch = watchRateLimitedReads(qc, { random: noJitter });
    const page = eventRead(qc, 3);
    await flush(); await flush();
    await qc.refetchQueries({ queryKey: ['session', 's1'] }); await flush();   // refused again while it waits
    await qc.refetchQueries({ queryKey: ['session', 's1'] }); await flush();
    expect(page.calls()).toBe(3);
    jest.advanceTimersByTime(RATE_LIMIT_FALLBACK_MS); await flush(); await flush();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(page.calls()).toBe(4);
    page.off(); unwatch(); qc.clear();
  });

  it('an untagged read, or an error other than 429, is left alone', async () => {
    const qc = new QueryClient();
    const spy = jest.spyOn(qc, 'invalidateQueries');
    const unwatch = watchRateLimitedReads(qc, { random: noJitter });
    const untagged = eventRead(qc, 1, 'x', {});
    const other = new QueryObserver(qc, {
      queryKey: ['other'], meta: { entities: ['pod:p1'] }, retry: false,
      queryFn: () => Promise.reject(Object.assign(new Error('500'), { response: { status: 500 } })),
    });
    const offOther = other.subscribe(() => {});
    await flush(); await flush();
    jest.advanceTimersByTime(5 * RATE_LIMIT_FALLBACK_MS); await flush();
    expect(spy).not.toHaveBeenCalled();
    untagged.off(); offOther(); unwatch(); qc.clear();
  });

  it('a query that leaves the cache (sign-out empties it) drops its wait, and so does unwatching', async () => {
    const qc = new QueryClient();
    const spy = jest.spyOn(qc, 'invalidateQueries');
    const unwatch = watchRateLimitedReads(qc, { random: noJitter });
    const page = eventRead(qc, 1);
    await flush(); await flush();
    page.off();
    qc.clear();
    jest.advanceTimersByTime(2 * RATE_LIMIT_FALLBACK_MS); await flush();
    expect(spy).not.toHaveBeenCalled();
    const again = eventRead(qc, 1);
    await flush(); await flush();
    unwatch();
    jest.advanceTimersByTime(2 * RATE_LIMIT_FALLBACK_MS); await flush();
    expect(spy).not.toHaveBeenCalled();
    again.off(); qc.clear();
  });
});

describe('the app\'s one cache watches its reads, and the event page\'s reads do not retry a 429 inside the window', () => {
  it('lib/queryClient.ts watches the cache it builds, and its default retry skips a 429', () => {
    const src = read('lib/queryClient.ts');
    expect(src).toContain("import { retryOnceUnlessRateLimited, watchRateLimitedReads } from '../realtime/rate-limited-reads';");
    expect(src).toContain('retry: retryOnceUnlessRateLimited');
    expect(src).toContain('watchRateLimitedReads(queryClient);');
  });

  it.each([
    ['features/sessions/SessionDetailPage.tsx', 'if (isRateLimited(err)) return false;'],
    ['features/sessions/SessionDetailPage.tsx', "!== 403 && !isRateLimited(err) && failureCount < 3"],
    ['features/sessions/call-link.ts', 'status !== 429'],
    ['features/sessions/admission/useAdmission.ts', 'status !== 429'],
    ['features/sessions/questions/useEventQuestions.ts', 'status !== 429'],
    ['features/sessions/groups/useEventGroups.ts', 'status !== 429'],
    ['features/sessions/waitlist/useWaitlist.ts', '!isRateLimited(err)'],
    ['features/sessions/history/EventHistoryPanel.tsx', '!isRateLimited(err)'],
  ])('%s: %s', (file, snippet) => {
    expect(read(file)).toContain(snippet);
  });
});
