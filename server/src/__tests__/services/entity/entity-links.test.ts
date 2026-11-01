// ─── Every entity_members query says which links it means (30 Oct review, 7.2; audit 05 §7.2 risk 1) ─────────────
//
// A claim is 'pending' until an entity's admins approve it. One query that forgets the status shows an unapproved
// claim on someone's profile, counts it, or lets a pending person act as an admin. So every SQL text in the server
// that reads or writes entity_members either uses one of the fragments in entity-links.ts, or says in a comment
// /* every status: <why> */ that it means them all; this test fails on any that does neither. Writes keyed by the
// primary key (an INSERT of a new link, an UPDATE of one person's link) say what they set, so they are listed below
// by the exact text that marks them.

import * as fs from 'fs';
import * as path from 'path';
import { activeLinkSql, openLinkSql } from '../../../services/entity/entity-links';

const SRC = path.join(__dirname, '../../..');

function serverFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === '__tests__' ? [] : serverFiles(full);
    return /\.ts$/.test(d.name) ? [full] : [];
  });
}

/** Every template literal in a file that names entity_members, with the file it is in. */
function queriesNamingEntityMembers(): Array<{ file: string; sql: string }> {
  const found: Array<{ file: string; sql: string }> = [];
  for (const file of serverFiles(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    // Template literals, read without a pattern that could run past a nested ${...} (none here holds a backtick).
    let at = text.indexOf('`');
    while (at >= 0) {
      const end = text.indexOf('`', at + 1);
      if (end < 0) break;
      const sql = text.slice(at + 1, end);
      if (/\bentity_members\b/.test(sql)) found.push({ file: path.relative(SRC, file).split(path.sep).join('/'), sql });
      at = text.indexOf('`', end + 1);
    }
  }
  return found;
}

// Writes to one person's link, by its key, that set the status (or keep it) themselves.
const KEYED_WRITES = [
  /^INSERT INTO entity_members \(entity_id, user_id, role, title, is_admin, status\)/,
  /^INSERT INTO entity_members \(entity_id, user_id, role, title, status, requested_at\)/,
  /^UPDATE entity_members SET .* WHERE entity_id = \$1 AND user_id = (\$2|\()/,
  // `where` is the constant "WHERE entity_id = $1 AND user_id = $2" in setMyMembership.
  /^UPDATE entity_members SET .* \$\{where\}$/,
];

describe('entity links: one fragment says which links a query means', () => {
  it('the fragments are the status rules L23 sets', () => {
    expect(activeLinkSql('m')).toBe("m.status = 'active'");
    expect(openLinkSql('m')).toBe("m.status IN ('active', 'pending')");
    expect(() => activeLinkSql('m; DROP TABLE users')).toThrow();
  });

  it('every query naming entity_members uses activeLinkSql / openLinkSql, says every status on purpose, or is a keyed write', () => {
    const queries = queriesNamingEntityMembers();
    expect(queries.length).toBeGreaterThan(15);
    const unmarked = queries.filter(({ sql }) => {
      const flat = sql.replace(/\s+/g, ' ').trim();
      if (/\$\{[^}]*(activeLinkSql|openLinkSql)\(/.test(sql) || sql.includes('${LINK_COLUMNS}')) return false;
      if (/\/\* every status: [^*]+\*\//.test(sql)) return false;
      if (/WHERE m\.entity_id = \$1 AND \(m\.status = 'pending' OR/.test(flat)) return false;
      return !KEYED_WRITES.some((re) => re.test(flat));
    });
    expect(unmarked.map((q) => `${q.file}: ${q.sql.replace(/\s+/g, ' ').trim().slice(0, 120)}`)).toEqual([]);
  });

  it('the fan-out reads the live links (active and pending), not declined or removed ones', () => {
    const fanout = queriesNamingEntityMembers().filter((q) => q.file === 'realtime/fanout.ts');
    expect(fanout.length).toBe(1);
    expect(fanout[0].sql).toMatch(/\$\{openLinkSql\('m'\)\}/);
  });

  it('the lists never load a picture: the reads name only whether one is there (IS NOT NULL) and when it changed', () => {
    for (const rel of ['services/entity/entity.service.ts', 'services/circle/circle-entities.service.ts']) {
      expect(fs.readFileSync(path.join(SRC, rel), 'utf8')).not.toMatch(/(logo|banner)_(source_)?blob/);
    }
    const columns = fs.readFileSync(path.join(SRC, 'services/entity/entity-picture-url.ts'), 'utf8');
    for (const use of columns.match(/\.(logo|banner)_blob[^,)]*/g) ?? []) expect(use).toMatch(/IS NOT NULL/);
  });
});
