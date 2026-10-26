// ─── Migration 112: event chat is kept (26 Oct 2026) ─────────────────────────────────────────────
//
// On 25 Oct the people of a finished event reopened it and could not read what they had chatted about: the
// chat lived in one server process's memory, at most 50 messages, deleted when the event ended. It is now
// written to event_chat_messages as it is sent, before anyone receives it, and kept as long as the event
// exists. Reactions sit beside it in event_chat_reactions. This file is applied in production and never
// edited; what the code relies on (who a room message reached, the length the handler cuts a message to,
// the reaction names, the millisecond clock the page cursor reads) is pinned here.

import * as fs from 'fs';
import * as path from 'path';
import { transactionControl } from './transaction-control';
import { CHAT_REACTION_EMOJIS, EVENT_CHAT_MAX_LENGTH } from '../../services/event-chat/event-chat.service';

const FILE = '112_event_chat.sql';
const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations', FILE), 'utf8');

/** The SQL without its comments, so a word in a comment is not read as a statement. */
const code = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
/** One line, single spaces, none just inside a parenthesis: layout is not what is pinned. */
const flat = code.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();

/** The body of one CREATE TABLE statement, up to its closing parenthesis and semicolon. */
function table(name: string): string {
  const m = flat.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\((.*?)\\);`, 'i'));
  expect(m).not.toBeNull();
  return m![1].trim();
}

describe('migration 112 (event chat)', () => {
  it('has no top-level BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK or ABORT (the runner wraps each file)', () => {
    expect(transactionControl(sql)).toEqual([]);
  });

  it('only creates: two tables and their indexes, nothing dropped, altered, deleted or rewritten', () => {
    // A foreign key's ON DELETE clause is part of a CREATE TABLE, not a statement.
    const statements = code.replace(/\bON DELETE (CASCADE|SET NULL)\b/gi, '');
    expect(statements).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT|RENAME|ALTER)\b/i);
    const tables = flat.match(/CREATE TABLE [^(]*/gi) ?? [];
    expect(tables.map((t) => t.trim())).toEqual([
      'CREATE TABLE IF NOT EXISTS event_chat_messages',
      'CREATE TABLE IF NOT EXISTS event_chat_reactions',
    ]);
  });

  describe('event_chat_messages', () => {
    const body = () => table('event_chat_messages');

    it('belongs to its event and goes when the event is deleted for good, never before', () => {
      expect(body()).toMatch(/session_id UUID NOT NULL REFERENCES sessions\(id\) ON DELETE CASCADE/i);
    });

    it('keeps a message whose author is deleted: the id empties and the name sent with it stays', () => {
      expect(body()).toMatch(/sender_id UUID NULL REFERENCES users\(id\) ON DELETE SET NULL/i);
      expect(body()).toMatch(/sender_name TEXT NOT NULL CHECK \(length\(sender_name\) <= 200\)/i);
    });

    it('refuses an empty message and one longer than the handler sends', () => {
      expect(body()).toMatch(new RegExp(
        `content TEXT NOT NULL CHECK \\(length\\(btrim\\(content\\)\\) > 0 AND length\\(content\\) <= ${EVENT_CHAT_MAX_LENGTH}\\)`, 'i'));
    });

    it('is said either to the whole event (lobby) or in a room', () => {
      expect(body()).toMatch(/scope TEXT NOT NULL CHECK \(scope IN \('lobby', 'room'\)\)/i);
    });

    it('a room message always records who it reached; a lobby message records no room and no audience', () => {
      expect(body()).toMatch(/audience_ids UUID\[\] NULL/i);
      expect(body()).toMatch(
        /CONSTRAINT event_chat_room_audience CHECK \(\(scope = 'lobby' AND room_id IS NULL AND audience_ids IS NULL\) OR \(scope = 'room' AND audience_ids IS NOT NULL AND cardinality\(audience_ids\) > 0\)\)/i,
      );
    });

    it('a match or a moderator that is deleted empties the reference and keeps the message', () => {
      expect(body()).toMatch(/match_id UUID NULL REFERENCES matches\(id\) ON DELETE SET NULL/i);
      expect(body()).toMatch(/deleted_by UUID NULL REFERENCES users\(id\) ON DELETE SET NULL/i);
      expect(body()).toMatch(/deleted_at TIMESTAMPTZ NULL/i);
    });

    it('stamps the time to the millisecond, the precision of the page cursor (<epochMs>_<id>)', () => {
      expect(body()).toMatch(/created_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc\('milliseconds', NOW\(\)\)/i);
    });

    it('takes an optional idempotency key, unique per sender in an event', () => {
      expect(body()).toMatch(/client_id UUID NULL/i);
      expect(flat).toMatch(
        /CREATE UNIQUE INDEX IF NOT EXISTS uq_event_chat_client ON event_chat_messages \(session_id, sender_id, client_id\) WHERE client_id IS NOT NULL;/i,
      );
    });

    it('has a new-style primary key', () => {
      expect(body()).toMatch(/^id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\),/i);
    });
  });

  describe('event_chat_reactions', () => {
    const body = () => table('event_chat_reactions');

    it('goes with its message and with its member', () => {
      expect(body()).toMatch(/message_id UUID NOT NULL REFERENCES event_chat_messages\(id\) ON DELETE CASCADE/i);
      expect(body()).toMatch(/user_id UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/i);
    });

    it('takes exactly the reactions the live chat offers, once per member per message', () => {
      const check = body().match(/emoji TEXT NOT NULL CHECK \(emoji IN \(([^)]*)\)\)/i);
      expect(check).not.toBeNull();
      const allowed = [...check![1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
      expect(allowed.sort()).toEqual([...CHAT_REACTION_EMOJIS].sort());
      expect(body()).toMatch(/UNIQUE \(message_id, user_id, emoji\)/i);
    });
  });

  it('indexes the page read, the room audience, and every column a delete elsewhere looks up', () => {
    const indexes = [
      /CREATE INDEX IF NOT EXISTS idx_event_chat_feed ON event_chat_messages \(session_id, created_at DESC, id DESC\) WHERE deleted_at IS NULL;/i,
      /CREATE INDEX IF NOT EXISTS idx_event_chat_audience ON event_chat_messages USING GIN \(audience_ids\) WHERE scope = 'room';/i,
      /CREATE INDEX IF NOT EXISTS idx_event_chat_sender ON event_chat_messages \(sender_id\);/i,
      // A deleted event, match or moderator finds its rows by these (the feed index above skips deleted rows).
      /CREATE INDEX IF NOT EXISTS idx_event_chat_session ON event_chat_messages \(session_id\);/i,
      /CREATE INDEX IF NOT EXISTS idx_event_chat_match ON event_chat_messages \(match_id\) WHERE match_id IS NOT NULL;/i,
      /CREATE INDEX IF NOT EXISTS idx_event_chat_deleted_by ON event_chat_messages \(deleted_by\) WHERE deleted_by IS NOT NULL;/i,
      /CREATE INDEX IF NOT EXISTS idx_event_chat_reactions_message ON event_chat_reactions \(message_id\);/i,
      /CREATE INDEX IF NOT EXISTS idx_event_chat_reactions_user ON event_chat_reactions \(user_id\);/i,
    ];
    for (const index of indexes) expect(flat).toMatch(index);
    const created = flat.match(/CREATE (UNIQUE )?INDEX\b/gi) ?? [];
    expect(created).toHaveLength(indexes.length + 1); // + the client-key unique index pinned above
  });
});
