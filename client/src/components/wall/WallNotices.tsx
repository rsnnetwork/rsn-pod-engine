// The short notices a wall draws where posts would be: someone who is not a member, and a ?post= link whose post could
// not be shown. Split out of Wall.tsx (S4 fix round 1).
//
// A link's post that the server answers 404 for (removed, or never there for this viewer: the two answer alike) says
// "This post was removed." Any other failure (a phone that is offline, a server fault) is not a removal: it says what
// went wrong in words and offers to try again.

import Card from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { LINKED_POST_REMOVED, wallErrorSentence } from './wall-logic';
import type { WallConfig } from './wall-types';

/** What someone who is not a member of the pod or the circle reads where the posts would be. */
export function WallNotMember({ config }: { config: WallConfig }) {
  return (
    <Card className="!p-4" data-testid={`${config.testId}-not-member`}>
      <p className="text-center text-sm text-gray-500">{config.copy.notMember}</p>
    </Card>
  );
}

/** Where a ?post= link's post would be, when it could not be shown: removed (404), or a failure to try again. */
export function LinkedPostNotice({ config, removed, error, onRetry }: {
  config: WallConfig;
  removed: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  if (removed) {
    return (
      <Card className="!p-4" data-testid={`${config.testId}-linked-removed`}>
        <p className="text-center text-sm text-gray-600" role="status">{LINKED_POST_REMOVED}</p>
      </Card>
    );
  }
  return (
    <Card className="!p-4 text-center" data-testid={`${config.testId}-linked-failed`}>
      <p className="text-sm text-gray-600" role="status">{wallErrorSentence(error, 'We could not open that post just now.')}</p>
      <Button variant="ghost" onClick={onRetry} className="mt-2 min-h-[44px]">Try again</Button>
    </Card>
  );
}
