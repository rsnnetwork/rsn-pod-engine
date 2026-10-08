// Phase 6 of the realtime architecture migration. The repo-level
// `scripts/check-realtime-entities.js` guard makes it structurally
// impossible to ship a new useQuery without meta.entities (or an
// explicit `// realtime: skip` opt-out). Pin its behaviour so the
// guard itself can't quietly regress.

import * as nodeFs from 'fs';
import * as nodeOs from 'os';
import * as nodePath from 'path';
import { spawnSync } from 'child_process';

function readRepo(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../', rel), 'utf8');
}
function repoRoot(): string {
  return nodePath.resolve(__dirname, '../../../../');
}

// `args` is what follows the script on the command line. REALTIME_GUARD_ROOT is cleared
// unless a case sets it, so the caller's own environment cannot change what a case scans.
function runGuardWith(args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [nodePath.join(repoRoot(), 'scripts', 'check-realtime-entities.js'), ...args],
    { cwd: repoRoot(), encoding: 'utf8', env: { ...process.env, REALTIME_GUARD_ROOT: '', ...env } },
  );
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('Phase 6 — realtime contract guard (scripts/check-realtime-entities.js)', () => {
  describe('script source — covers every required behaviour', () => {
    const src = readRepo('scripts/check-realtime-entities.js');

    it('exists and scans client/src by default', () => {
      expect(src).toMatch(/DEFAULT_ROOT\s*=\s*path\.resolve\([^)]*'client',\s*'src'\)/);
    });

    it('scans the folder it is given instead, from its first argument or REALTIME_GUARD_ROOT', () => {
      expect(src).toMatch(/process\.argv\[2\]/);
      expect(src).toMatch(/process\.env\.REALTIME_GUARD_ROOT/);
    });

    it('detects useQuery calls and inspects their options object', () => {
      expect(src).toMatch(/findUseQueryCalls/);
      // 5 Oct 2026: a call with type arguments, however nested, is read like one
      // without. The behaviour is pinned by the functional cases below; this pins
      // that the scan for the closing bracket exists at all.
      expect(src).toMatch(/skipTypeArguments/);
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

  describe('wiring — guard runs in lint', () => {
    const root = readRepo('package.json');

    it('package.json declares lint:realtime', () => {
      expect(root).toMatch(/"lint:realtime"\s*:\s*"node scripts\/check-realtime-entities\.js"/);
    });

    it('npm run lint chain includes lint:realtime', () => {
      expect(root).toMatch(/"lint"\s*:\s*"[^"]*lint:realtime/);
    });

    // Note: a discrete CI workflow step (`Realtime contract guard`) is the
    // ideal enforcement layer but requires GitHub `workflow` scope on the
    // push token. Tracked as a manual TODO for Ali to add in the GitHub
    // web UI between "Build client" and "Run tests":
    //
    //   - name: Realtime contract guard
    //     run: npm run lint:realtime
    //
    // Until then, `npm run lint` enforces it locally and any developer
    // who runs lint before push catches violations.
  });

  describe('functional — guard correctly catches violations on synthetic input', () => {
    // We invoke the script against a folder of hand-crafted fixtures, which it
    // takes as its first argument. The folder is made in the OS temp directory
    // for this run and removed after it. It used to be client/src/__test_realtime_guard__/,
    // and the suites that read client/src (onboarding-gate, phase-l, the query cache
    // test) sometimes listed a fixture a moment before it was removed: ENOENT, a red
    // suite that passed again on the next run. No test writes inside the repo now.

    let fixtureDir: string;

    beforeAll(() => {
      fixtureDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'realtime-guard-'));
    });

    function writeFixture(name: string, contents: string) {
      nodeFs.writeFileSync(nodePath.join(fixtureDir, name), contents);
    }

    function runGuard() {
      return runGuardWith([fixtureDir]);
    }

    afterAll(() => {
      nodeFs.rmSync(fixtureDir, { recursive: true, force: true });
    });

    afterEach(() => {
      // Clear all fixtures between cases so each test runs against ONLY its
      // own input.
      for (const f of nodeFs.readdirSync(fixtureDir)) {
        nodeFs.unlinkSync(nodePath.join(fixtureDir, f));
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

    // ── 5 Oct 2026: a call with type arguments, useQuery<T>({ ───────────────
    //
    // MatchesPage's only query was useQuery<PlatformMatchesResult>({ with no
    // meta. The guard skipped every file that had no plain `useQuery(` in it, so
    // the page was never looked at and shipped a query that could not refresh
    // from realtime. Each of these fixtures is the only query in its file, which
    // is the case the old guard could not see.

    it('rejects a useQuery<T>({ with no meta, in a file whose only call it is', () => {
      writeFixture('bad-generic-only-call.tsx', `
        import { useQuery } from '@tanstack/react-query';
        interface PlatformMatchesResult { matches: string[] }
        export function X(browse: boolean) {
          const { data } = useQuery<PlatformMatchesResult>({
            queryKey: ['platformMatches', browse],
            queryFn: () => Promise.resolve({ matches: [] }),
          });
          return data;
        }
      `);
      const r = runGuard();
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/missing meta\.entities/);
      expect(r.stderr).toMatch(/bad-generic-only-call\.tsx:\d+:\d+/);
      expect(r.stderr).toMatch(/queryKey starts with: 'platformMatches'/);
    });

    it('rejects a useQuery<T>({ whose meta.entities is empty', () => {
      writeFixture('bad-generic-empty-entities.tsx', `
        import { useQuery } from '@tanstack/react-query';
        export function X() {
          return useQuery<string[]>({
            queryKey: ['some-key'],
            queryFn: () => Promise.resolve([]),
            meta: { entities: [] },
          });
        }
      `);
      const r = runGuard();
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/empty/);
    });

    it('rejects a call whose type arguments nest, however deeply, or hold an arrow type', () => {
      writeFixture('bad-generic-nested.tsx', `
        import { useQuery } from '@tanstack/react-query';
        export function A() {
          return useQuery<Array<{ id: string; name: string }>>({
            queryKey: ['nested-a'],
            queryFn: () => Promise.resolve([]),
          });
        }
        export function B() {
          return useQuery<Record<string, Array<Map<string, number>>>>({
            queryKey: ['nested-b'],
            queryFn: () => Promise.resolve({}),
          });
        }
        export function C() {
          return useQuery<{ run: () => void }>({
            queryKey: ['nested-c'],
            queryFn: () => Promise.resolve({ run: () => undefined }),
          });
        }
      `);
      const r = runGuard();
      expect(r.code).toBe(1);
      // Three calls, three violations: none of the shapes hid its call.
      expect(r.stderr).toMatch(/3 useQuery call\(s\) missing realtime contract/);
      expect(r.stderr).toMatch(/queryKey starts with: 'nested-a'/);
      expect(r.stderr).toMatch(/queryKey starts with: 'nested-b'/);
      expect(r.stderr).toMatch(/queryKey starts with: 'nested-c'/);
    });

    it('rejects a multi-line type argument list and a call with a space before the bracket', () => {
      writeFixture('bad-generic-layout.tsx', `
        import { useQuery } from '@tanstack/react-query';
        export function A() {
          return useQuery<
            Array<string>
          >({
            queryKey: ['layout-a'],
            queryFn: () => Promise.resolve([]),
          });
        }
        export function B() {
          return useQuery <string> ( {
            queryKey: ['layout-b'],
            queryFn: () => Promise.resolve(''),
          });
        }
      `);
      const r = runGuard();
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/2 useQuery call\(s\) missing realtime contract/);
    });

    it('accepts a useQuery<T>({ with valid meta.entities, nested or not', () => {
      writeFixture('good-generic-with-entities.tsx', `
        import { useQuery } from '@tanstack/react-query';
        import { E } from '@/realtime/entities';
        export function A() {
          return useQuery<string[]>({
            queryKey: ['good-a'],
            queryFn: () => Promise.resolve([]),
            meta: { entities: [E.pod('abc')] },
          });
        }
        export function B() {
          return useQuery<Array<{ id: string }>>({
            queryKey: ['good-b'],
            queryFn: () => Promise.resolve([]),
            meta: { entities: [E.user('abc'), E.userInvites('abc')] },
          });
        }
      `);
      const r = runGuard();
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/OK/);
    });

    it('accepts a useQuery<T>({ preceded by // realtime: skip, and a queryKey on the allowlist', () => {
      writeFixture('good-generic-opt-outs.tsx', `
        import { useQuery } from '@tanstack/react-query';
        export function A() {
          // realtime: skip — ephemeral search, results die on next keystroke
          return useQuery<Array<{ id: string }>>({
            queryKey: ['some-search'],
            queryFn: () => Promise.resolve([]),
          });
        }
        export function B() {
          return useQuery<string[]>({
            queryKey: ['matching-templates'],
            queryFn: () => Promise.resolve([]),
          });
        }
      `);
      const r = runGuard();
      expect(r.code).toBe(0);
    });

    it('does not mistake a type that names useQuery for a call', () => {
      writeFixture('good-type-position.tsx', `
        import { useQuery } from '@tanstack/react-query';
        import { E } from '@/realtime/entities';
        interface Rows { rows: string[] }
        // Used only as a type: ReturnType<typeof useQuery<Rows>> is not a call.
        export type RowsQuery = ReturnType<typeof useQuery<Rows>>;
        export function X(q: RowsQuery) {
          return q.data;
        }
        export function Y() {
          return useQuery<Rows>({
            queryKey: ['rows'],
            queryFn: () => Promise.resolve({ rows: [] }),
            meta: { entities: [E.adminAnalytics] },
          });
        }
      `);
      const r = runGuard();
      expect(r.code).toBe(0);
    });
  });

  describe('functional — which folder it scans (8 Oct 2026)', () => {
    const BAD = `
      import { useQuery } from '@tanstack/react-query';
      export function X() {
        return useQuery({ queryKey: ['no-meta'], queryFn: () => Promise.resolve(null) });
      }
    `;
    const GOOD = `
      import { useQuery } from '@tanstack/react-query';
      import { E } from '@/realtime/entities';
      export function X() {
        return useQuery({ queryKey: ['has-meta'], queryFn: () => Promise.resolve(null), meta: { entities: [E.pod('abc')] } });
      }
    `;
    let badDir: string;
    let goodDir: string;

    beforeAll(() => {
      badDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'realtime-guard-bad-'));
      goodDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'realtime-guard-good-'));
      nodeFs.writeFileSync(nodePath.join(badDir, 'bad.tsx'), BAD);
      nodeFs.writeFileSync(nodePath.join(goodDir, 'good.tsx'), GOOD);
    });

    afterAll(() => {
      nodeFs.rmSync(badDir, { recursive: true, force: true });
      nodeFs.rmSync(goodDir, { recursive: true, force: true });
    });

    it('scans the folder named as its first argument, and only that folder', () => {
      expect(runGuardWith([badDir]).code).toBe(1);
      const clean = runGuardWith([goodDir]);
      expect(clean.code).toBe(0);
      expect(clean.stdout).toMatch(/scanned 1 files/);
    });

    it('scans the folder named in REALTIME_GUARD_ROOT when no argument is given', () => {
      expect(runGuardWith([], { REALTIME_GUARD_ROOT: badDir }).code).toBe(1);
      const clean = runGuardWith([], { REALTIME_GUARD_ROOT: goodDir });
      expect(clean.code).toBe(0);
      expect(clean.stdout).toMatch(/scanned 1 files/);
    });

    it('lets the argument win over REALTIME_GUARD_ROOT', () => {
      expect(runGuardWith([goodDir], { REALTIME_GUARD_ROOT: badDir }).code).toBe(0);
      expect(runGuardWith([badDir], { REALTIME_GUARD_ROOT: goodDir }).code).toBe(1);
    });

    it('fails on a folder that is named but is not there, instead of passing a scan of nothing', () => {
      const missing = nodePath.join(goodDir, 'no-such-folder');
      const r = runGuardWith([missing]);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/does not exist/);
      expect(runGuardWith([], { REALTIME_GUARD_ROOT: missing }).code).toBe(2);
    });

    it('scans client/src when nothing names a folder, and finds it clean (what npm run lint:realtime runs)', () => {
      const r = runGuardWith([]);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/OK — scanned \d{2,} files/);
    });
  });
});

