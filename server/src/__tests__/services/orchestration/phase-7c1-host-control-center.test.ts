// ─── Phase 7C.1 — Host Control Center backing data ─────────────────────────
//
// Architectural pins for Stefan #3 + #11 (7 May spec).
// Asserts that:
//   1. The participants helper exists with the canonical signature.
//   2. State derivation handles every case (left/no_show/removed → 'left',
//      in match → 'in_room', disconnected → 'disconnected', else 'in_main_room').
//   3. The host:round_dashboard emit includes a participants field (both the
//      live emit in matching-flow.ts and the reconnect emit in
//      participant-flow.ts).
//   4. Role derivation prefers session_cohosts (canonical) over older
//      session_participants.role check.
//   5. The shared event type lists the participants field.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '..', '..', '..', '..', '..');
const HELPER_PATH = join(
  REPO,
  'server', 'src', 'services', 'orchestration', 'handlers',
  'host-participants-view.ts',
);
const MATCHING_FLOW_PATH = join(
  REPO,
  'server', 'src', 'services', 'orchestration', 'handlers',
  'matching-flow.ts',
);
const PARTICIPANT_FLOW_PATH = join(
  REPO,
  'server', 'src', 'services', 'orchestration', 'handlers',
  'participant-flow.ts',
);
const SHARED_EVENTS_PATH = join(REPO, 'shared', 'src', 'types', 'events.ts');

describe('Phase 7C.1 — Host Control Center backing data (architectural pins)', () => {
  test('helper file exists at the canonical path', () => {
    expect(existsSync(HELPER_PATH)).toBe(true);
  });

  test('helper exports buildHostParticipantsView with the canonical signature', () => {
    const src = readFileSync(HELPER_PATH, 'utf8');
    expect(src).toMatch(/export\s+async\s+function\s+buildHostParticipantsView/);
    // canonical opts shape
    expect(src).toMatch(/sessionId:\s*string/);
    expect(src).toMatch(/hostUserId:\s*string/);
    expect(src).toMatch(/presenceMap:\s*Map</);
    expect(src).toMatch(/activeMatches\?\:/);
  });

  test('state derivation covers left/no_show/removed → left', () => {
    const src = readFileSync(HELPER_PATH, 'utf8');
    expect(src).toMatch(/'left'|"left"/);
    expect(src).toMatch(/'no_show'|"no_show"/);
    expect(src).toMatch(/'removed'|"removed"/);
  });

  test('state derivation has in_room / in_main_room / disconnected branches', () => {
    const src = readFileSync(HELPER_PATH, 'utf8');
    expect(src).toMatch(/'in_room'|"in_room"/);
    expect(src).toMatch(/'in_main_room'|"in_main_room"/);
    expect(src).toMatch(/'disconnected'|"disconnected"/);
  });

  test('role derivation joins session_cohosts (canonical, not session_participants.role)', () => {
    const src = readFileSync(HELPER_PATH, 'utf8');
    expect(src).toMatch(/session_cohosts/);
    expect(src).toMatch(/is_cohost/);
  });

  test('matching-flow emit includes participants field', () => {
    const src = readFileSync(MATCHING_FLOW_PATH, 'utf8');
    expect(src).toMatch(/buildHostParticipantsView/);
    // The emit payload includes participants: ...
    expect(src).toMatch(/'host:round_dashboard'[\s\S]{0,2000}participants/);
  });

  test('participant-flow reconnect emit includes participants field', () => {
    const src = readFileSync(PARTICIPANT_FLOW_PATH, 'utf8');
    // Allow either named or dynamic import (file uses dynamic import)
    expect(src).toMatch(/buildHostParticipantsView/);
    expect(src).toMatch(/'host:round_dashboard'[\s\S]{0,2000}participants/);
  });

  test('shared event type advertises participants on host:round_dashboard', () => {
    const src = readFileSync(SHARED_EVENTS_PATH, 'utf8');
    expect(src).toMatch(/'host:round_dashboard'[\s\S]{0,2000}participants\?\:/);
    // Includes the canonical role union
    expect(src).toMatch(/'host'\s*\|\s*'cohost'\s*\|\s*'participant'/);
    // Includes the canonical state union
    expect(src).toMatch(/'in_main_room'\s*\|\s*'in_room'\s*\|\s*'disconnected'\s*\|\s*'left'/);
  });
});
