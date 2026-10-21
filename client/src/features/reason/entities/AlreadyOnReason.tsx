// client/src/features/reason/entities/AlreadyOnReason.tsx
// While a member types a new entity's name, the entities already on REASON whose names contain it. Only an exact name
// is refused by the server (409); this catches the near misses (a typo, "Acme" for "Acme Ltd") before a second copy
// of the same company is made. It is the list page's own search, so the two share one cache entry per term.
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/authStore';
import { E } from '@/realtime/entities';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { shouldRetry } from '../human/profile-text';
import EntityMark from './EntityMark';
import { entityKeys, fetchEntities } from './entity-api';
import { entityMeta, roleLabel, searchTerm } from './entity-text';

const SHOWN = 3;

export default function AlreadyOnReason({ typedName, onLeave }: { typedName: string; onLeave: () => void }) {
  const me = useAuthStore((s) => s.user?.id as string | undefined);
  const term = searchTerm(useDebouncedValue(typedName, 300));
  const { data } = useQuery({
    queryKey: entityKeys.list(term),
    queryFn: () => fetchEntities(term),
    enabled: !!me && term !== '',
    retry: shouldRetry,
    placeholderData: keepPreviousData,
    meta: { entities: me ? [E.userEntities(me)] : [] },
  });
  if (!term || !data) return null;
  // The server does not narrow your own entities by the search, so they are narrowed here.
  const needle = term.toLowerCase();
  const matches = [...data.mine.filter((e) => e.name.toLowerCase().includes(needle)), ...data.others].slice(0, SHOWN);
  if (matches.length === 0) return null;

  return (
    <div className="rounded-[14px] bg-reason-soft p-3">
      <p className="text-[12px] font-bold">Already on REASON. Is it one of these?</p>
      <ul className="mt-1.5 grid gap-1">
        {matches.map((e) => (
          <li key={e.id}>
            <Link
              to={`/entities/${e.id}`}
              onClick={onLeave}
              className="grid min-h-[44px] grid-cols-[38px_minmax(0,1fr)] items-center gap-2.5 rounded-[11px] px-1 py-1 hover:bg-white"
            >
              <EntityMark name={e.name} size="row" />
              <span className="min-w-0 [overflow-wrap:anywhere]">
                <b className="block text-[13px]">{e.name}</b>
                <span className="block text-[11px] text-[#646a77]">{e.myRole ? `${entityMeta(e)} · You: ${roleLabel(e.myRole)}` : entityMeta(e)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
