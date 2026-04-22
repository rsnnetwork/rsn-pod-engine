// Defensive transaction wrapper — prevents pg async 'error' events on a
// terminated client from escaping as uncaughtException → process.exit(1).
//
// Production incident (2026-04-22):
//   10:59:44 UTC server_failed nonZeroExit:1 — DatabaseError "terminating
//                connection due to idle-in-transaction timeout"
//   11:10:22 UTC server_failed nonZeroExit:1 — same
//
// Root cause: Postgres killed an idle-in-transaction connection (Neon's
// idle_in_transaction_session_timeout). The pg client emitted an async
// 'error' event with no listener, which Node converts to uncaughtException.
// `process.on('uncaughtException', ...)` in index.ts called process.exit(1).

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readSource(): string {
  return nodeFs.readFileSync(
    nodePath.join(__dirname, '../../db/index.ts'),
    'utf8',
  );
}

describe('Defensive db/index.ts wrappers (production crash fix)', () => {
  const src = readSource();

  describe('transaction()', () => {
    it("attaches a client.on('error', ...) listener to swallow async termination errors", () => {
      expect(src).toMatch(/export async function transaction[\s\S]+?client\.on\(['"]error['"]\s*,\s*onClientError\)/);
    });

    it('removes the error listener in the finally block (no leak)', () => {
      const fnStart = src.indexOf('export async function transaction');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/client\.off\(['"]error['"]\s*,\s*onClientError\)/);
    });

    it('skips ROLLBACK when connection is already known dead', () => {
      const fnStart = src.indexOf('export async function transaction');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/if\s*\(\s*!connectionDied\s*\)\s*await safeRollback/);
    });

    it('uses safeRelease for the client.release call (never throws)', () => {
      const fnStart = src.indexOf('export async function transaction');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/safeRelease\(client/);
    });
  });

  describe('withSessionLock()', () => {
    it('attaches the same error listener pattern', () => {
      expect(src).toMatch(/export async function withSessionLock[\s\S]+?client\.on\(['"]error['"]\s*,\s*onClientError\)/);
    });

    it('uses safeRollback + safeRelease too', () => {
      const fnStart = src.indexOf('export async function withSessionLock');
      const fnEnd = src.indexOf('\nexport ', fnStart + 1);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/safeRollback/);
      expect(fn).toMatch(/safeRelease/);
    });
  });

  describe('safeRollback / safeRelease helpers', () => {
    it('safeRollback wraps client.query in try/catch and logs warn', () => {
      expect(src).toMatch(/async function safeRollback[\s\S]+?try \{ await client\.query\(['"]ROLLBACK/);
      expect(src).toMatch(/safeRollback[\s\S]+?logger\.warn/);
    });

    it('safeRelease wraps client.release in try/catch', () => {
      expect(src).toMatch(/function safeRelease[\s\S]+?try \{ client\.release/);
      expect(src).toMatch(/safeRelease[\s\S]+?logger\.warn/);
    });
  });
});
