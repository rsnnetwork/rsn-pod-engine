// ─── The event link's words: names, numbers and tails (shared/src/events/event-link.ts; Stefan, 11 Nov 2026) ─────────
//
// /events/<name>-<n> for a public event, /events/<name>-<n>-<tail> for one that is not. The name is the organiser's
// (2 to 40 lower-case letters, digits and single hyphens, never a reserved word); a slug reads back one way only; a
// tail is 6 symbols from the operating system's random source, a letter first, never 0, o, 1 or l.

import {
  EVENT_LINK_BASE_PATH, EVENT_LINK_DEFAULT_NAME, EVENT_LINK_PLATFORM_NAME, eventLinkNameProblemFor, EVENT_LINK_RESERVED_NAMES, EVENT_LINK_SLUG_MAX, EVENT_LINK_TAIL_ALPHABET,
  EVENT_LINK_TAIL_FIRST, EVENT_LINK_TAIL_LENGTH, eventLinkNameProblem, eventLinkPath, eventLinkSlug,
  isEventLinkName, isEventLinkTail, normaliseEventLinkName, parseEventLinkSlug,
} from '@rsn/shared';
import { newEventLinkTail } from '../../services/session/event-link.service';

// Migration 154's CHECKs, verbatim.
const NAME_CHECK = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TAIL_CHECK = /^[a-km-np-z][2-9a-km-np-z]{5}$/;

describe('the name', () => {
  it.each([
    ['rsn'], ['ab'], ['founders-breakfast'], ['summit-2026'], ['2026-summit'], ['a1-b2-c3'], ['x'.repeat(40)],
  ])('%s can be used', (name) => {
    expect(eventLinkNameProblem(name)).toBeNull();
    expect(isEventLinkName(name)).toBe(true);
    expect(NAME_CHECK.test(name) && name.length >= 2 && name.length <= 40).toBe(true);
  });

  it.each([
    ['', 'Give the event link a name.'],
    ['a', 'The link name needs at least 2 characters.'],
    ['x'.repeat(41), 'The link name can have at most 40 characters.'],
    ['-rsn', 'Use 2 to 40'],
    ['rsn-', 'Use 2 to 40'],
    ['rs--n', 'Use 2 to 40'],
    ['Rsn', 'Use 2 to 40'],
    ['rsn_1', 'Use 2 to 40'],
    ['café', 'Use 2 to 40'],
    ['rsn 1', 'Use 2 to 40'],
    ['rsn/1', 'Use 2 to 40'],
    ['../admin', 'Use 2 to 40'],
  ])('%j is refused in words', (name, words) => {
    expect(eventLinkNameProblem(name)).toContain(words);
  });

  it('every reserved word is refused, the app\'s own paths among them; "event" (the default) and "rsn" are not here', () => {
    for (const word of ['admin', 'api', 'new', 'call', 'events', 'login', 'settings', 'my-events', 'sessions', 'reason']) {
      expect(EVENT_LINK_RESERVED_NAMES).toContain(word);
    }
    for (const word of EVENT_LINK_RESERVED_NAMES) {
      expect(eventLinkNameProblem(word)).toBe('That name is kept for REASON itself. Choose another.');
    }
    expect(EVENT_LINK_DEFAULT_NAME).toBe('event');
    expect(eventLinkNameProblem('event')).toBeNull();
    expect(eventLinkNameProblem('rsn')).toBeNull();
  });

  it('"rsn" is RSN\'s own (controller ruling, 12 Nov 2026): only a platform admin may choose it', () => {
    expect(EVENT_LINK_PLATFORM_NAME).toBe('rsn');
    expect(eventLinkNameProblemFor('rsn', { platform: false })).toBe('This name is reserved.');
    expect(eventLinkNameProblemFor('rsn', { platform: true })).toBeNull();
    expect(eventLinkNameProblemFor('rsn-team', { platform: false })).toBeNull();
    expect(eventLinkNameProblemFor('admin', { platform: true })).toBe('That name is kept for REASON itself. Choose another.');
    expect(eventLinkNameProblemFor('my event', { platform: true })).toContain('Use 2 to 40');
  });

  it('is read as typed only after trimming and lower-casing (nothing else is changed for the organiser)', () => {
    expect(normaliseEventLinkName('  Founders-Breakfast ')).toBe('founders-breakfast');
    expect(normaliseEventLinkName('Founders Breakfast')).toBe('founders breakfast');
  });
});

