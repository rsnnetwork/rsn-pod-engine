// Phase C — DM data model + service + REST (1 May 2026)
//
// Pins the architecture: 1:1 DMs persist in Postgres, gated by encounter
// history + user blocks. Source of truth for the bell badge unread count
// and the Messages page.
//
// Tests are source-code-grep style for the architectural invariants. The
// service has plenty of integration coverage via the existing pg-mock
// pattern in other service tests; these focus on the contract.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readServer(rel: string): string {
  // Normalise line endings. These tests slice a function body by looking for
  // the first "\n}\n" after its signature, which never matches in a CRLF
  // working tree: the slice then ran to the end of the file and every pin
  // below silently passed against unrelated code. It only failed in CI, where
  // the checkout is LF. Read them the same way everywhere (21 Sep 2026).
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8').replace(/\r\n/g, '\n');
}

/** The text of one function, from its signature to its closing brace. */
function fnBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start === -1) throw new Error(`function not found in source: ${signature}`);
  const end = src.indexOf('\n}\n', start);
  if (end === -1) throw new Error(`no closing brace found for: ${signature}`);
  return src.slice(start, end);
}

describe('Phase C — DM data model + service + REST', () => {
  describe('migration 044 dm_conversations', () => {
    const sql = readServer('db/migrations/044_dm_conversations.sql');

    it('creates dm_conversations table', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS dm_conversations/);
    });

    it('normalises pair via CHECK(user_a_id < user_b_id)', () => {
      expect(sql).toMatch(/CHECK\(user_a_id < user_b_id\)/);
    });

    it('UNIQUE on the pair so we get one conversation per user-pair', () => {
      expect(sql).toMatch(/UNIQUE\(user_a_id, user_b_id\)/);
    });

    it('per-user soft delete columns', () => {
      expect(sql).toMatch(/user_a_deleted_at\s+TIMESTAMPTZ/);
      expect(sql).toMatch(/user_b_deleted_at\s+TIMESTAMPTZ/);
    });

    it('indexes both sides for inbox queries', () => {
      expect(sql).toMatch(/idx_dm_conv_user_a/);
      expect(sql).toMatch(/idx_dm_conv_user_b/);
    });

    it('FKs cascade on user delete', () => {
      expect(sql).toMatch(/user_a_id\s+UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
      expect(sql).toMatch(/user_b_id\s+UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
    });
  });

  describe('migration 045 direct_messages', () => {
    const sql = readServer('db/migrations/045_direct_messages.sql');

    it('creates direct_messages table', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS direct_messages/);
    });

    it('FK to dm_conversations cascades on conversation delete', () => {
      expect(sql).toMatch(/conversation_id UUID NOT NULL REFERENCES dm_conversations\(id\) ON DELETE CASCADE/);
    });

    it('content has length CHECK 1 to 4000', () => {
      expect(sql).toMatch(/length\(trim\(content\)\) > 0/);
      expect(sql).toMatch(/length\(content\) <= 4000/);
    });

    it('thread index on (conversation_id, created_at DESC)', () => {
      expect(sql).toMatch(/idx_dm_messages_conv[\s\S]+?direct_messages\(conversation_id, created_at DESC\)/);
    });

    it('partial unread index for badge query speed', () => {
      expect(sql).toMatch(/idx_dm_messages_unread[\s\S]+?WHERE read_at IS NULL/);
    });
  });

  describe('migration 046 notifications type extended with direct_message', () => {
    const sql = readServer('db/migrations/046_notifications_dm_type.sql');

    it('drops the old type CHECK constraint', () => {
      expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS notifications_type_check/);
    });

    it('adds new constraint allowing direct_message and preserving prior types', () => {
      expect(sql).toMatch(/'direct_message'/);
      expect(sql).toMatch(/'event_invite'/);
      expect(sql).toMatch(/'pod_invite'/);
      expect(sql).toMatch(/'join_request'/);
      expect(sql).toMatch(/'approval'/);
    });
  });

  describe('dm.service.ts surface', () => {
    const src = readServer('services/dm/dm.service.ts');

    it('exports canMessage, sendMessage, listConversations, listMessages, markRead, deleteConversation, getUnreadCount', () => {
      expect(src).toMatch(/export async function canMessage\(/);
      expect(src).toMatch(/export async function sendMessage\(/);
      expect(src).toMatch(/export async function listConversations\(/);
      expect(src).toMatch(/export async function listMessages\(/);
      expect(src).toMatch(/export async function markRead\(/);
      expect(src).toMatch(/export async function deleteConversation\(/);
      expect(src).toMatch(/export async function getUnreadCount\(/);
    });

    it('canMessage checks block FIRST then encounter', () => {
      const fn = fnBody(src, 'export async function canMessage(');
      const blockIdx = fn.indexOf('blockService.areBlocked');
      const encounterIdx = fn.indexOf('encounter_history');
      expect(blockIdx).toBeGreaterThan(-1);
      expect(encounterIdx).toBeGreaterThan(-1);
      expect(blockIdx).toBeLessThan(encounterIdx);
    });

    it('canMessage rejects self-DM with reason="self"', () => {
      const fn = fnBody(src, 'export async function canMessage(');
      expect(fn).toMatch(/reason:\s*['"]self['"]/);
    });

    it('canMessage rejects with reason="blocked" or "no_encounter"', () => {
      const fn = fnBody(src, 'export async function canMessage(');
      expect(fn).toMatch(/reason:\s*['"]blocked['"]/);
      expect(fn).toMatch(/reason:\s*['"]no_encounter['"]/);
    });

    it('sendMessage re-checks canMessage server-side (UI guard not trusted)', () => {
      const fn = fnBody(src, 'export async function sendMessage(');
      expect(fn).toMatch(/canMessage\(/);
    });

    // 21 Sep 2026: the SQL moved into insertDirectMessageOn, which takes the
    // caller's client so confirming a meeting can write the conversation row
    // and its chat card in ONE transaction. insertDirectMessage is now the
    // wrapper that opens a transaction around it. There is still exactly one
    // INSERT into direct_messages in the codebase, which is what these pin.
    it('the canonical insert uses ON CONFLICT to upsert the conversation row', () => {
      const fn = fnBody(src, 'export async function insertDirectMessageOn(');
      expect(fn).toMatch(/ON CONFLICT \(user_a_id, user_b_id\) DO UPDATE/);
    });

    it('there is exactly ONE INSERT into direct_messages in the service', () => {
      expect(src.match(/INSERT INTO direct_messages/g) || []).toHaveLength(1);
    });

    it('the canonical insert clears BOTH sides soft-delete so a new message re-shows the thread for whoever deleted it', () => {
      // 7 Sep 2026 (Stefan's test): this cleared only the SENDER's column, so
      // a recipient who had trashed the thread never saw new messages resurface
      // it — the message was stored but silently invisible. A new message must
      // un-hide the conversation for BOTH participants, mirroring acceptPoke's
      // both-sides clear on the same table.
      const fn = fnBody(src, 'export async function insertDirectMessageOn(');
      expect(fn).toMatch(/user_a_deleted_at\s*=\s*NULL/);
      expect(fn).toMatch(/user_b_deleted_at\s*=\s*NULL/);
    });

    it('insertDirectMessage runs in a transaction (conversation upsert + message insert atomic)', () => {
      const fn = fnBody(src, 'async function insertDirectMessage(');
      expect(fn).toMatch(/return transaction\(/);
    });

    it('listConversations filters out user-side soft-deleted rows', () => {
      const fn = fnBody(src, 'export async function listConversations(');
      expect(fn).toMatch(/user_a_deleted_at IS NULL/);
      expect(fn).toMatch(/user_b_deleted_at IS NULL/);
    });

    it('listConversations returns unreadCount per conversation (LATERAL subquery)', () => {
      const fn = fnBody(src, 'export async function listConversations(');
      expect(fn).toMatch(/LATERAL/);
      expect(fn).toMatch(/from_user_id != \$1[\s\S]+?read_at IS NULL/);
    });

    it('markRead only marks messages from the OTHER user (never self-marks)', () => {
      const fn = fnBody(src, 'export async function markRead(');
      expect(fn).toMatch(/from_user_id != \$2/);
    });

    it('deleteConversation is per-user soft-delete (sets user_x_deleted_at)', () => {
      const fn = fnBody(src, 'export async function deleteConversation(');
      expect(fn).toMatch(/user_a_deleted_at|user_b_deleted_at/);
      // It must NOT actually delete rows from dm_conversations
      expect(fn).not.toMatch(/DELETE FROM dm_conversations/);
    });
  });

  describe('routes/dm.ts surface', () => {
    const src = readServer('routes/dm.ts');

    it('GET /conversations route exists with auth', () => {
      expect(src).toMatch(/router\.get\(\s*['"]\/conversations['"][\s\S]+?authenticate/);
    });

    it('GET /conversations/:id/messages route exists with auth', () => {
      expect(src).toMatch(/router\.get\(\s*['"]\/conversations\/:id\/messages['"][\s\S]+?authenticate/);
    });

    it('POST /messages route exists with auth + body validation', () => {
      expect(src).toMatch(/router\.post\(\s*['"]\/messages['"][\s\S]+?authenticate[\s\S]+?validate\(sendBodySchema\)/);
    });

    it('POST /conversations/:id/read route exists with auth', () => {
      expect(src).toMatch(/router\.post\(\s*['"]\/conversations\/:id\/read['"][\s\S]+?authenticate/);
    });

    it('DELETE /conversations/:id route exists with auth', () => {
      expect(src).toMatch(/router\.delete\(\s*['"]\/conversations\/:id['"][\s\S]+?authenticate/);
    });

    it('GET /can-message/:userId route exists for the profile UI gate', () => {
      expect(src).toMatch(/router\.get\(\s*['"]\/can-message\/:userId['"][\s\S]+?authenticate/);
    });

    it('GET /unread-count route exists for the bell badge', () => {
      expect(src).toMatch(/router\.get\(\s*['"]\/unread-count['"][\s\S]+?authenticate/);
    });

    it('content body validation caps length at 4000 chars', () => {
      // Feature 19 (13 May) — content is optional now (an attachment-only
      // message is valid). Length cap still pinned; the "at least one of
      // content or attachment" rule is enforced via refine().
      expect(src).toMatch(/content:\s*z\.string\(\)\.max\(4000\)/);
      expect(src).toMatch(/\.refine\([\s\S]{0,200}content[\s\S]{0,200}attachment/);
    });
  });

  describe('Express app mounts /api/dm', () => {
    const src = readServer('index.ts');
    it('imports dmRoutes', () => {
      expect(src).toMatch(/import dmRoutes from ['"]\.\/routes\/dm['"]/);
    });
    it('mounts /api/dm', () => {
      expect(src).toMatch(/app\.use\(\s*['"]\/api\/dm['"][^,]*,\s*dmRoutes\)/);
    });
  });
});
