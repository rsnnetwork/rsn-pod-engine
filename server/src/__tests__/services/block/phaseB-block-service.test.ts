// Phase B — User block infrastructure (1 May 2026)
//
// Pins the architecture:
//   1. user_blocks migration (043) creates the table with the right shape.
//   2. blockService exports block, unblock, areBlocked (symmetric),
//      getBlockedPairsForUsers (bulk for matching), listBlocked, hasBlocked.
//   3. block self is rejected, idempotent block updates reason.
//   4. unblock is idempotent (no-op on missing row).
//   5. areBlocked checks BOTH directions (single roundtrip).
//   6. getBlockedPairsForUsers returns "blockerId:blockedId" tokens for
//      use as HardConstraint params — same format as inviter_invitee_block.
//   7. Matching engine handles the new 'user_block' constraint type with
//      direction-agnostic exclusion (pairKey normalises).
//   8. matching.service queries blocks via blockService.getBlockedPairsForUsers
//      and adds them to hardConstraints alongside inviter-invitee blocks.
//   9. routes/users.ts exposes POST/DELETE /:id/block, GET /:id/block-status,
//      GET /blocked.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

function readShared(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../../../shared/src', rel), 'utf8');
}
function readServer(rel: string): string {
  return nodeFs.readFileSync(nodePath.join(__dirname, '../../../', rel), 'utf8');
}

