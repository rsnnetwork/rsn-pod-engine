// The one query cache the whole app reads server data through, and the rule that it belongs to ONE signed-in
// member at a time.
//
// It used to be built in main.tsx, kept every query for five minutes (the library's default) and was never
// emptied. The next member to sign in within those minutes opened pages that already held the last member's
// data: For You showed their private "you are looking for" on every card, and because that data was still
// inside its five seconds of freshness, the new member's own request was not even sent. Every page that reads
// server data shares the pattern, so the cache is emptied here, once, whenever the member changes.
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: true } },
});

// Whose data the cache holds. null: nobody is signed in, or it was just emptied.
let cacheOwner: string | null = null;

/**
 * A member's session has loaded. The same member (a token refresh, a session re-check) changes nothing. A
 * different one empties the cache first, so no page can read what the last member left. Requests still on
 * their way for the last member are cancelled with it, so a late answer cannot land in the new cache.
 */
export function setCacheOwner(memberId: string): void {
  if (cacheOwner !== null && cacheOwner !== memberId) queryClient.clear();
  cacheOwner = memberId;
}

/** Nobody is signed in any more: signed out, blocked, expired, or signed out in another tab. */
export function clearCache(): void {
  queryClient.clear();
  cacheOwner = null;
}
