// One matching agent and the people it found (Wave 2 core, 3 Aug 2026).
//
// Introductions sent from here carry the agent, so asking to meet someone
// through Developers does not hide them from Investors, where they may fit for
// a different reason (decision D3).

import { useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Pencil, Check, Search } from 'lucide-react';
import Card from '@/components/ui/Card';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/Spinner';
import { useToastStore } from '@/stores/toastStore';
import api from '@/lib/api';
import type { Agent } from './AgentsPage';

interface AgentMatch {
  candidateUserId: string;
  score: number;
  reason: string;
  displayName: string | null;
  avatarUrl: string | null;
  professionalRole: string[] | string | null;
  jobTitle: string | null;
  company: string | null;
}

function roleLine(m: AgentMatch): string {
  const role = Array.isArray(m.professionalRole)
    ? m.professionalRole.filter(Boolean).join(', ')
    : m.professionalRole || m.jobTitle || '';
  return [role, m.company].filter(Boolean).join(' · ');
}

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const addToast = useToastStore(s => s.addToast);
  const [editing, setEditing] = useState(false);
  const [wantText, setWantText] = useState('');
  const [requested, setRequested] = useState<Set<string>>(new Set());

  // realtime: skip — background scoring emits no per-agent event; this polls instead
  const { data, isLoading } = useQuery({
    queryKey: ['agent', id],
    queryFn: () => api.get(`/agents/${id}`).then(r => r.data.data as { agent: Agent; matches: AgentMatch[] }),
    enabled: !!id,
    refetchInterval: 15_000,
  });

  const saveMutation = useMutation({
    mutationFn: () => api.patch(`/agents/${id}`, { wantText: wantText.trim() }),
    onSuccess: () => {
      setEditing(false);
      addToast('Updated. Searching again.', 'success');
      qc.invalidateQueries({ queryKey: ['agent', id] });
      qc.invalidateQueries({ queryKey: ['agents'] });
    },
    onError: () => addToast('Could not save that change', 'error'),
  });

  const interestMutation = useMutation({
    mutationFn: (userId: string) => api.post(`/agents/${id}/interest`, { userId }),
    onSuccess: (_d, userId) => {
      setRequested(prev => new Set(prev).add(userId));
      addToast('Introduction requested', 'success');
      qc.invalidateQueries({ queryKey: ['agents'] });
    },
    onError: (err: any) => addToast(err?.response?.data?.error?.message || 'Could not send that', 'error'),
  });

  if (isLoading) return <PageLoader />;
  if (!data) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <Card className="!p-8 text-center text-sm text-gray-500">That agent no longer exists.</Card>
      </div>
    );
  }

  const { agent, matches } = data;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <button
        onClick={() => navigate('/agents')}
        className="mb-3 flex min-h-[44px] items-center gap-1.5 text-sm text-gray-500 hover:text-[#1a1a2e]"
      >
        <ArrowLeft className="h-4 w-4" /> All agents
      </button>

      <Card className="!p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-display text-xl font-bold text-[#1a1a2e]">{agent.label}</h1>
            {editing ? (
              <>
                <textarea
                  value={wantText}
                  onChange={e => setWantText(e.target.value)}
                  rows={3}
                  aria-label="Who you are looking for"
                  className="mt-2 w-full resize-none rounded-lg border-2 border-gray-300 px-3 py-2 text-sm focus:border-rsn-red focus:outline-none"
                />
                <div className="mt-2 flex gap-2">
                  <Button
                    onClick={() => saveMutation.mutate()}
                    isLoading={saveMutation.isPending}
                    disabled={!wantText.trim()}
                    className="min-h-[44px]"
                  >
                    <Check className="mr-1.5 h-4 w-4" /> Save
                  </Button>
                  <Button variant="secondary" onClick={() => setEditing(false)} className="min-h-[44px]">Cancel</Button>
                </div>
              </>
            ) : (
              <p className="mt-1 text-sm text-gray-600">{agent.wantText}</p>
            )}
          </div>
          {!editing && (
            <button
              type="button"
              aria-label="Edit what this agent looks for"
              onClick={() => { setWantText(agent.wantText); setEditing(true); }}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-50 hover:text-gray-700"
            >
              <Pencil className="h-4 w-4" />
            </button>
          )}
        </div>
      </Card>

      <p className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wider text-gray-400">
        {matches.length} {matches.length === 1 ? 'potential match' : 'potential matches'}
      </p>

      {matches.length === 0 ? (
        <Card className="!p-8 text-center">
          <Search className="mx-auto h-8 w-8 text-gray-300" />
          <p className="mt-3 text-sm font-medium text-[#1a1a2e]">Nobody fits this yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-gray-500">
            This agent keeps searching. You will be told the moment someone who fits joins.
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {matches.map(m => (
            <Card key={m.candidateUserId} className="!p-4" data-testid={`agent-match-${m.candidateUserId}`}>
              <div className="flex items-start gap-3">
                <Avatar src={m.avatarUrl || undefined} name={m.displayName || 'Member'} size="md" />
                <div className="min-w-0 flex-1">
                  <Link to={`/profile/${m.candidateUserId}`} className="truncate text-sm font-semibold text-[#1a1a2e] hover:underline">
                    {m.displayName || 'A member'}
                  </Link>
                  <p className="truncate text-xs text-gray-500">{roleLine(m)}</p>
                  <p className="mt-1 text-xs text-gray-600">{m.reason}</p>
                </div>
              </div>
              <Button
                onClick={() => interestMutation.mutate(m.candidateUserId)}
                disabled={requested.has(m.candidateUserId) || interestMutation.isPending}
                className="mt-3 min-h-[44px] w-full justify-center"
              >
                {requested.has(m.candidateUserId) ? 'Introduction requested' : 'I want to meet'}
              </Button>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