describe('Phase B — user block infrastructure', () => {
  describe('migration 043 creates the user_blocks table with required shape', () => {
    const sql = readServer('db/migrations/043_user_blocks.sql');

    it('creates user_blocks table', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS user_blocks/);
    });

    it('has blocker_id and blocked_id FKs to users with ON DELETE CASCADE', () => {
      expect(sql).toMatch(/blocker_id\s+UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
      expect(sql).toMatch(/blocked_id\s+UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
    });

    it('enforces no duplicate blocks (UNIQUE blocker, blocked)', () => {
      expect(sql).toMatch(/UNIQUE\(blocker_id, blocked_id\)/);
    });

    it('enforces self-block rejection at the schema level', () => {
      expect(sql).toMatch(/CHECK\(blocker_id != blocked_id\)/);
    });

    it('indexes both blocker_id and blocked_id for fast bidirectional lookups', () => {
      expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker/);
      expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked/);
    });

    it('includes optional reason column for block context', () => {
      expect(sql).toMatch(/reason\s+TEXT/);
    });
  });

  describe('shared HardConstraint type adds user_block', () => {
    const src = readShared('types/match.ts');
    it('HardConstraint.type union includes user_block', () => {
      expect(src).toMatch(/user_block/);
    });
  });

  describe('block.service.ts exports the right surface', () => {
    const src = readServer('services/block/block.service.ts');

    it('exports block, unblock, areBlocked, getBlockedPairsForUsers, listBlocked, hasBlocked', () => {
      expect(src).toMatch(/export async function block\(/);
      expect(src).toMatch(/export async function unblock\(/);
      expect(src).toMatch(/export async function areBlocked\(/);
      expect(src).toMatch(/export async function getBlockedPairsForUsers\(/);
      expect(src).toMatch(/export async function listBlocked\(/);
      expect(src).toMatch(/export async function hasBlocked\(/);
    });

    it('block rejects self-block', () => {
      const fnStart = src.indexOf('export async function block(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/blockerId\s*===\s*blockedId/);
      // Validation error with explanatory message
      expect(fn).toMatch(/VALIDATION_ERROR/);
      expect(fn).toMatch(/cannot block yourself/);
    });

    it('block uses ON CONFLICT DO UPDATE for idempotent re-blocks', () => {
      const fnStart = src.indexOf('export async function block(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      expect(fn).toMatch(/ON CONFLICT \(blocker_id, blocked_id\) DO UPDATE/);
    });

    it('areBlocked checks BOTH directions in a single query', () => {
      const fnStart = src.indexOf('export async function areBlocked(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      // OR clause covering both directions: A blocks B OR B blocks A
      expect(fn).toMatch(/blocker_id = \$1 AND blocked_id = \$2/);
      expect(fn).toMatch(/blocker_id = \$2 AND blocked_id = \$1/);
    });

    it('getBlockedPairsForUsers returns blockerId:blockedId tokens for HardConstraint', () => {
      const fnStart = src.indexOf('export async function getBlockedPairsForUsers(');
      const fnEnd = src.indexOf('\n}\n', fnStart);
      const fn = src.slice(fnStart, fnEnd);
      // Returns the canonical "id:id" token format used by inviter_invitee_block
      expect(fn).toMatch(/`\$\{r\.blocker_id\}:\$\{r\.blocked_id\}`/);
    });
  });

  describe('matching engine recognises user_block constraint', () => {
    const src = readServer('services/matching/matching.engine.ts');

    it('buildHardExclusions has a case for user_block', () => {
      expect(src).toMatch(/case ['"]user_block['"]:/);
    });

    it('user_block exclusion uses pairKey for direction-agnostic normalisation', () => {
      // pairKey sorts the two ids so blocker:blocked and blocked:blocker
      // produce the same exclusion key.
      const caseStart = src.indexOf("case 'user_block'");
      const caseEnd = src.indexOf('break;', caseStart);
      const block = src.slice(caseStart, caseEnd);
      expect(block).toMatch(/exclusions\.add\(pairKey\(/);
    });
  });

  describe('matching.service queries blocks and adds them to hardConstraints', () => {
    const src = readServer('services/matching/matching.service.ts');

    it('imports the block service', () => {
      expect(src).toMatch(/from\s+['"]\.\.\/block\/block\.service['"]/);
    });

    it('calls blockService.getBlockedPairsForUsers in generateSingleRound', () => {
      expect(src).toMatch(/blockService\.getBlockedPairsForUsers\(/);
    });

    it('pushes a user_block constraint when there are any blocked pairs', () => {
      expect(src).toMatch(/type:\s*['"]user_block['"]/);
    });
  });

  describe('routes/users.ts exposes the block REST surface', () => {
    const src = readServer('routes/users.ts');

    it('GET /blocked is registered with auth (no /:id route in users.ts to shadow it)', () => {
      const blockedIdx = src.indexOf("'/blocked'");
      expect(blockedIdx).toBeGreaterThan(-1);
      // users.ts does not have a literal /:id GET route — all per-user routes
      // are scoped (/:id/block, /:id/block-status, etc.) so no shadowing risk.
      // We assert the route exists with authenticate middleware.
      const block = src.slice(blockedIdx, blockedIdx + 200);
      expect(block).toMatch(/authenticate/);
    });

    it('POST /:id/block is registered with auth', () => {
      expect(src).toMatch(/router\.post\(\s*['"]\/:id\/block['"][\s\S]+?authenticate/);
    });

    it('DELETE /:id/block is registered with auth', () => {
      expect(src).toMatch(/router\.delete\(\s*['"]\/:id\/block['"][\s\S]+?authenticate/);
    });

    it('GET /:id/block-status is registered for profile UI', () => {
      expect(src).toMatch(/router\.get\(\s*['"]\/:id\/block-status['"][\s\S]+?authenticate/);
    });
  });

  describe('client public profile renders Block / Unblock button', () => {
    const src = nodeFs.readFileSync(
      nodePath.join(__dirname, '../../../../../client/src/features/profile/PublicProfilePage.tsx'),
      'utf8',
    );

    it('fetches block-status for non-own profiles', () => {
      expect(src).toMatch(/block-status/);
      expect(src).toMatch(/!isOwnProfile/);
    });

    it('renders a Block button when not blocked', () => {
      expect(src).toMatch(/blockMutation\.mutate/);
      // The Block label is rendered as text content next to the icon.
      expect(src).toMatch(/<Ban[\s\S]+?\/>\s*Block/);
    });

    it('renders an Unblock button when blocked', () => {
      expect(src).toMatch(/unblockMutation\.mutate/);
      expect(src).toMatch(/<ShieldOff[\s\S]+?\/>\s*Unblock/);
    });

    it('block button shows confirm dialog with user-friendly explanation', () => {
      expect(src).toMatch(/confirm\(/);
      expect(src).toMatch(/won't be matched together/);
    });
  });
});
