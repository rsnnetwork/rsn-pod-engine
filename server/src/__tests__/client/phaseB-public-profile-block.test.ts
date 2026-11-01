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
