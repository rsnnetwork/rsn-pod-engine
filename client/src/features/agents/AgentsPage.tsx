// Matching Agents — the dashboard (Wave 2 core, 3 Aug 2026).
//
// Plan: docs/superpowers/plans/2026-08-03-wave2-matching-agents.md
//
// Replaces the flat list of people with the reasons you are looking. A member
// holds several agents at once ("Developer: 3 matches", "Investor: 0"), each one
// a standing search the network keeps running as people join.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Pause, Play, Archive, Search, ChevronRight } from 'lucide-react';
import Card from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/Spinner';
import { useToastStore } from '@/stores/toastStore';
import { useAuthStore } from '@/stores/authStore';
import { E } from '@/realtime/entities';
import api from '@/lib/api';

export interface Agent {
  id: string;
  label: string;
  wantText: string;
  status: 'active' | 'paused' | 'archived';
  matchCount: number;
  lastMatchedAt: string | null;
}

export default function AgentsPage() {
  const qc = useQueryClient();
  const addToast = useToastStore(s => s.addToast);
  const myUserId = useAuthStore(s => s.user?.id);
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState('');
  const [wantText, setWantText] = useState('');

  const [showArchived, setShowArchived] = useState(false);

  const { data: agents, isLoading } = useQuery({
    queryKey: ['agents', showArchived],
    queryFn: () => api.get(showArchived ? '/agents?includeArchived=1' : '/agents').then(r => r.data.data as Agent[]),
    refetchOnWindowFocus: true,
    // Scoring runs in the background after any change, so the count arrives a
    // moment after the agent does.
    refetchInterval: 15_000,
    meta: { entities: myUserId ? [E.user(myUserId)] : [] },
  });

  const createMutation = useMutation({
    mutationFn: () => api.post('/agents', { label: label.trim(), wantText: wantText.trim() }),
    onSuccess: () => {
      setCreating(false); setLabel(''); setWantText('');
      addToast('Agent created. Searching now.', 'success');
      qc.invalidateQueries({ queryKey: ['agents'], exact: false });
    },
    onError: (err: any) => addToast(err?.response?.data?.error?.message || 'Could not create that agent', 'error'),
  });

  const statusMutation = useMutation({
    mutationFn: (args: { id: string; status: Agent['status'] }) =>
      api.post(`/agents/${args.id}/status`, { status: args.status }),
    onSuccess: (_d, args) => {
      addToast(
        args.status === 'archived' ? 'Agent archived'
          : args.status === 'paused' ? 'Agent paused'
            : 'Agent searching again',
        'info',
      );
      qc.invalidateQueries({ queryKey: ['agents'], exact: false });
    },
    onError: () => addToast('Could not update that agent', 'error'),
  });

  if (isLoading) return <PageLoader />;
  const list = agents ?? [];

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#1a1a2e]">Who you are looking for</h1>
          <p className="mt-1 text-sm text-gray-500">
            Each agent keeps searching as new people join.
          </p>
        </div>
        {!creating && (
          <Button onClick={() => setCreating(true)} className="min-h-[44px] shrink-0">
            <Plus className="mr-1.5 h-4 w-4" /> New agent
          </Button>
        )}
      </div>

      {creating && (
        <Card className="mb-4 !p-4">
          <label className="block text-xs font-semibold uppercase tracking-wider text-gray-400">
            What do you call this search?
          </label>
          <input
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="Developers"
            aria-label="Agent name"
            autoFocus
            className="mt-1 min-h-[44px] w-full rounded-lg border-2 border-gray-300 px-3 text-base focus:border-rsn-red focus:outline-none"
          />
          <label className="mt-3 block text-xs font-semibold uppercase tracking-wider text-gray-400">
            Who are you looking for?
          </label>
          <textarea
            value={wantText}
            onChange={e => setWantText(e.target.value)}
            rows={3}
            placeholder="A senior React developer who can help build my product"
            aria-label="Who you are looking for"
            className="mt-1 w-full resize-none rounded-lg border-2 border-gray-300 px-3 py-2 text-base focus:border-rsn-red focus:outline-none"
          />
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Button
              onClick={() => createMutation.mutate()}
              isLoading={createMutation.isPending}
              disabled={!label.trim() || !wantText.trim()}
              className="min-h-[44px] flex-1 justify-center"
            >
              Start searching
            </Button>
            <Button variant="secondary" onClick={() => setCreating(false)} className="min-h-[44px] flex-1 justify-center">
              Cancel
            </Button>
          </div>
        </Card>
      )}

      {/* Archiving is reversible, so there has to be a way back to one. */}
      <button
        type="button"
        onClick={() => setShowArchived(v => !v)}
        className="mb-3 min-h-[44px] text-sm font-medium text-gray-500 underline-offset-2 hover:text-rsn-red hover:underline"
      >
        {showArchived ? 'Hide archived agents' : 'Show archived agents'}
      </button>

      {list.length === 0 && !creating ? (
        <Card className="!p-8 text-center">
          <Search className="mx-auto h-8 w-8 text-gray-300" />
          <p className="mt-3 text-sm font-medium text-[#1a1a2e]">You have no agents yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-gray-500">
            Tell us who you want to meet and we will keep looking, including as new people join.
          </p>
          <Button onClick={() => setCreating(true)} className="mt-4 min-h-[44px]">
            <Plus className="mr-1.5 h-4 w-4" /> Create your first agent
          </Button>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {list.map(a => (
            <Card key={a.id} className="!p-4" data-testid={`agent-${a.id}`}>
              <div className="flex items-start justify-between gap-3">
                <Link to={`/agents/${a.id}`} className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-base font-semibold text-[#1a1a2e]">{a.label}</p>
                    {a.status !== 'active' && (
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-gray-500">
                        {a.status === 'paused' ? 'Paused' : 'Archived'}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-xs text-gray-500">{a.wantText}</p>
                  <p
                    className={`mt-2 text-sm font-medium ${a.matchCount > 0 ? 'text-rsn-red' : 'text-gray-400'}`}
                    data-testid={`agent-count-${a.id}`}
                  >
                    {a.matchCount} {a.matchCount === 1 ? 'potential match' : 'potential matches'}
                  </p>
                </Link>
                <div className="flex shrink-0 items-center gap-1">
                  {a.status === 'archived' ? (
                    <button
                      type="button"
                      onClick={() => statusMutation.mutate({ id: a.id, status: 'active' })}
                      className="min-h-[44px] rounded-lg border border-rsn-red/30 px-3 text-sm font-medium text-rsn-red hover:bg-rsn-red-light"
                    >
                      Reactivate
                    </button>
                  ) : (
                  <>
                  <button
                    type="button"
                    aria-label={a.status === 'active' ? 'Pause agent' : 'Resume agent'}
                    onClick={() => statusMutation.mutate({ id: a.id, status: a.status === 'active' ? 'paused' : 'active' })}
                    className="flex h-11 w-11 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-50 hover:text-gray-700"
                  >
                    {a.status === 'active' ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                  </button>
                  <button
                    type="button"
                    aria-label="Archive agent"
                    onClick={() => statusMutation.mutate({ id: a.id, status: 'archived' })}
                    className="flex h-11 w-11 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-50 hover:text-gray-700"
                  >
                    <Archive className="h-4 w-4" />
                  </button>
                  </>
                  )}
                  <Link
                    to={`/agents/${a.id}`}
                    aria-label={`Open ${a.label}`}
                    className="flex h-11 w-11 items-center justify-center rounded-lg text-gray-300 hover:bg-gray-50 hover:text-gray-700"
                  >
                    <ChevronRight className="h-5 w-5" />
                  </Link>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
