// Tests for Bug #1 — Pause timer drift between host and participant.
//
// Scenario: when host pauses a round, host sees 7:33 remaining and participant
// sees 7:21 (12s drift) because the server only emits a paused flag — each
// client kept ticking until it processed the event individually.
//
// Fix: handleHostPause / pauseSession (REST) must compute secondsRemaining
// ONCE on the server (Math.ceil((endsAt - Date.now())/1000)) and broadcast a
// unified `timer:sync` snapshot WITH that value to ALL participants in the
// session room — the same snapshot, identical for everyone.
//
// On resume: server adjusts endsAt = now + frozenRemainingMs and broadcasts
// another `timer:sync` so clients restart their 1s tick from a unified value.

describe('Bug #1 — Pause timer sync (no drift between host and participants)', () => {
  describe('host-actions.ts source contains the unified timer:sync snapshot on pause', () => {
    it('handleHostPause emits timer:sync with secondsRemaining and paused flag to session room', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/orchestration/handlers/host-actions.ts'),
        'utf8',
      );

      // Locate the handleHostPause function block — assertions must apply
      // inside that block, not anywhere else in the file.
      const pauseIdx = content.indexOf('export async function handleHostPause');
      expect(pauseIdx).toBeGreaterThan(-1);
      // Slice until the next `export async function` or +5000 chars (whichever
      // comes first) — the function grew with Bug 8.6 (April 19) timerEndsAt
      // null-clear comments, pushing the timer:sync emit past the old 2500
      // window.
      const nextExport = content.indexOf('\nexport async function ', pauseIdx + 30);
      const pauseBlock = content.slice(pauseIdx, nextExport > -1 ? nextExport : pauseIdx + 5000);

      // Must compute remaining ONCE from endsAt - Date.now() and use Math.ceil
      // for the second-precision snapshot.
      expect(pauseBlock).toMatch(/timerEndsAt[\s\S]*?Date\.now\(\)/);
      expect(pauseBlock).toMatch(/Math\.ceil\(/);
      // Must emit timer:sync to the whole session room
      expect(pauseBlock).toMatch(/io\.to\(sessionRoom\([^)]+\)\)\.emit\(\s*['"]timer:sync['"]/);
      // Must include paused: true in the timer:sync payload
      expect(pauseBlock).toMatch(/timer:sync[\s\S]{0,300}paused:\s*true/);
      // Must include secondsRemaining in the timer:sync payload
      expect(pauseBlock).toMatch(/timer:sync[\s\S]{0,300}secondsRemaining/);
    });

    it('handleHostResume emits timer:sync with secondsRemaining and paused:false to session room', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/orchestration/handlers/host-actions.ts'),
        'utf8',
      );

      const resumeIdx = content.indexOf('export async function handleHostResume');
      expect(resumeIdx).toBeGreaterThan(-1);
      const resumeBlock = content.slice(resumeIdx, resumeIdx + 2500);

      expect(resumeBlock).toMatch(/io\.to\(sessionRoom\([^)]+\)\)\.emit\(\s*['"]timer:sync['"]/);
      expect(resumeBlock).toMatch(/timer:sync[\s\S]{0,300}paused:\s*false/);
      expect(resumeBlock).toMatch(/timer:sync[\s\S]{0,300}secondsRemaining/);
    });

    it('REST pauseSession emits timer:sync with secondsRemaining and paused:true', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/orchestration/handlers/host-actions.ts'),
        'utf8',
      );

      const pauseRestIdx = content.indexOf('export async function pauseSession');
      expect(pauseRestIdx).toBeGreaterThan(-1);
      const block = content.slice(pauseRestIdx, pauseRestIdx + 2000);

      expect(block).toMatch(/timer:sync/);
      expect(block).toMatch(/paused:\s*true/);
      expect(block).toMatch(/secondsRemaining/);
    });

    it('REST resumeSession emits timer:sync with secondsRemaining and paused:false', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../services/orchestration/handlers/host-actions.ts'),
        'utf8',
      );

      const resumeRestIdx = content.indexOf('export async function resumeSession');
      expect(resumeRestIdx).toBeGreaterThan(-1);
      const block = content.slice(resumeRestIdx, resumeRestIdx + 2000);

      expect(block).toMatch(/timer:sync/);
      expect(block).toMatch(/paused:\s*false/);
      expect(block).toMatch(/secondsRemaining/);
    });
  });

  describe('client useSessionSocket.ts honors paused flag in timer:sync', () => {
    it('timer:sync handler stops local tick when paused:true and applies snapshot value', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../../../client/src/hooks/useSessionSocket.ts'),
        'utf8',
      );

      // Find the timer:sync handler
      const handlerIdx = content.indexOf("socket.on('timer:sync'");
      expect(handlerIdx).toBeGreaterThan(-1);
      const block = content.slice(handlerIdx, handlerIdx + 1200);

      // Must reference data.paused and clear timer when paused
      expect(block).toMatch(/data\.paused/);
      // Must NOT restart interval when paused === true
      // (i.e. the restart path is gated by a paused check)
      expect(block).toMatch(/!\s*data\.paused|data\.paused\s*===\s*false|data\.paused\s*\?[\s\S]*?:[\s\S]*?setInterval|if\s*\(\s*!data\.paused/);
    });

    it('client honors setIsPaused from timer:sync to keep store in sync', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../../../../client/src/hooks/useSessionSocket.ts'),
        'utf8',
      );

      const handlerIdx = content.indexOf("socket.on('timer:sync'");
      // Bumped from 1200 to 3000 chars after Bug 17 comment expansion
      // pushed setIsPaused past the original window.
      const block = content.slice(handlerIdx, handlerIdx + 3000);
      // Should call setIsPaused to keep paused state coherent across refreshes / reconnects
      expect(block).toMatch(/setIsPaused/);
    });
  });
});
