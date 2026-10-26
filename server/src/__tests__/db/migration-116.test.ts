// ─── Migration 116: group chats started from an event (26 Oct 2026) ──────────
//
// Stefan, 25 Oct (COM-04): "Can there be 3, 5, 10, 20, 50 people in a chat? There should be." An organiser
// of a completed event starts a group chat with the people who took part, so dm_groups learns a third type
// ('event') and remembers its event. 050 wrote the table's two checks inline, so Postgres named them itself:
// dm_groups_type_check and dm_groups_check (read off the scratch database, built by the same 050, on 26 Oct).
// 116 replaces both by name. Applied files are never edited: a later change is a NEW migration and this
// test follows it.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const FILE = '116_event_groups.sql';
const sql = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8');

/** SQL without its comments, so a word in a comment is never read as a statement. */
const code = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const flat = code.replace(/\s+/g, ' ');

/** The body of the one DO block, between its dollar quotes. */
function doBlock(): string {
  const match = flat.match(/DO \$\$(.*?)\$\$;/i);
  if (!match) throw new Error(`${FILE} has no DO $$ … $$; block`);
  return match[1];
}

describe('migration 116 (group chats started from an event)', () => {
  it('has no top-level BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK or ABORT (the runner wraps each file in its own transaction)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it('adds dm_groups.session_id only if it is missing', () => {
    expect(flat).toMatch(/ALTER TABLE dm_groups ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES sessions\(id\) ON DELETE SET NULL;/i);
  });

  it('keeps the chat when its event is deleted: the link goes back to null, it never cascades', () => {
    expect(flat).not.toMatch(/session_id[^,;]*ON DELETE CASCADE/i);
  });

  it('drops the two checks 050 wrote inline, by the names Postgres gave them, inside a DO block', () => {
    const body = doBlock();
    expect(body).toMatch(/ALTER TABLE dm_groups DROP CONSTRAINT IF EXISTS dm_groups_type_check;/i);
    expect(body).toMatch(/ALTER TABLE dm_groups DROP CONSTRAINT IF EXISTS dm_groups_check;/i);
  });

  it('names the type check and lets a group be custom, pod or event, nothing else', () => {
    const check = doBlock().match(/ADD CONSTRAINT dm_groups_type_check CHECK \(\s*type\s+IN\s*\(([^)]*)\)\s*\)/i);
    expect(check).not.toBeNull();
    const allowed = [...check![1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
    expect(allowed.sort()).toEqual(['custom', 'event', 'pod']);
  });

  it('names the pod check: a pod group needs its pod, any other group needs none', () => {
    expect(doBlock()).toMatch(/ADD CONSTRAINT dm_groups_pod_id_check CHECK \(\s*type <> 'pod' OR pod_id IS NOT NULL\s*\)/i);
  });

  it('drops each named check before adding it, so running the file twice ends in the same state', () => {
    const body = doBlock();
    for (const name of ['dm_groups_type_check', 'dm_groups_pod_id_check']) {
      const dropAt = body.search(new RegExp(`DROP CONSTRAINT IF EXISTS ${name};`, 'i'));
      const addAt = body.search(new RegExp(`ADD CONSTRAINT ${name} `, 'i'));
      expect(dropAt).toBeGreaterThanOrEqual(0);
      expect(addAt).toBeGreaterThan(dropAt);
    }
  });

  it('never makes an event group need its event: deleting the event sets session_id to null, which such a check would refuse', () => {
    expect(flat).not.toMatch(/CHECK \([^;]*session_id IS NOT NULL/i);
  });

  it('stops, rather than leave the old type list in force, when dm_groups has a check under a name nobody expected', () => {
    const body = doBlock();
    expect(body).toMatch(/IF EXISTS \( SELECT 1 FROM pg_constraint WHERE conrelid = 'dm_groups'::regclass AND contype = 'c' AND conname NOT IN \('dm_groups_name_check', 'dm_groups_type_check', 'dm_groups_pod_id_check'\) \) THEN RAISE EXCEPTION/i);
    // The guard runs after the drops and the adds, so it judges the state the file leaves.
    expect(body.search(/IF EXISTS \( SELECT 1 FROM pg_constraint/i)).toBeGreaterThan(body.search(/ADD CONSTRAINT dm_groups_pod_id_check/i));
  });

  it('indexes the event link, only where there is one', () => {
    expect(flat).toMatch(/CREATE INDEX IF NOT EXISTS idx_dm_groups_session ON dm_groups ?\(session_id\) WHERE session_id IS NOT NULL;/i);
  });

  it('leaves notifications_type_check alone: 108 already allows group_message and is the only file that restates it', () => {
    expect(code).not.toMatch(/notifications_type_check/i);
  });

  it('touches nothing else: no table or column dropped, no row deleted, written or rewritten', () => {
    const statements = code
      .replace(/DROP CONSTRAINT IF EXISTS dm_groups_(type_check|check|pod_id_check)/gi, '')
      .replace(/\bON DELETE SET NULL\b/gi, '');
    expect(statements).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT)\b/i);
  });
});
