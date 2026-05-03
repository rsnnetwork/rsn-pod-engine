// Phase E — DM message reactions (3 May 2026)
//
// Pins the architecture for emoji reactions on direct messages:
//   1. Migration 056 creates dm_message_reactions(message_id, user_id, emoji)
//      with FK cascades on both sides + index on message_id.
//   2. dm.service.ts exports addReaction + removeReaction with an emoji
//      allow-list (heart, clap, thumbs_up, laugh, fire, wow). Both authorize
//      via conversation participation and are idempotent.
//   3. listMessages returns each message with a reactions field shaped as
//      { [emoji_type]: string[] /* userIds */ }.
//   4. routes/dm.ts wires POST  /dm/messages/:id/reactions
//                       DELETE /dm/messages/:id/reactions/:emoji
//      both behind authenticate.
//   5. dm-handlers.ts exports handleDmReact + handleDmUnreact and emits
//      dm:reaction_added / dm:reaction_removed to BOTH conversation users.
//   6. orchestration.service.ts wires socket.on(dm:react) and (dm:unreact).
//
// Style is grep-on-source so the suite stays fast and free of DB I/O,
// matching phaseC-dm-service.test.ts and phaseD-dm-realtime.test.ts.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
}

describe('Phase E — DM message reactions', () => {
  describe('migration 056 dm_message_reactions', () => {
    const sql = readServer('db/migrations/056_dm_message_reactions.sql');

    it('creates dm_message_reactions table', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS dm_message_reactions/);
    });

    it('PRIMARY KEY is the (message_id, user_id, emoji) triple', () => {
      expect(sql).toMatch(/PRIMARY KEY\s*\(\s*message_id\s*,\s*user_id\s*,\s*emoji\s*\)/);
    });

    it('FKs cascade on message and user delete', () => {
      expect(sql).toMatch(/message_id\s+UUID NOT NULL REFERENCES direct_messages\(id\) ON DELETE CASCADE/);
      expect(sql).toMatch(/user_id\s+UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
    });

    it('emoji column is short (VARCHAR 16) and NOT NULL', () => {
      expect(sql).toMatch(/emoji\s+VARCHAR\(16\)\s+NOT NULL/);
    });

    it('indexes message_id for thread-wide reaction loads', () => {
      expect(sql).toMatch(/idx_dm_reactions_message[\s\S]+?dm_message_reactions\(message_id\)/);
    });
  });

  describe('dm.service.ts reactions surface', () => {
    const src = readServer('services/dm/dm.service.ts');

    it('exports addReaction and removeReaction', () => {
      expect(src).toMatch(/export async function addReaction\(/);
      expect(src).toMatch(/export async function removeReaction\(/);
    });

    it('declares an emoji allow-list including heart, clap, thumbs_up, laugh, fire, wow', () => {
      expect(src).toMatch(/REACTION_EMOJI_ALLOWLIST/);
      ['heart', 'clap', 'thumbs_up', 'laugh', 'fire', 'wow'].forEach(t => {
        expect(src).toMatch(new RegExp(`['"]${t}['"]`));
      });
    });

    it('addReaction rejects emoji outside the allow-list with VALIDATION_ERROR', () => {
      const fnStart = src.indexOf('export async function addReaction(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/VALIDATION_ERROR/);
      expect(fn).toMatch(/REACTION_EMOJI_ALLOWLIST/);
    });

    it('addReaction authorizes via conversation participation', () => {
      // The participation check is delegated to a loadMessageContext helper in
      // the same file. addReaction itself rejects with AUTH_FORBIDDEN when the
      // caller is not user_a_id or user_b_id of the conversation.
      const fnStart = src.indexOf('export async function addReaction(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/AUTH_FORBIDDEN/);
      expect(fn).toMatch(/userAId|userBId|user_a_id|user_b_id/);
      // Helper exists and queries the conversation pair.
      expect(src).toMatch(/loadMessageContext/);
      expect(src).toMatch(/c\.user_a_id,\s*c\.user_b_id/);
    });

    it('addReaction is idempotent via ON CONFLICT DO NOTHING', () => {
      const fnStart = src.indexOf('export async function addReaction(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/ON CONFLICT[\s\S]*?DO NOTHING/);
    });

    it('listMessages returns reactions aggregated per message', () => {
      const fnStart = src.indexOf('export async function listMessages(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      // The implementation joins/aggregates dm_message_reactions and exposes
      // the data on each row as `reactions`.
      expect(fn).toMatch(/dm_message_reactions/);
      expect(fn).toMatch(/reactions:/);
    });
  });

  describe('routes/dm.ts reaction endpoints', () => {
    const src = readServer('routes/dm.ts');

    it('registers POST /messages/:id/reactions behind authenticate', () => {
      expect(src).toMatch(/router\.post\(\s*['"]\/messages\/:id\/reactions['"][\s\S]+?authenticate/);
    });

    it('registers DELETE /messages/:id/reactions/:emoji behind authenticate', () => {
      expect(src).toMatch(/router\.delete\(\s*['"]\/messages\/:id\/reactions\/:emoji['"][\s\S]+?authenticate/);
    });

    it('validates the emoji body on POST', () => {
      expect(src).toMatch(/reactionBodySchema/);
    });
  });

  describe('dm-handlers.ts reaction socket handlers', () => {
    const src = readServer('services/orchestration/handlers/dm-handlers.ts');

    it('exports handleDmReact and handleDmUnreact', () => {
      expect(src).toMatch(/export async function handleDmReact\(/);
      expect(src).toMatch(/export async function handleDmUnreact\(/);
    });

    it('handleDmReact emits dm:reaction_added to BOTH conversation users', () => {
      const fnStart = src.indexOf('export async function handleDmReact(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      const emits = (fn.match(/io\.to\(userRoom\([^)]+\)\)\.emit\(['"]dm:reaction_added['"]/g) || []).length;
      expect(emits).toBeGreaterThanOrEqual(2);
    });

    it('handleDmUnreact emits dm:reaction_removed to BOTH conversation users', () => {
      const fnStart = src.indexOf('export async function handleDmUnreact(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      const emits = (fn.match(/io\.to\(userRoom\([^)]+\)\)\.emit\(['"]dm:reaction_removed['"]/g) || []).length;
      expect(emits).toBeGreaterThanOrEqual(2);
    });
  });

  describe('orchestration.service.ts wires reaction events', () => {
    const src = readServer('services/orchestration/orchestration.service.ts');

    it('imports handleDmReact and handleDmUnreact', () => {
      expect(src).toMatch(/handleDmReact[\s\S]*?handleDmUnreact|handleDmUnreact[\s\S]*?handleDmReact/);
    });

    it('registers socket.on(dm:react) and (dm:unreact)', () => {
      expect(src).toMatch(/socket\.on\(['"]dm:react['"]/);
      expect(src).toMatch(/socket\.on\(['"]dm:unreact['"]/);
    });
  });
});
