// The line under "Find people" about the member's searches (Shirley pilot S7, item 21), linking to where they are seen,
// edited, paused and resumed (/agents, the People tab "Your searches"). It reads the member's searches from the cache
// entry the app's layout already fills (['agents', false]: same key, same request, same tags), so it costs no request.
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { E } from '@/realtime/entities';
import { searchesHelp, type SearchSummary } from './searches-help';

export default function SearchesHelp() {
  const me = useAuthStore((s) => s.user?.id);
  const { data } = useQuery({
    queryKey: ['agents', false],
    queryFn: () => api.get('/agents').then((r) => r.data.data as SearchSummary[]),
    enabled: !!me,
    meta: { entities: me ? [E.user(me)] : [] },
  });
  const copy = searchesHelp(data);
  return (
    <p className="mt-2 text-sm text-gray-600 [overflow-wrap:anywhere]" data-testid="search-help">
      {copy.text}{' '}
      <Link to="/agents" className="inline-flex min-h-[44px] items-center font-semibold text-rsn-red underline underline-offset-2">
        {copy.link}
      </Link>
    </p>
  );
}
