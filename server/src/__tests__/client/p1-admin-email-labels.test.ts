// ─── The admin's email page names every template (26 Oct 2026, P1 item 12) ───────────────────────────────────
//
// Every email type the migrations seed into email_config has a human label and description on the admin's email
// page; a type without one showed its raw key (meeting_reminder, seeded by migration 117, read "meeting_reminder").

import * as fs from 'fs';
import * as path from 'path';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const PAGE = path.join(__dirname, '../../../../client/src/features/admin/AdminEmailPage.tsx');

function seededEmailTypes(): string[] {
  const types = new Set<string>();
  for (const file of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
    for (const statement of sql.matchAll(/INSERT INTO email_config[\s\S]*?;/g)) {
      for (const tuple of statement[0].matchAll(/\(\s*'([a-z_]+)'/g)) types.add(tuple[1]);
    }
  }
  return [...types].sort();
}

function labelledEmailTypes(): Set<string> {
  const page = fs.readFileSync(PAGE, 'utf8');
  const block = /const EMAIL_TYPE_LABELS[^{]*\{([\s\S]*?)\n\};/.exec(page)?.[1] ?? '';
  return new Set([...block.matchAll(/^\s*([a-z_]+):\s*\{ label: '/gm)].map((m) => m[1]));
}

describe('the admin email page', () => {
  const seeded = seededEmailTypes();
  const labelled = labelledEmailTypes();

  it('reads the seeded types from the migrations (a change there lands here)', () => {
    expect(seeded).toEqual(expect.arrayContaining(['magic_link', 'invite_session', 'poke_request', 'meeting_reminder']));
  });

  it.each(seeded)('names the %s template', (type) => {
    expect(labelled.has(type)).toBe(true);
  });
});
