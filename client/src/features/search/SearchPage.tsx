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
import { useQuery, useMutation } from '@tanstack/react-query';
import { Search as SearchIcon } from 'lucide-react';
import Card from '@/components/ui/Card';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { useToastStore } from '@/stores/toastStore';
import api from '@/lib/api';

interface Result {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  jobTitle: string | null;
  company: string | null;
  location: string | null;
}

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
  // write per pause, replacing the entry: typing never adds a step to the history.
  useEffect(() => {
    if (term === written.current) return;
    written.current = term;
    setSearchParams(term ? { q: term } : {}, { replace: true });
  }, [term, setSearchParams]);
  const [asked, setAsked] = useState<Set<string>>(new Set());
  const { addToast } = useToastStore();

  // realtime: skip — a search is a point-in-time query typed by the member, not a live view
  const { data: results, isFetching } = useQuery({
    queryKey: ['user-find', term],
    queryFn: () => api.get(`/users/find?q=${encodeURIComponent(term)}`).then((r) => r.data.data as Result[]),
    enabled: term.length >= MIN_QUERY,
    staleTime: 30_000,
  });

  const meet = useMutation({
    mutationFn: (userId: string) => api.post(`/matches/platform/${userId}/interest`),
    onSuccess: (_d, userId) => {
      setAsked((prev) => new Set(prev).add(userId));
      addToast('Meeting request sent', 'success');
    },
    onError: (err: any) => addToast(err?.response?.data?.error?.message || 'Could not send that', 'error'),
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
            <Button
              onClick={() => meet.mutate(r.userId)}
              disabled={asked.has(r.userId) || meet.isPending}
              className="mt-3 min-h-[44px] w-full justify-center"
            >
              {asked.has(r.userId) ? 'Meeting request sent' : 'I want to meet'}
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}
