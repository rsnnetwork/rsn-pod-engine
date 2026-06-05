// ─── WS3/E4+E5+E6 (27 May remaining work) — main-room audio cluster ────────
//
// E4 (echo / can't be heard): explicit echoCancellation/noiseSuppression/
// autoGainControl on the mic capture of BOTH rooms, and a documented lobby
// publish POLICY — non-hosts JOIN muted (audio={isHost}) but their token
// allows publishing, so the mic button genuinely unmutes them.
//
// E5/E6 (pin force-mutes / auto-mute flips back): LobbyMediaControls'
// join-preference application (auto-mute + camera pref + 500ms re-apply)
// was guarded by a per-INSTANCE useRef; pin/density changes swap the lobby
// between flex and grid trees which REMOUNTS the component → fresh ref →
// re-mute on every layout change. The guard is now keyed on the LiveKit
// participant SID at module scope: once per actual room connection.

import * as fs from 'fs';
import * as path from 'path';

function readClient(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '../../../../client/src', rel), 'utf8');
}

describe('WS3/E4 — echo-cancelled capture + deliberate lobby publish policy', () => {
  it('both rooms pin echoCancellation/noiseSuppression/autoGainControl on the mic capture', () => {
    for (const rel of ['features/live/Lobby.tsx', 'features/live/VideoRoom.tsx']) {
      const src = readClient(rel);
      expect(src).toMatch(/audioCaptureDefaults: \{ echoCancellation: true, noiseSuppression: true, autoGainControl: true \}/);
    }
  });

  it('the lobby join-muted policy is deliberate and documented (non-hosts can still unmute)', () => {
    const src = readClient('features/live/Lobby.tsx');
    expect(src).toMatch(/audio=\{isHost\}/);
    expect(src).toMatch(/publish POLICY/);
  });
});

describe('WS3/E5+E6 — join preferences apply once per room connection, not per remount', () => {
  it('the guard is SID-keyed at module scope (survives pin/density remounts)', () => {
    const src = readClient('features/live/Lobby.tsx');
    expect(src).toMatch(/appliedPrefsForSid = new Set<string>\(\)/);
    expect(src).toMatch(/appliedPrefsForSid\.has\(sid\)/);
    expect(src).toMatch(/appliedPrefsForSid\.add\(sid\)/);
  });

  it('the fragile per-instance appliedRef guard is gone', () => {
    const src = readClient('features/live/Lobby.tsx');
    expect(src).not.toMatch(/appliedRef/);
  });
});
