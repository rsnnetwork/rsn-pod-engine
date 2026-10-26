// Phase 4 — Platform-spec spec, 29 April 2026.
//
// Stefan's clarification (replying to user's question about already-met scope):
//   "We should NOT hardcode one rule for the whole platform. Matching rules
//    should be decided at the event level. Three clear options:
//      1. Platform-wide no rematch
//      2. Event/pod-level no rematch (default)
//      3. No restriction"
//
// These tests pin the new architecture:
//   1. SessionConfig has a matchingPolicy field of type MatchingPolicy
//      ('platform_wide' | 'within_event' | 'none').
//   2. DEFAULT_SESSION_CONFIG sets matchingPolicy='within_event' (Stefan's
//      stated default).
//   3. matching.service exports resolveMatchingPolicy(sessionConfig) which
//      handles legacy crossEventMemory fallback.
//   4. getEncounterHistoryForUsers respects the policy: returns empty for
//      'within_event' and 'none'; queries encounter_history only for
//      'platform_wide'.
//   5. generateSingleRound disables the within-event excludedPairs query
//      when matchingPolicy='none' so people CAN be re-paired.
//   6. The event forms (EventFormatFields, since 26 Oct 2026) expose all three
//      options as radio buttons, defaulting to 'within_event'.

import * as nodeFs from 'fs';
import * as nodePath from 'path';
import { eventBody, newEventValues } from '../../../../../client/src/features/sessions/event-format-form';

function readShared(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../../shared/src', rel), 'utf8');
}

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
}

function readClient(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../../client/src', rel), 'utf8');
}

describe('Phase 4 — matching policy 3-option chooser', () => {
  describe('shared types — MatchingPolicy + SessionConfig', () => {
    const src = readShared('types/session.ts');

    it('exports MatchingPolicy type with three string literals', () => {
      expect(src).toMatch(/export type MatchingPolicy\s*=\s*['"]platform_wide['"]\s*\|\s*['"]within_event['"]\s*\|\s*['"]none['"]/);
    });

    it('SessionConfig has optional matchingPolicy field', () => {
      expect(src).toMatch(/matchingPolicy\?\s*:\s*MatchingPolicy/);
    });

    it('DEFAULT_SESSION_CONFIG sets matchingPolicy to within_event (Stefan default)', () => {
      expect(src).toMatch(/matchingPolicy:\s*['"]within_event['"]/);
    });
  });

  describe('server resolveMatchingPolicy + getEncounterHistoryForUsers', () => {
    const src = readServer('services/matching/matching.service.ts');

    it('exports resolveMatchingPolicy helper', () => {
      expect(src).toMatch(/export function resolveMatchingPolicy/);
    });

    it('resolveMatchingPolicy returns within_event when both fields absent', () => {
      const fnStart = src.indexOf('export function resolveMatchingPolicy');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/return\s+['"]within_event['"]/);
    });

    it('resolveMatchingPolicy honors legacy crossEventMemory=false → none', () => {
      const fnStart = src.indexOf('export function resolveMatchingPolicy');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/crossEventMemory\s*===\s*false[\s\S]*?return\s+['"]none['"]/);
    });

    it('resolveMatchingPolicy honors legacy crossEventMemory=true → platform_wide', () => {
      const fnStart = src.indexOf('export function resolveMatchingPolicy');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/crossEventMemory\s*===\s*true[\s\S]*?return\s+['"]platform_wide['"]/);
    });

    it('getEncounterHistoryForUsers accepts matchingPolicy option', () => {
      const fnStart = src.indexOf('async function getEncounterHistoryForUsers');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/matchingPolicy\?\s*:\s*MatchingPolicy/);
    });

    it('getEncounterHistoryForUsers returns empty for within_event and none policies', () => {
      const fnStart = src.indexOf('async function getEncounterHistoryForUsers');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      // Single guard catches both policies: if (policy === 'within_event' || policy === 'none') return [];
      expect(fn).toMatch(/policy\s*===\s*['"]within_event['"][\s\S]*?policy\s*===\s*['"]none['"][\s\S]*?return\s*\[\]/);
    });

    it('generateSingleRound skips excludedPairs query under matchingPolicy=none', () => {
      const fnStart = src.indexOf('export async function generateSingleRound');
      const fnEnd = src.indexOf('\nexport', fnStart + 30);
      const fn = src.slice(fnStart, fnEnd);
      // The excludedPairs computation is now wrapped in `if (matchingPolicy !== 'none')`
      expect(fn).toMatch(/if\s*\(matchingPolicy\s*!==\s*['"]none['"]\)/);
    });

    it('both generateSessionSchedule and generateSingleRound use resolveMatchingPolicy', () => {
      const schedFn = src.slice(
        src.indexOf('export async function generateSessionSchedule'),
        src.indexOf('export async function generateSingleRound'),
      );
      const roundFn = src.slice(
        src.indexOf('export async function generateSingleRound'),
        src.indexOf('export async function getEligibleParticipants'),
      );
      expect(schedFn).toMatch(/resolveMatchingPolicy/);
      expect(roundFn).toMatch(/resolveMatchingPolicy/);
    });
  });

  // 26 Oct 2026 (C7) — the event forms follow the shared event definition. The matching rule is one of the
  // speed-networking settings EventFormatFields draws (the create and the edit form alike), its default is the
  // definition's, and the request is built by event-format-form's eventBody, which is run here.
  describe('client event forms expose matchingPolicy as a radio selector', () => {
    const src = readClient('features/sessions/EventFormatFields.tsx');

    it('declares the three choices the form offers', () => {
      expect(src).toMatch(/MatchingPolicyChoice\s*=\s*['"]platform_wide['"]\s*\|\s*['"]within_event['"]\s*\|\s*['"]none['"]/);
    });

    it('exports MATCHING_POLICIES array with three options', () => {
      expect(src).toMatch(/export const MATCHING_POLICIES/);
      expect(src).toMatch(/value:\s*['"]platform_wide['"]/);
      expect(src).toMatch(/value:\s*['"]within_event['"]/);
      expect(src).toMatch(/value:\s*['"]none['"]/);
    });

    it('a new speed-networking event starts on within_event (the shared definition\'s default)', () => {
      const pod = { id: 'p', name: 'Pod', podType: 'speed_networking', orchestrationMode: 'timed_rounds' } as never;
      expect(newEventValues({ pod, scheduledAt: '2026-11-02T10:00' }).matchingPolicy).toBe('within_event');
    });

    it('the request carries the matchingPolicy the organiser picked, in config', () => {
      const pod = { id: 'p', name: 'Pod', podType: 'speed_networking', orchestrationMode: 'timed_rounds' } as never;
      const values = newEventValues({ pod, scheduledAt: '2026-11-02T10:00' });
      expect(eventBody({ ...values, matchingPolicy: 'none' }, { isAdmin: false }).config.matchingPolicy).toBe('none');
    });

    it('renders a radio input for each MATCHING_POLICIES entry', () => {
      // The map renders <input type="radio" ... {...register('matchingPolicy')} />
      expect(src).toMatch(/MATCHING_POLICIES\.map[\s\S]+?type="radio"[\s\S]+?register\(['"]matchingPolicy['"]/);
    });
  });
});