describe('the slug and the path', () => {
  it('writes name-number, and name-number-tail with a tail, under /events', () => {
    expect(EVENT_LINK_BASE_PATH).toBe('/events');
    expect(eventLinkSlug({ name: 'rsn', number: 3, tail: null })).toBe('rsn-3');
    expect(eventLinkSlug({ name: 'rsn', number: 3, tail: 'k7m2q9' })).toBe('rsn-3-k7m2q9');
    expect(eventLinkPath('rsn-3')).toBe('/events/rsn-3');
  });

  it('reads a slug back one way only, case ignored', () => {
    expect(parseEventLinkSlug('rsn-1')).toEqual({ name: 'rsn', number: 1, tail: null });
    expect(parseEventLinkSlug('RSN-12')).toEqual({ name: 'rsn', number: 12, tail: null });
    expect(parseEventLinkSlug('rsn-3-k7m2q9')).toEqual({ name: 'rsn', number: 3, tail: 'k7m2q9' });
    expect(parseEventLinkSlug('summit-2026-1')).toEqual({ name: 'summit-2026', number: 1, tail: null });
    expect(parseEventLinkSlug('summit-2026-4-k7m2q9')).toEqual({ name: 'summit-2026', number: 4, tail: 'k7m2q9' });
    // A tail never starts with a digit, so a name ending in digits never reads as a tail.
    expect(parseEventLinkSlug('summit-2026-3456')).toEqual({ name: 'summit-2026', number: 3456, tail: null });
  });

  it.each([
    ['rsn'], ['rsn-0'], ['rsn-01'], ['rsn-1234567890'], ['-rsn-1'], ['rsn-1-'], ['rsn--1'], ['r-1'], ['rsn-1-k7m2'],
    ['rsn-1-k7m2q9x'], ['rsn-1-k0m2q9'], ['rsn-1-k7l2q9'], ['rsn-1-27m2q9'], ['rsn-x-k7m2q9'], ['k7m2x9q4ra'],
    ['rsn-1/../x'], ["'; DROP TABLE sessions; --"], [''], [`${'a'.repeat(41)}-1`],
  ])('%j is not a slug', (raw) => {
    expect(parseEventLinkSlug(raw)).toBeNull();
  });

  it('every slug written reads back to its parts (names, numbers and tails across the range)', () => {
    for (const name of ['rsn', 'ab', 'summit-2026', 'x'.repeat(40), '1-2-3']) {
      for (const number of [1, 9, 10, 4567, 999_999_999]) {
        for (const tail of [null, 'k7m2q9', newEventLinkTail()]) {
          const slug = eventLinkSlug({ name, number, tail });
          expect(slug.length).toBeLessThanOrEqual(EVENT_LINK_SLUG_MAX);
          expect(parseEventLinkSlug(slug)).toEqual({ name, number, tail });
        }
      }
    }
  });
});

describe('the tail', () => {
  it('has no 0, o, 1 or l; 32 symbols, a letter first (24); 6 long: 24 x 32^5, about 805 million per name and number', () => {
    for (const confusing of ['0', 'o', '1', 'l']) {
      expect(EVENT_LINK_TAIL_ALPHABET).not.toContain(confusing);
      expect(EVENT_LINK_TAIL_FIRST).not.toContain(confusing);
    }
    expect(new Set(EVENT_LINK_TAIL_ALPHABET).size).toBe(32);
    expect(new Set(EVENT_LINK_TAIL_FIRST).size).toBe(24);
    expect([...EVENT_LINK_TAIL_FIRST].every((c) => /[a-z]/.test(c) && EVENT_LINK_TAIL_ALPHABET.includes(c))).toBe(true);
    expect(EVENT_LINK_TAIL_LENGTH).toBe(6);
    expect(24 * 32 ** 5).toBe(805_306_368);
  });

  it('10,000 new tails are well formed, pass migration 154\'s CHECK and spread over every symbol', () => {
    const tails = Array.from({ length: 10_000 }, () => newEventLinkTail());
    expect(tails.every((t) => isEventLinkTail(t) && TAIL_CHECK.test(t))).toBe(true);
    expect(new Set(tails).size).toBeGreaterThan(9_990);
    const seen = new Set(tails.join(''));
    expect(seen.size).toBe(32);
    expect(new Set(tails.map((t) => t[0])).size).toBe(24);
  });

  it('migration 154\'s CHECK and the shared rule agree on every symbol', () => {
    const all = 'abcdefghijklmnopqrstuvwxyz0123456789';
    for (const a of all) {
      const tail = `${a}22222`;
      expect(TAIL_CHECK.test(tail)).toBe(isEventLinkTail(tail));
      const rest = `a${a}2222`;
      expect(TAIL_CHECK.test(rest)).toBe(isEventLinkTail(rest));
    }
  });
});
