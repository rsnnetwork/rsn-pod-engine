// ─── Phase 7C.3 — Test-mode banner v2 ──────────────────────────────────────
//
// Architectural pins for Stefan #12 (7 May spec).
// Asserts that:
//   1. The heuristic in session-state-snapshot drops the length-≥4 gate
//      AND adds three signals (root substring, email domain, display-name
//      first-name token).
//   2. A handler for 'host:set_test_mode' is wired in orchestration.service
//      (manual override path).
//   3. The shared event type advertises 'host:set_test_mode'.
//
// These are static text-pin assertions over the source — they confirm the
// architectural shape but do NOT replicate the integration tests for the
// heuristic itself; behavioural tests live alongside session-state tests.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '..', '..', '..', '..', '..');
const SNAPSHOT_PATH = join(
  REPO,
  'server', 'src', 'services', 'session', 'session-state-snapshot.service.ts',
);
const ORCH_PATH = join(
  REPO,
  'server', 'src', 'services', 'orchestration', 'orchestration.service.ts',
);
const SHARED_EVENTS_PATH = join(REPO, 'shared', 'src', 'types', 'events.ts');
const HOST_ACTIONS_PATH = join(
  REPO,
  'server', 'src', 'services', 'orchestration', 'handlers', 'host-actions.ts',
);

describe('Phase 7C.3 — test-mode banner v2 (architectural pins)', () => {
  test('snapshot service file exists', () => {
    expect(existsSync(SNAPSHOT_PATH)).toBe(true);
  });

  test('explicit session.config.testMode override path remains', () => {
    const src = readFileSync(SNAPSHOT_PATH, 'utf8');
    expect(src).toMatch(/typeof\s*\(?config\s*as\s*any\s*\)?\.testMode\s*===\s*'boolean'/);
  });

  test('heuristic drops the length-≥4 gate (signal-based, not length-based)', () => {
    const src = readFileSync(SNAPSHOT_PATH, 'utf8');
    // The new code must NOT have the old gate `.length >= 4` immediately
    // following the hostRoot computation. We assert the old guard is gone.
    expect(src).not.toMatch(/hostRoot\.length\s*>=\s*4/);
  });

  test('heuristic adds email-domain signal', () => {
    const src = readFileSync(SNAPSHOT_PATH, 'utf8');
    // We expect a comparison of host email domain against participant domain.
    expect(src).toMatch(/hostDomain|host_domain|email\.split\('@'\)\[1\]/);
  });

  test('heuristic adds display-name first-name token signal', () => {
    const src = readFileSync(SNAPSHOT_PATH, 'utf8');
    // We expect display_name to be pulled in the participant query AND a
    // comparison against the host's first-name token.
    expect(src).toMatch(/display_name/);
    expect(src).toMatch(/firstNameToken|firstName|nameToken/);
  });

  test('host:set_test_mode handler wired in orchestration.service.ts', () => {
    const src = readFileSync(ORCH_PATH, 'utf8');
    expect(src).toMatch(/wrapHandler\('host:set_test_mode'/);
  });

  test('host:set_test_mode handler implementation exists in host-actions.ts', () => {
    const src = readFileSync(HOST_ACTIONS_PATH, 'utf8');
    expect(src).toMatch(/handleHostSetTestMode|handleSetTestMode/);
    // Updates session config:
    expect(src).toMatch(/UPDATE\s+sessions\s+SET\s+config/i);
    // verifyHost guard:
    expect(src).toMatch(/verifyHost\s*\(\s*socket/);
  });

  test('shared event type advertises host:set_test_mode', () => {
    const src = readFileSync(SHARED_EVENTS_PATH, 'utf8');
    expect(src).toMatch(/'host:set_test_mode'\s*:\s*\(/);
    expect(src).toMatch(/'host:set_test_mode'[\s\S]{0,300}value\s*:\s*boolean/);
  });
});
