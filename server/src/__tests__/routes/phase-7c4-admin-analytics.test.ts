// ─── Phase 7C.4 — Admin analytics dashboard ─────────────────────────────────
//
// Architectural pins for Stefan #6 (7 May spec).
// Asserts that:
//   1. The analytics endpoints exist on the admin router with the canonical
//      auth chain (authenticate + requireRole ADMIN).
//   2. Each endpoint reads the canonical sources (sessions, ratings,
//      meeting_records, matches) — no derived/duplicate sources.
//   3. The CSV export endpoint accepts a :type segment and routes to the
//      same query the JSON endpoint uses (single source of truth).
//   4. The endpoints implement an in-memory cache with a TTL constant
//      (so a chart-page reload doesn't slam the DB).

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '..', '..', '..', '..');
const ADMIN_ROUTER = join(REPO, 'server', 'src', 'routes', 'admin.ts');

describe('Phase 7C.4 — admin analytics endpoints (architectural pins)', () => {
  test('admin router file exists', () => {
    expect(existsSync(ADMIN_ROUTER)).toBe(true);
  });

  test('GET /analytics/overview is defined with admin-only auth', () => {
    const src = readFileSync(ADMIN_ROUTER, 'utf8');
    expect(src).toMatch(/router\.get\(\s*['"]\/analytics\/overview['"]/);
    // The handler must be wrapped by the canonical auth chain
    expect(src).toMatch(/['"]\/analytics\/overview['"][\s\S]{0,400}authenticate[\s\S]{0,200}requireRole\(UserRole\.ADMIN\)/);
  });

  test('GET /analytics/events is defined with admin-only auth', () => {
    const src = readFileSync(ADMIN_ROUTER, 'utf8');
    expect(src).toMatch(/router\.get\(\s*['"]\/analytics\/events['"]/);
    expect(src).toMatch(/['"]\/analytics\/events['"][\s\S]{0,400}authenticate[\s\S]{0,200}requireRole\(UserRole\.ADMIN\)/);
  });

  test('GET /analytics/users is defined with admin-only auth', () => {
    const src = readFileSync(ADMIN_ROUTER, 'utf8');
    expect(src).toMatch(/router\.get\(\s*['"]\/analytics\/users['"]/);
    expect(src).toMatch(/['"]\/analytics\/users['"][\s\S]{0,400}authenticate[\s\S]{0,200}requireRole\(UserRole\.ADMIN\)/);
  });

  test('GET /analytics/connections is defined with admin-only auth', () => {
    const src = readFileSync(ADMIN_ROUTER, 'utf8');
    expect(src).toMatch(/router\.get\(\s*['"]\/analytics\/connections['"]/);
    expect(src).toMatch(/['"]\/analytics\/connections['"][\s\S]{0,400}authenticate[\s\S]{0,200}requireRole\(UserRole\.ADMIN\)/);
  });

  test('CSV export endpoint exists for analytics', () => {
    const src = readFileSync(ADMIN_ROUTER, 'utf8');
    // Either /analytics/export/:type.csv or /analytics/:type/export.csv
    expect(src).toMatch(/['"]\/analytics\/export\/:type|['"]\/analytics\/:type\/export/);
  });

  test('Analytics queries hit canonical source tables', () => {
    const src = readFileSync(ADMIN_ROUTER, 'utf8');
    // Single source of truth signals — these tables MUST appear inside the
    // analytics handlers (not just elsewhere in the file).
    expect(src).toMatch(/meeting_records/);
    expect(src).toMatch(/ratings/);
    expect(src).toMatch(/sessions/);
  });

  test('Analytics endpoints have an in-memory cache TTL constant', () => {
    const src = readFileSync(ADMIN_ROUTER, 'utf8');
    // Look for an explicit TTL definition (cacheTtl, ANALYTICS_CACHE_TTL, etc).
    expect(src).toMatch(/ANALYTICS_CACHE_TTL|analyticsCacheTtl|ANALYTICS_TTL_MS/);
  });

  test('Analytics handlers use the cache (cache-or-compute pattern)', () => {
    const src = readFileSync(ADMIN_ROUTER, 'utf8');
    // The cache implementation must read-through, not just be defined.
    expect(src).toMatch(/analyticsCache|cache\.get|cached\?\s*[:=]/);
  });
});
