// Phase 5 (1 May 2026 spec) — single-source displayName helper
//
// Stefan's spec item 9: "Always show name + avatar + clear identity per user."
// Pre-Phase-5, fallbackName / fallbackPartnerName / fallbackNameFor /
// remFallback / conflictName were inlined in 5+ places across server
// orchestration handlers, with subtle variations. Display labels could
// disagree depending on which code path emitted the label.
//
// Phase 5 extracts resolveDisplayName + placeholderName to
// shared/src/identity/displayName.ts, then refactors all server call sites
// to import from there. Single source of truth.

import * as fs from 'fs';
import * as path from 'path';

function readServer(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '../../../', rel), 'utf8');
}

function readRepo(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '../../../../../', rel), 'utf8');
}

describe('Phase 5 — displayName unification', () => {
  describe('shared module exists with the canonical helper', () => {
    const src = readRepo('shared/src/identity/displayName.ts');

    it('exports resolveDisplayName(userId, displayName, email)', () => {
      expect(src).toMatch(/export function resolveDisplayName\(\s*userId: string,\s*displayName:/);
    });

    it('exports placeholderName(userId) for hot-loop misses', () => {
      // S25 re-point — signature widened to accept null/undefined so a
      // 1-person room's empty B-slot degrades to a generic label instead
      // of crashing the host-dashboard builder (null.slice TypeError).
      expect(src).toMatch(/export function placeholderName\(userId: string \| null \| undefined\)/);
    });

    it('fallback chain: displayName → email-prefix → "Participant {short}"', () => {
      expect(src).toMatch(/displayName \|\| ''/);
      expect(src).toMatch(/email \|\| ''/);
      expect(src).toMatch(/Participant\s+\$\{userId\.slice\(0, 6\)\}/);
    });
  });

  describe('shared package exports the identity module', () => {
    const src = readRepo('shared/src/index.ts');

    it('barrel re-exports identity/displayName', () => {
      expect(src).toMatch(/export \* from ['"]\.\/identity\/displayName['"]/);
    });
  });

  describe('server orchestration handlers import from shared (no inline copies)', () => {
    it('matching-flow.ts imports resolveDisplayName + placeholderName', () => {
      const src = readServer('services/orchestration/handlers/matching-flow.ts');
      expect(src).toMatch(/from ['"]@rsn\/shared['"]/);
      expect(src).toMatch(/resolveDisplayName/);
      expect(src).toMatch(/placeholderName/);
    });

    it('participant-flow.ts imports resolveDisplayName + placeholderName', () => {
      const src = readServer('services/orchestration/handlers/participant-flow.ts');
      expect(src).toMatch(/resolveDisplayName/);
      expect(src).toMatch(/placeholderName/);
    });

    it('host-actions.ts imports resolveDisplayName + placeholderName', () => {
      const src = readServer('services/orchestration/handlers/host-actions.ts');
      expect(src).toMatch(/resolveDisplayName/);
      expect(src).toMatch(/placeholderName/);
    });
  });

  describe('inline fallback copies removed from orchestration handlers', () => {
    // Pre-Phase-5 there were 5 inline `Participant ${id.slice(0, 6)}` literals
    // spread across orchestration handlers. After Phase 5 the only place such
    // a literal should appear is the shared/src/identity/displayName.ts.
    it('matching-flow.ts has no inline fallback function definitions', () => {
      const src = readServer('services/orchestration/handlers/matching-flow.ts');
      // Inline function definitions (e.g. `const fallbackName = (...) => {`)
      // are gone. Bare `Participant ${...}` literal should also be gone
      // (the helper covers it).
      expect(src).not.toMatch(/const fallbackName\s*=/);
      expect(src).not.toMatch(/const fallbackNameFor\s*=/);
      expect(src).not.toMatch(/const conflictName\s*=/);
    });

    it('participant-flow.ts has no inline fallback function definitions', () => {
      const src = readServer('services/orchestration/handlers/participant-flow.ts');
      expect(src).not.toMatch(/const fallbackPartnerName\s*=/);
      // The other inline fallback in this file was named `fallbackName` too —
      // we removed that in the same pass.
    });

    it('host-actions.ts has no inline remFallback', () => {
      const src = readServer('services/orchestration/handlers/host-actions.ts');
      expect(src).not.toMatch(/const remFallback\s*=/);
    });
  });
});
