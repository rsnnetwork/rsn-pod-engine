// ─── Phase 8B — Stefan's 8 May review, client state sync + Esc hygiene ────
//
// 8B.1  Client listens to permissions:updated so cohost UI is real-time.
// 8B.2  useEscapeKey hook wired into every modal that traps the user.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '..', '..', '..', '..');
const CLIENT = join(REPO, 'client', 'src');

const SOCKET = join(CLIENT, 'hooks', 'useSessionSocket.ts');
const ESC_HOOK = join(CLIENT, 'hooks', 'useEscapeKey.ts');
const HOST_CONTROLS = join(CLIENT, 'features', 'live', 'HostControls.tsx');
const HCC = join(CLIENT, 'features', 'live', 'HostControlCenter.tsx');

describe('Phase 8B — client state sync + Esc handlers', () => {
  test('8B.1 — useSessionSocket listens for permissions:updated', () => {
    const src = readFileSync(SOCKET, 'utf8');
    expect(src).toMatch(/['"]permissions:updated['"]/);
    // Must be in SOCKET_EVENTS (or otherwise registered) so cleanup unsubscribes.
    expect(src).toMatch(/socket\.on\(\s*['"]permissions:updated['"]/);
  });

  test('8B.2a — useEscapeKey hook file exists and exports the canonical helper', () => {
    expect(existsSync(ESC_HOOK)).toBe(true);
    const src = readFileSync(ESC_HOOK, 'utf8');
    expect(src).toMatch(/export\s+function\s+useEscapeKey\s*\(/);
  });

  test('8B.2b — Invite + Room modals in HostControls use useEscapeKey', () => {
    const src = readFileSync(HOST_CONTROLS, 'utf8');
    expect(src).toMatch(/useEscapeKey\(/);
    // Both modals are wired — at least two call sites.
    const calls = (src.match(/useEscapeKey\(/g) || []).length;
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test('8B.2c — HostControlCenter Move-to-room sub-modal uses useEscapeKey', () => {
    const src = readFileSync(HCC, 'utf8');
    expect(src).toMatch(/useEscapeKey\(/);
  });
});
