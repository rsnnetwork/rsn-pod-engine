// ─── Phase B (1 May 2026): the public profile's Block / Unblock button ───────────────────────────────────────────
//
// Moved from server/src/__tests__/services/block/phaseB-block-service.test.ts (T2 fix round 1, 1 Nov 2026): a pin on
// the client's source belongs with the client pins, so the services test is the same on every branch and only this
// file follows the client it reads.

import * as nodeFs from 'fs';
import * as nodePath from 'path';

describe('client public profile renders Block / Unblock button', () => {
  const src = nodeFs.readFileSync(
    nodePath.join(__dirname, '../../../../client/src/features/profile/PublicProfilePage.tsx'),
    'utf8',
  );

  it('fetches block-status for non-own profiles', () => {
    expect(src).toMatch(/block-status/);
    expect(src).toMatch(/!isOwnProfile/);
  });

  it('renders a Block button when not blocked', () => {
    expect(src).toMatch(/blockMutation\.mutate/);
    // The Block label is rendered as text content next to the icon.
    // 11 Nov 2026 (item 16): "Block member", from the one place the safety words live.
    expect(src).toMatch(/<Ban[\s\S]+?\/>\s*\{BLOCK_MEMBER\}/);
  });

  it('renders an Unblock button when blocked', () => {
    expect(src).toMatch(/unblockMutation\.mutate/);
    expect(src).toMatch(/<ShieldOff[\s\S]+?\/>\s*Unblock/);
  });

  it('block button shows confirm dialog with user-friendly explanation', () => {
    // T2 (1 Nov 2026): the question is a ConfirmDialog in the page (useConfirm), never window.confirm.
    // 11 Nov 2026 (item 16): every consequence said before it is done (safety-words.ts blockConsequence).
    expect(src).toMatch(/await ask\(\{ title: blockTitle\(user\.displayName\), body: blockConsequence\(user\.displayName\)/);
    expect(src).not.toMatch(/(^|[^\w.])confirm\(/m);
    expect(nodeFs.readFileSync(nodePath.join(__dirname, '../../../../client/src/components/safety/safety-words.ts'), 'utf8')).toMatch(/won't be matched together/);
  });
});
