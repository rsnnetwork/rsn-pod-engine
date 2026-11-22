// ─── A pod's member list (21 Nov 2026, Stefan: "ux on how we show members, is really bad") ───────────────────────
// Drawn inside the page's #pod-members section, which has the page's full width below the discussion and the events.
// Compact rows, one across on a phone, two from 768px, three from 1280px (grid-cols-1, never an auto track: an auto
// track grows to the longest truncated title and the page scrolls sideways at 360). For the director and hosts the
// status chips; for a list of SEARCH_FROM or more a search over name, title and company; the first 12 and
// "Show all {n}" / "Show fewer". The rows come from the page's members query (its pod and pod-members tags), so a
// change anyone makes shows here without a reload. pod-members-view.ts decides what is shown.
import { useRef, useState } from 'react';
import { Search, Users } from 'lucide-react';
import Card from '@/components/ui/Card';
import PodMemberRow from './PodMemberRow';
import PodMemberStatusChips from './PodMemberStatusChips';
import type { PodMemberMenuItem } from './PodMemberMenu';
import {
  MEMBER_ACTION_LABEL, SEARCH_FROM, SEARCH_PLACEHOLDER, SHOW_FEWER,
  noMatchSentence, podMemberActions, podMembersView, roleFor, showAllLabel,
  type PodMemberCounts, type PodMemberRow as Member, type StatusChipKey,
} from './pod-members-view';

interface Props {
  members: Member[];
  total: number;
  /** The status counts, shown as chips to the pod's director and hosts (canFilter). */
  counts?: PodMemberCounts;
  canFilter: boolean;
  /** The viewer may read the list (a member or an admin); anyone else is asked to join. */
  readable: boolean;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  me: string | undefined;
  /** The pod's director or a platform admin: the rows' "⋯" menus. */
  canManage: boolean;
  onRemove: (m: Member) => void;
  onSetRole: (m: Member, role: 'host' | 'member') => void;
  removing: boolean;
  changingRole: boolean;
}

const QUIET = 'flex min-h-[44px] items-center justify-center rounded-xl border border-gray-200 bg-white px-4 text-sm font-semibold text-[#1a1a2e] hover:bg-gray-50';

function Line({ children, testId }: { children: string; testId?: string }) {
  return <Card><p className="text-gray-400 text-sm text-center py-4" data-testid={testId}>{children}</p></Card>;
}

export default function PodMembersSection(p: Props) {
  const [status, setStatus] = useState<StatusChipKey | null>(null);
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const top = useRef<HTMLDivElement>(null);
  const view = podMembersView({ members: p.members, status, query, showAll });

  const menuFor = (m: Member): PodMemberMenuItem[] => podMemberActions(m, { me: p.me, canManage: p.canManage }).map((action) => (
    action === 'remove'
      ? { key: action, label: MEMBER_ACTION_LABEL[action], danger: true, disabled: p.removing, testId: `pod-remove-${m.userId}`, onSelect: () => p.onRemove(m) }
      : { key: action, label: MEMBER_ACTION_LABEL[action], disabled: p.changingRole, testId: `pod-role-${m.userId}`, onSelect: () => p.onSetRole(m, roleFor(action)) }
  ));

  const showFewer = () => {
    setShowAll(false);
    if ((top.current?.getBoundingClientRect().top ?? 0) < 0) top.current?.scrollIntoView({ block: 'start' });
  };

  const body = () => {
    // The skeleton only while there is nothing to show: the pod's own read may already carry its members.
    if (p.loading && p.readable && p.members.length === 0) {
      return (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3" aria-busy="true" aria-label="Loading members">
          {Array.from({ length: 6 }, (_, i) => <div key={i} className="h-[58px] animate-pulse rounded-xl bg-gray-100" />)}
        </div>
      );
    }
    if (p.failed && p.readable && p.members.length === 0) {
      return (
        <Card>
          <div className="flex flex-col items-center gap-3 py-3 text-center">
            <p className="text-sm text-gray-500">We could not load the members just now.</p>
            <button type="button" onClick={p.onRetry} className={QUIET}>Try again</button>
          </div>
        </Card>
      );
    }
    if (status === null && view.listed === 0) return <Line>{p.readable ? 'No members yet' : 'To access pod details, please join the pod.'}</Line>;
    if (view.listed === 0) return <Line>Nobody in this list just now.</Line>;
    if (view.matched === 0) return <Line testId="pod-members-no-match">{noMatchSentence(query)}</Line>;
    return (
      <>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
          {view.rows.map((m) => <PodMemberRow key={m.userId || m.id} m={m} menu={menuFor(m)} />)}
        </div>
        {(view.hidden > 0 || view.canShowFewer) && (
          <div className="flex justify-center">
            {view.hidden > 0
              ? <button type="button" onClick={() => setShowAll(true)} className={QUIET} data-testid="pod-members-show-all">{showAllLabel(view.matched)}</button>
              : <button type="button" onClick={showFewer} className={QUIET} data-testid="pod-members-show-fewer">{SHOW_FEWER}</button>}
          </div>
        )}
      </>
    );
  };

  return (
    <div ref={top} className="space-y-3">
      <h2 className="text-lg font-semibold text-[#1a1a2e] flex items-center gap-2">
        <Users className="h-5 w-5 text-rsn-red" /> Members ({p.total})
      </h2>
      {((p.canFilter && p.counts) || view.listed >= SEARCH_FROM || view.searching) && (
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          {p.canFilter && p.counts && (
            <PodMemberStatusChips counts={p.counts} total={p.total} value={status} onChange={(key) => { setStatus(key); setShowAll(false); }} />
          )}
          {(view.listed >= SEARCH_FROM || view.searching) && (
            <label className="relative block w-full md:max-w-xs">
              <span className="sr-only">Search members</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={SEARCH_PLACEHOLDER}
                data-testid="pod-members-search"
                className="min-h-[44px] w-full rounded-xl border border-gray-200 bg-white pl-9 pr-3 text-base text-[#1a1a2e] placeholder:text-gray-500 focus:border-rsn-red focus:outline-none focus:ring-2 focus:ring-rsn-red/20 md:text-sm"
              />
            </label>
          )}
        </div>
      )}
      {body()}
    </div>
  );
}
