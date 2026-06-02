// ─── Event Plan Strip ──────────────────────────────────────────────────────
//
// Phase 3 (5 May spec compliance) — host-side visibility into the entire
// event plan. After Start Event runs Phase 2.5A's generateSessionSchedule,
// every round is pre-planned at status='scheduled'. This strip shows the
// host all rounds at a glance: which are done, active, planned, etc., plus
// pair count and bye count per round.
//
// Auto-refreshes when:
//   - The component mounts (initial fetch)
//   - host:event_plan_generated socket event fires (after Start Event)
//   - host:event_plan_repaired socket event fires (after late-joiner / leaver)
//
// Visibility: host-or-cohost only (server enforces auth). Non-host
// participants don't see this strip — it's rendered conditionally in the
// host UI tree.

import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Play, Clock, XCircle, AlertTriangle } from 'lucide-react';
import api from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { useSessionStore } from '@/stores/sessionStore';
import { E } from '@/realtime/entities';

interface PlanRound {
  roundNumber: number;
  status: 'completed' | 'active' | 'planned' | 'cancelled' | 'unplanned' | 'mixed';
  pairCount: number;
  byeCount: number;
  hasFallback: boolean;
  // 26 May (Item A) — count of algorithm pairs where a person had already met
  // their partner in a prior round of this event. Drives the fallback tooltip.
  repeatPairCount?: number;
}

interface PlanResponse {
  rounds: PlanRound[];
  totalRounds: number;
}

const STATUS_LABEL: Record<PlanRound['status'], { label: string; icon: typeof CheckCircle2; cls: string }> = {
  completed: { label: 'Done', icon: CheckCircle2, cls: 'bg-emerald-50 border-emerald-200 text-emerald-700' },
  active:    { label: 'Active', icon: Play, cls: 'bg-amber-100 border-amber-400 text-amber-900 font-semibold' },
  planned:   { label: 'Planned', icon: Clock, cls: 'bg-gray-50 border-gray-200 text-gray-600' },
  cancelled: { label: 'Cancelled', icon: XCircle, cls: 'bg-red-50 border-red-200 text-red-700' },
  unplanned: { label: 'Pending', icon: Clock, cls: 'bg-gray-50 border-gray-200 text-gray-400' },
  mixed:     { label: 'In progress', icon: Play, cls: 'bg-amber-50 border-amber-200 text-amber-700' },
};

interface Props { sessionId: string; }

export default function EventPlanStrip({ sessionId }: Props) {
  const queryClient = useQueryClient();
  const eventPlanSummary = useSessionStore(s => s.eventPlanSummary);

  const { data, isLoading } = useQuery<PlanResponse>({
    queryKey: ['event-plan', sessionId],
    queryFn: () => api.get(`/sessions/${sessionId}/plan`).then(r => r.data.data),
    enabled: !!sessionId,
    // Treat plan as somewhat fresh — host actions invalidate explicitly.
    staleTime: 60_000,
    retry: 1,
    // R2 safety net (20 May 2026). Even though R7 fix now fires
    // host:event_plan_repaired + E.sessionPlan on Re-match and fresh
    // generation, a 30 s background refetch guarantees the round button
    // strip self-heals if a server emit ever silently fails or a client
    // misses one mid-reconnect.
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    meta: { entities: sessionId ? [E.session(sessionId), E.sessionPlan(sessionId)] : [] },
  });

  // Refetch when the server reports a plan event (generated or repaired).
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const refresh = () => queryClient.invalidateQueries({ queryKey: ['event-plan', sessionId] });
    socket.on('host:event_plan_generated', refresh);
    socket.on('host:event_plan_repaired', refresh);
    return () => {
      socket.off('host:event_plan_generated', refresh);
      socket.off('host:event_plan_repaired', refresh);
    };
  }, [queryClient, sessionId]);

  if (isLoading || !data || data.rounds.length === 0) return null;

  const headlineSummary = eventPlanSummary
    ? `Plan: ${eventPlanSummary.roundCount} ${eventPlanSummary.roundCount === 1 ? 'round' : 'rounds'} · ${eventPlanSummary.totalPairs} pairs`
    : `Plan: ${data.totalRounds} rounds`;

  return (
    <div className="border-b border-gray-200 bg-white px-4 py-2.5">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">
          Event Plan
        </h3>
        <span className="text-[11px] text-gray-500">{headlineSummary}</span>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
        {data.rounds.map((r) => {
          const meta = STATUS_LABEL[r.status];
          const Icon = meta.icon;
          const isActive = r.status === 'active';
          return (
            <div
              key={r.roundNumber}
              className={`flex-shrink-0 min-w-[110px] border rounded-lg px-2.5 py-2 ${meta.cls} ${isActive ? 'ring-2 ring-amber-400' : ''}`}
              title={
                r.status === 'cancelled'
                  ? `Round ${r.roundNumber} was cancelled — its matches were cleared (e.g. after a re-match, a host/co-host change, or ending the round early). Click "Match People" to plan this round again.`
                  : `Round ${r.roundNumber}: ${meta.label}${r.byeCount > 0 ? ` · ${r.byeCount} not matched` : ''}`
              }
            >
              <div className="flex items-center gap-1.5 mb-0.5">
                <Icon className="h-3.5 w-3.5" />
                <span className="text-xs font-semibold">Round {r.roundNumber}</span>
              </div>
              <div className="text-[11px] opacity-90 leading-tight">
                {meta.label}
                {r.status !== 'cancelled' && r.pairCount > 0 && (
                  <span className="ml-1">· {r.pairCount} {r.pairCount === 1 ? 'pair' : 'pairs'}</span>
                )}
                {r.status !== 'cancelled' && r.byeCount > 0 && (
                  // Bug 40 (19 May Stefan, via Ali) — Stefan asked for
                  // "no bye word" in user-facing copy. Standardised on
                  // "not matched" which is what the same component's
                  // tooltip + HostRoundDashboard already use.
                  <span className="ml-1">· {r.byeCount} not matched</span>
                )}
                {/* 26 May (Item A) — only show the warning on live/upcoming rounds.
                    Completed and cancelled rounds are done — the host can't act
                    on the fallback badge at that point, so don't distract them. */}
                {r.hasFallback
                  && r.status !== 'completed'
                  && r.status !== 'cancelled'
                  && (
                  <span
                    title={
                      r.repeatPairCount && r.repeatPairCount > 0
                        ? `${r.repeatPairCount} ${r.repeatPairCount === 1 ? 'pair reused a past partner' : 'pairs reused past partners'} — no fresh matching was possible this round`
                        : 'Some pairs had already met — no fresh pairing was possible this round'
                    }
                    aria-label="Some pairs reuse past partners this round"
                    className="inline-flex items-center"
                  >
                    <AlertTriangle className="h-3 w-3 text-amber-500" />
                  </span>
                )}
              </div>
              {/* #7b (23 May) — a bare "Cancelled · N not matched" left the host
                  guessing why. Say plainly what happened and the one action
                  that fixes it, instead of a cryptic count. */}
              {r.status === 'cancelled' && (
                <div className="text-[10px] opacity-80 leading-tight mt-0.5">
                  Matches cleared — press “Match People” to re-plan
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
