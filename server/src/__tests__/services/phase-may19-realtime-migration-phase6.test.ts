// Phase 6 of the realtime architecture migration. The repo-level
// `scripts/check-realtime-entities.js` guard makes it structurally
// impossible to ship a new useQuery without meta.entities (or an
// explicit `// realtime: skip` opt-out). Pin its behaviour so the
// guard itself can't quietly regress.

import * as nodeFs from 'fs';
import * as nodePath from 'path';
import { spawnSync } from 'child_process';

function readRepo(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../', rel), 'utf8');
}
function repoRoot(): string {
  return nodePath.resolve(__dirname, '../../../../');
}

describe('Phase 6 — realtime contract guard (scripts/check-realtime-entities.js)', () => {
  describe('script source — covers every required behaviour', () => {
    const src = readRepo('scripts/check-realtime-entities.js');

    it('exists and scans client/src by default', () => {
      expect(src).toMatch(/CLIENT_SRC\s*=\s*path\.resolve\([^)]*'client',\s*'src'\)/);
    });

    it('detects useQuery calls and inspects their options object', () => {
      expect(src).toMatch(/findUseQueryCalls/);
      expect(src).toMatch(/\\buseQuery\\s\*\(\?:<\[\^>\]\*>\)\?\\s\*\\\(\\s\*\\\{/);
    });

    it('treats missing meta as a violation', () => {
      expect(src).toMatch(/useQuery missing meta\.entities/);
    });

    it('treats empty entities literal \\[] as a violation', () => {
      expect(src).toMatch(/empty \[\]/);
    });

    it('honours the // realtime: skip opt-out comment', () => {
      expect(src).toMatch(/realtime:\s*skip/);
      expect(src).toMatch(/OPT_OUT_RE/);
    });

    it('has an allowlist of legitimately non-realtime queryKey prefixes', () => {
      expect(src).toMatch(/ALLOWLISTED_KEY_PREFIXES/);
      // Each allowlisted key earns its place: search (ephemeral),
      // matching-templates / admin-templates / admin-email-config (admin
      // configs that rarely mutate, manual refresh OK), admin-health
      // (polled separately).
      expect(src).toMatch(/'connected-user-search'/);
      expect(src).toMatch(/'matching-templates'/);
      expect(src).toMatch(/'admin-templates'/);
      expect(src).toMatch(/'admin-email-config'/);
      expect(src).toMatch(/'admin-health'/);
    });

    it('exits non-zero on violations and zero on clean (process.exit pattern)', () => {
      expect(src).toMatch(/process\.exit\(0\)/);
      expect(src).toMatch(/process\.exit\(1\)/);
    });
  });

  describe('wiring — guard runs in lint + CI', () => {
    const root = readRepo('package.json');
    const workflow = readRepo('.github/workflows/ci.yml');

    it('package.json declares lint:realtime', () => {
      expect(root).toMatch(/"lint:realtime"\s*:\s*"node scripts\/check-realtime-entities\.js"/);
    });

    it('npm run lint chain includes lint:realtime', () => {
      expect(root).toMatch(/"lint"\s*:\s*"[^"]*lint:realtime/);
    });

    it('CI workflow runs the realtime contract guard as a discrete step before tests', () => {
      expect(workflow).toMatch(/Realtime contract guard/);
      expect(workflow).toMatch(/npm run lint:realtime/);
    });
  });

  describe('functional — guard correctly catches violations on synthetic input', () => {
    // We invoke the script against a temp directory with hand-crafted
    // fixtures. The script's CLIENT_SRC constant points at the real
    // client/, so we drop fixtures into client/src/__test_realtime_guard__/
    // and assert the script either accepts or rejects them. The fixtures
    // are deleted in afterAll so they don't pollute the real codebase.

    const fixtureDir = nodePath.join(repoRoot(), 'client', 'src', '__test_realtime_guard__');

    function writeFixture(name: string, contents: string) {
      if (!nodeFs.existsSync(fixtureDir)) nodeFs.mkdirSync(fixtureDir, { recursive: true });
      nodeFs.writeFileSync(nodePath.join(fixtureDir, name), contents);
    }

    function runGuard(): { code: number; stdout: string; stderr: string } {
      const result = spawnSync(
        process.execPath,
        [nodePath.join(repoRoot(), 'scripts', 'check-realtime-entities.js')],
        { cwd: repoRoot(), encoding: 'utf8' },
      );
      return {
        code: result.status ?? -1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
    }

    afterAll(() => {
      if (nodeFs.existsSync(fixtureDir)) {
        nodeFs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    });

    afterEach(() => {
      // Clear all fixtures between cases so each test runs against ONLY its
      // own input.
      if (nodeFs.existsSync(fixtureDir)) {
        for (const f of nodeFs.readdirSync(fixtureDir)) {
          nodeFs.unlinkSync(nodePath.join(fixtureDir, f));
        }
      }
    });

    it('rejects a useQuery missing meta entirely', () => {
      writeFixture('bad-missing-meta.tsx', `
        import { useQuery } from '@tanstack/react-query';
        export function X() {
          return useQuery({
            queryKey: ['some-key', 'x'],
            queryFn: () => Promise.resolve(null),
          });
        }
      `);
      const r = runGuard();
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/missing meta\.entities/);
    });

    it('rejects a useQuery with empty entities array', () => {
      writeFixture('bad-empty-entities.tsx', `
        import { useQuery } from '@tanstack/react-query';
        export function X() {
          return useQuery({
            queryKey: ['some-key', 'x'],
            queryFn: () => Promise.resolve(null),
            meta: { entities: [] },
          });
        }
      `);
      const r = runGuard();
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/empty/);
    });

    it('accepts a useQuery with valid meta.entities', () => {
      writeFixture('good-with-entities.tsx', `
        import { useQuery } from '@tanstack/react-query';
        import { E } from '@/realtime/entities';
        export function X() {
          return useQuery({
            queryKey: ['some-key', 'x'],
            queryFn: () => Promise.resolve(null),
            meta: { entities: [E.pod('abc')] },
          });
        }
      `);
      const r = runGuard();
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/OK/);
    });

    it('accepts a useQuery preceded by // realtime: skip opt-out', () => {
      writeFixture('good-skip-comment.tsx', `
        import { useQuery } from '@tanstack/react-query';
        export function X() {
          // realtime: skip — ephemeral search, results die on next keystroke
          return useQuery({
            queryKey: ['some-search'],
            queryFn: () => Promise.resolve(null),
          });
        }
      `);
      const r = runGuard();
      expect(r.code).toBe(0);
    });

    it('accepts a useQuery whose queryKey prefix is in the allowlist', () => {
      writeFixture('good-allowlisted-key.tsx', `
        import { useQuery } from '@tanstack/react-query';
        export function X() {
          return useQuery({
            queryKey: ['matching-templates'],
            queryFn: () => Promise.resolve(null),
          });
        }
      `);
      const r = runGuard();
      expect(r.code).toBe(0);
    });
  });
});
