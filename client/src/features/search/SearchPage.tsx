// Platform-wide people search (13 Aug 2026, Task C1).
//
// Claus could not find himself on the platform: the only search there was ran
// over people you had already met. Every active, onboarded member is now
// findable by name, job title or company.
//
// The result card is deliberately thin — name, title, company, location,
// photo — and its only action is the introduction path that already exists.
// Being findable is not the same as being open: bio, contact details and
// messaging keep the gates they had before, on the profile page.

import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Search as SearchIcon } from 'lucide-react';
import Card from '@/components/ui/Card';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { useToastStore } from '@/stores/toastStore';
import { useAuthStore } from '@/stores/authStore';
import { E } from '@/realtime/entities';
import { errorMessage } from '@/features/reason/errors';
import WithdrawRequestButton from '@/features/messages/WithdrawRequestButton';
import api from '@/lib/api';

interface Result {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  jobTitle: string | null;
  company: string | null;
  location: string | null;
  /** Where a meeting request between the two stands (10 Nov 2026), from the server, so it survives a reload. */
  pokeStatus?: 'pending' | 'accepted' | null;
  /** True when the member searching sent it; false when this person did. */
  pokeSentByOwner?: boolean | null;
  /** This person declined a request the member sent them, so asking again is refused (Everyone's rule). */
  declinedByThem?: boolean;
}

/** The searcher's own request to this person, still waiting: "Request sent", with Withdraw beside it. */
const askedByMe = (r: Result) => r.pokeStatus === 'pending' && r.pokeSentByOwner === true;
/**
 * "Request declined", inert, for the member whose request this person declined. A live request either way or a
 * connection outranks an old decline (the Everyone list's and the Human Profile's precedence); the member who did the
 * declining sees no state and can still ask.
 */
const declinedForMe = (r: Result) => r.declinedByThem === true && !r.pokeStatus;

const MIN_QUERY = 2;

/** The typed value, settled: one request per pause, not one per keystroke. */
function useSettled(value: string, ms = 250): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

