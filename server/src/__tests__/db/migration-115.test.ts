// ─── Migration 115: the pod wall (26 Oct 2026) ───────────────────────────────
//
// 25 Oct walkthrough, Stefan, back in the pod after an event: "We can't write in the pod itself.
// There's no wall, like a Facebook wall. There should be." A pod's active members get a discussion:
// posts, comments with one level of replies, one reaction per member per post, likes on comments.
// The four tables mirror the circle wall (migrations 077 and 091) and are the audit's design
// (05-post-event-comms.md section 4.3, option B: tables of their own, so a pod's posts cannot be
// reached from any circle route). The four bell types the wall rings with were added by migration
// 108, the only migration of this batch that restates notifications_type_check. This file is applied
// in production and never edited: a later change goes in a new migration and this test follows it.

import * as fs from 'fs';
import * as path from 'path';
import { REACTION_KINDS } from '../../services/circle/circle-wall.service';
import { transactionControl } from './transaction-control';

const MIGRATIONS = path.join(__dirname, '../../db/migrations');
const FILE = '115_pod_wall.sql';
const sql = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8');

/** The SQL without its comments, so a word in a comment is not read as a statement. */
const code = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const flat = code.replace(/\s+/g, ' ').trim();

/** The entries of `CREATE TABLE IF NOT EXISTS <table> ( … );`, one column or constraint each. */
function tableEntries(table: string): string[] {
  const match = flat.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\((.*?)\\);`, 'i'));
  if (!match) throw new Error(`${FILE} has no CREATE TABLE IF NOT EXISTS ${table}`);
  // Split on the commas between entries, not the ones inside a CHECK (…), REFERENCES x(y) or a string.
  const entries: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const ch of match[1]) {
    if (ch === "'") quoted = !quoted;
    if (!quoted && ch === '(') depth += 1;
    if (!quoted && ch === ')') depth -= 1;
    if (!quoted && depth === 0 && ch === ',') { entries.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  entries.push(current.trim());
  return entries;
}

/** The values a `CHECK (<column> IN ('a', 'b'))` allows, as the migration writes them. */
function allowedBy(table: string, column: string): string[] {
  const entry = tableEntries(table).find((e) => new RegExp(`^${column} `).test(e));
  const list = entry?.match(/IN \(([^)]*)\)/i);
  if (!list) throw new Error(`${FILE} has no CHECK (${column} IN (...)) in ${table}`);
  return [...list[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

describe('migration 115 (the pod wall)', () => {
  it('has no top-level BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK or ABORT (the runner wraps each file in its own transaction)', () => {
    expect(transactionControl(sql)).toEqual([]);
    expect(code).not.toMatch(/\bBEGIN\s*;/i);
    expect(code).not.toMatch(/\bCOMMIT\s*;/i);
  });

  it('creates pod_posts with the audit\'s columns: an idempotency key, soft delete with who did it, and a pin', () => {
    expect(tableEntries('pod_posts')).toEqual([
      'id UUID PRIMARY KEY DEFAULT gen_random_uuid()',
      'client_id UUID NOT NULL',
      'pod_id UUID NOT NULL REFERENCES pods(id) ON DELETE CASCADE',
      'author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE',
      "content TEXT NOT NULL DEFAULT '' CHECK (length(content) <= 8000)",
      "media JSONB NOT NULL DEFAULT '[]'",
      "link_url TEXT NULL CHECK (link_url IS NULL OR link_url ~* '^https?://')",
      'session_id UUID NULL REFERENCES sessions(id) ON DELETE SET NULL',
      'comment_count INTEGER NOT NULL DEFAULT 0',
      'pinned_at TIMESTAMPTZ NULL',
      'deleted_at TIMESTAMPTZ NULL',
      'deleted_by UUID NULL REFERENCES users(id) ON DELETE SET NULL',
      'edited_at TIMESTAMPTZ NULL',
      'created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
      'UNIQUE (author_id, client_id)',
    ]);
  });

  it('creates pod_post_comments: one level of replies, a reply goes with its comment, a comment with its post', () => {
    expect(tableEntries('pod_post_comments')).toEqual([
      'id UUID PRIMARY KEY DEFAULT gen_random_uuid()',
      'post_id UUID NOT NULL REFERENCES pod_posts(id) ON DELETE CASCADE',
      'author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE',
      'content TEXT NOT NULL CHECK (length(trim(content)) > 0 AND length(content) <= 4000)',
      'parent_comment_id UUID NULL REFERENCES pod_post_comments(id) ON DELETE CASCADE',
      'deleted_at TIMESTAMPTZ NULL',
      'created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
    ]);
  });

  it('creates pod_post_reactions: one reaction per member per post, from the circle wall\'s five kinds', () => {
    expect(tableEntries('pod_post_reactions')).toEqual([
      'id UUID PRIMARY KEY DEFAULT gen_random_uuid()',
      'post_id UUID NOT NULL REFERENCES pod_posts(id) ON DELETE CASCADE',
      'user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE',
      "reaction TEXT NOT NULL CHECK (reaction IN ('like', 'love', 'applause', 'insightful', 'celebrate'))",
      'created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
      'UNIQUE (post_id, user_id)',
    ]);
    // The service validates against REACTION_KINDS; the CHECK is the same list written out.
    expect([...allowedBy('pod_post_reactions', 'reaction')].sort()).toEqual([...REACTION_KINDS].sort());
  });

  it('creates pod_comment_likes: one like per member per comment', () => {
    expect(tableEntries('pod_comment_likes')).toEqual([
      'id UUID PRIMARY KEY DEFAULT gen_random_uuid()',
      'comment_id UUID NOT NULL REFERENCES pod_post_comments(id) ON DELETE CASCADE',
      'user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE',
      'created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
      'UNIQUE (comment_id, user_id)',
    ]);
  });

  it('indexes the feed (keyset order), the pinned strip, a comment thread, its replies and each author\'s recent writes', () => {
    expect(flat).toContain(
      'CREATE INDEX IF NOT EXISTS idx_pod_posts_feed ON pod_posts (pod_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;',
    );
    expect(flat).toContain(
      'CREATE INDEX IF NOT EXISTS idx_pod_posts_pinned ON pod_posts (pod_id, pinned_at DESC) WHERE deleted_at IS NULL AND pinned_at IS NOT NULL;',
    );
    expect(flat).toContain(
      'CREATE INDEX IF NOT EXISTS idx_pod_comments_post ON pod_post_comments (post_id, created_at) WHERE deleted_at IS NULL;',
    );
    expect(flat).toContain(
      'CREATE INDEX IF NOT EXISTS idx_pod_comments_parent ON pod_post_comments (parent_comment_id) WHERE parent_comment_id IS NOT NULL;',
    );
    // The one-minute caps on posting and commenting count a member's recent rows.
    expect(flat).toContain('CREATE INDEX IF NOT EXISTS idx_pod_posts_author ON pod_posts (author_id, created_at DESC);');
    expect(flat).toContain('CREATE INDEX IF NOT EXISTS idx_pod_comments_author ON pod_post_comments (author_id, created_at DESC);');
  });

  it('leaves notifications_type_check to migration 108, which already allows the four pod wall types', () => {
    expect(code).not.toMatch(/notifications_type_check/i);
    expect(code).not.toMatch(/\bnotifications\b/i);
    const m108 = fs.readFileSync(path.join(MIGRATIONS, '108_notification_types_oct25.sql'), 'utf8');
    for (const type of ['pod_post', 'pod_comment', 'pod_reply', 'pod_reaction']) expect(m108).toContain(`'${type}'`);
  });

  it('is the only migration that restates the allowlist after 099: this one is not a second definition', () => {
    const restating = fs.readdirSync(MIGRATIONS)
      .filter((file) => /^\d{3}_.+\.sql$/.test(file) && Number(file.slice(0, 3)) > 99)
      .filter((file) => /notifications_type_check/.test(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8').replace(/--[^\n]*/g, '')));
    expect(restating).not.toContain(FILE);
  });

  it('only adds: it drops, deletes, rewrites and alters nothing that is already there', () => {
    // A foreign key's ON DELETE says what happens later, when a row goes; it deletes nothing now.
    const statements = code.replace(/\bON DELETE (CASCADE|SET NULL)\b/gi, '');
    expect(statements).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT|ALTER)\b/i);
  });

  it('creates every table and index only when it is missing, so running it twice is safe', () => {
    const creates = flat.match(/CREATE (UNIQUE )?(TABLE|INDEX)\b[^;]*/gi) ?? [];
    expect(creates).toHaveLength(10);
    for (const create of creates) expect(create).toMatch(/IF NOT EXISTS/i);
  });
});