describe('no test writes inside the repo (8 Oct 2026)', () => {
  // A test that wrote fixtures into client/src made the suites that read that folder see
  // files appear and vanish mid-read. Anything a test writes goes under the OS temp folder.
  const TESTS = nodePath.resolve(__dirname, '..');
  const IMPORTS_FS = /from\s+['"](?:node:)?fs(?:\/promises)?['"]|require\(['"](?:node:)?fs(?:\/promises)?['"]\)/;
  const WRITES = /\b(?:writeFile|appendFile|mkdir|mkdtemp|rm|rmdir|unlink|rename|copyFile|truncate|createWriteStream)(?:Sync)?\(/;

  function testFiles(dir: string): string[] {
    return nodeFs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) return testFiles(full);
      return entry.name.endsWith('.ts') ? [full] : [];
    });
  }

  it('every test that writes a file names the OS temp folder', () => {
    const writers = testFiles(TESTS)
      .map((file) => ({ file, source: nodeFs.readFileSync(file, 'utf8') }))
      .filter(({ source }) => IMPORTS_FS.test(source) && WRITES.test(source));
    expect(writers.map((w) => nodePath.basename(w.file))).toContain(nodePath.basename(__filename)); // the scan can see a writer
    const outsideTemp = writers
      .filter(({ source }) => !/\btmpdir\(\)/.test(source))
      .map(({ file }) => nodePath.relative(TESTS, file));
    expect(outsideTemp).toEqual([]);
  });
});