export default function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlQuery = searchParams.get('q') ?? '';
  const [q, setQ] = useState(urlQuery);
  // The last ?q= this page itself put in the address (or found there when it opened).
  const written = useRef(urlQuery);
  // The top search bar lands here with ?q=; follow it when a new search arrives. The page's own write, below, is not a new
  // search: following that would put back what the member typed a moment ago over what they have typed since.
  useEffect(() => {
    if (urlQuery === written.current) return;
    written.current = urlQuery;
    setQ(urlQuery);
  }, [urlQuery]);
  const term = useSettled(q.trim());
  // The search is in the address, so Back from a profile returns to it, words and results (CON-01, 25 Oct 2026). One
  // write per pause, replacing the entry: typing never adds a step to the history. It runs when the settled term changes
  // and for no other reason (the setter is read through a ref, as its identity changes with every address): a new search
  // from the top bar sets the address first, and the old term, which only settles a moment later, must not be written
  // over it.
  const writeAddress = useRef(setSearchParams);
  writeAddress.current = setSearchParams;
  useEffect(() => {
    if (term === written.current) return;
    written.current = term;
    writeAddress.current(term ? { q: term } : {}, { replace: true });
  }, [term]);
  const { addToast } = useToastStore();
  const qc = useQueryClient();
  const me = useAuthStore((s) => s.user?.id as string | undefined);

  // 10 Nov 2026: each result carries where a meeting request between the two stands, so "Request sent" is the
  // server's word and survives a reload (it used to live only in this page's memory). A request sent, answered or
  // withdrawn anywhere tells both members' user and invites tags, so the results follow without a refresh.
  const { data: results, isFetching } = useQuery({
    queryKey: ['user-find', term],
    queryFn: () => api.get(`/users/find?q=${encodeURIComponent(term)}`).then((r) => r.data.data as Result[]),
    enabled: term.length >= MIN_QUERY,
    staleTime: 30_000,
    meta: { entities: me ? [E.user(me), E.userInvites(me)] : [] },
  });

  const meet = useMutation({
    mutationFn: (userId: string) => api.post(`/matches/platform/${encodeURIComponent(userId)}/interest`),
    onSuccess: () => {
      addToast('Meeting request sent', 'success');
      // Returned, so the button stays busy until the results say "Request sent".
      return qc.invalidateQueries({ queryKey: ['user-find'] });
    },
    onError: (err) => {
      addToast(errorMessage(err, 'Could not send that request. Try again.'), 'error');
      return qc.invalidateQueries({ queryKey: ['user-find'] });
    },
  });

  const active = term.length >= MIN_QUERY;
  const empty = active && !isFetching && (results ?? []).length === 0;

  return (
    <div className="mx-auto w-full max-w-6xl">
      <h1 className="font-display text-2xl font-bold text-[#1a1a2e]">Find people</h1>
      <p className="mt-1 text-sm text-gray-500">Search by name, job title or company.</p>

      <div className="relative mt-4">
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search people..."
          aria-label="Search people"
          autoFocus={!urlQuery}
          autoComplete="off"
          className="min-h-[44px] w-full rounded-lg border-2 border-gray-300 bg-white pl-9 pr-3 text-base text-[#1a1a2e] focus:border-rsn-red focus:outline-none"
        />
      </div>

      {!active && (
        <p className="mt-4 text-sm text-gray-400">Type at least two letters.</p>
      )}

      {empty && (
        <Card className="mt-4 !p-8 text-center text-sm text-gray-500" data-testid="search-empty">
          Nobody on REASON matches “{term}”.
        </Card>
      )}

      <div className="mt-4 grid gap-3 min-[1024px]:grid-cols-2">
        {(results ?? []).map((r) => (
          <Card key={r.userId} className="!p-4" data-testid={`search-result-${r.userId}`}>
            <div className="flex items-start gap-3">
              <Avatar src={r.avatarUrl} name={r.displayName || 'Member'} size="md" className="shrink-0" />
              <div className="min-w-0 flex-1">
                <Link
                  to={`/people/${r.userId}?from=People`}
                  className="block text-sm font-semibold text-[#1a1a2e] [overflow-wrap:anywhere] hover:underline"
                >
                  {r.displayName || 'A member'}
                </Link>
                {(r.jobTitle || r.company) && (
                  <p className="text-xs text-gray-500 [overflow-wrap:anywhere]">
                    {[r.jobTitle, r.company].filter(Boolean).join(' · ')}
                  </p>
                )}
                {r.location && <p className="text-xs text-gray-400 [overflow-wrap:anywhere]">{r.location}</p>}
              </div>
            </div>
            {askedByMe(r) ? (
              <div className="mt-3 grid grid-cols-2 gap-2">
                <span
                  className="flex min-h-[44px] items-center justify-center rounded-xl bg-gray-100 px-2 text-center text-sm font-medium text-gray-600"
                  data-testid={`search-request-sent-${r.userId}`}
                >
                  Request sent
                </span>
                <WithdrawRequestButton userId={r.userId} />
              </div>
            ) : r.pokeStatus === 'accepted' ? (
              <Link
                to={`/messages/new/${r.userId}`}
                className="mt-3 flex min-h-[44px] w-full items-center justify-center rounded-xl border border-gray-300 text-sm font-medium text-[#1a1a2e] hover:bg-gray-50"
              >
                Message
              </Link>
            ) : declinedForMe(r) ? (
              // Inert, as the profile bar draws it: asking again would only be refused.
              <span
                className="mt-3 flex min-h-[44px] w-full items-center justify-center rounded-xl bg-gray-100 px-2 text-center text-sm font-medium text-gray-500"
                data-testid={`search-request-declined-${r.userId}`}
              >
                Request declined
              </span>
            ) : (
              // An incoming request (they asked the member) keeps "I want to meet": pressing it is the match.
              <Button
                onClick={() => meet.mutate(r.userId)}
                disabled={meet.isPending}
                className="mt-3 min-h-[44px] w-full justify-center"
              >
                {meet.isPending && meet.variables === r.userId ? 'Sending…' : 'I want to meet'}
              </Button>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
