// ─── Circles Page ────────────────────────────────────────────────────────────
//
// REASON v1 Phase 3a (19 Jul 2026). Circles are communities — groups of people
// with the same intent/type (Stefan's definition). Admins can create circles
// here (v1 is admin-created, per his answer "we do"). T14 (1 Nov 2026): a circle
// is Open or Closed; each card's one button joins, asks to join, withdraws the ask
// or leaves (CircleJoinButton), and the list follows the member's own circles.
// Shirley pilot S7 (fix round 1): the archived circles the member ran, with their export, below the list.
// Ben field test (13 Nov 2026): "Not everyone needs a Circle." A member asks for one (Request a circle) and a REASON
// admin decides; their asks and the answers are listed here. An admin's New circle chooses who can join first.

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CircleDashed, Users, Plus, Lock } from 'lucide-react';
import Card from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { PageLoader } from '@/components/ui/Spinner';
import EmptyState from '@/components/ui/EmptyState';
import api from '@/lib/api';
import { isAdmin } from '@/lib/utils';
import { E } from '@/realtime/entities';
import { useAuthStore } from '@/stores/authStore';
import CircleJoinButton from './CircleJoinButton';
import ArchivedCirclesSection from './ArchivedCirclesSection';
import MyCircleRequests from './MyCircleRequests';
import NewCircleSheet from './NewCircleSheet';
import RequestCircleSheet from './RequestCircleSheet';
import { POLICY_LABEL, isRestricted, type CircleSummary } from './circle-logic';

export default function CirclesPage() {
  const { user } = useAuthStore();
  const admin = isAdmin(user?.role);
  const queryClient = useQueryClient();
  const [sheet, setSheet] = useState<'new' | 'request' | null>(null);

  // This page has its own key under 'circles', not the bare ['circles'] that AppLayout reads
  // for the nav. React Query keeps ONE set of options per key, and whichever observer rendered
  // last applies its own. AppLayout is always mounted, renders again on every navigation and
  // declares no entities, so a tag on the shared key was overwritten the moment this page
  // opened (the home page tile has its own key for the same reason).
  // What refreshes the list: the member's own circles tag (user:<me>:circles, which the server sends whenever their
  // place in a circle changes: a join, a leave, an ask answered, an invite accepted), their own entity, and the
  // invalidations after a write here (the prefix ['circles'] reaches this key too).
  // The nav's list is the same endpoint with the same shape. It is read here, never written,
  // to stand in while this key has no answer of its own, so the page opens on the list and not
  // on a loader.
  const { data: circles, isLoading } = useQuery<CircleSummary[]>({
    queryKey: ['circles', 'list'],
    queryFn: () => api.get('/circles').then(r => r.data.data ?? []),
    placeholderData: () => queryClient.getQueryData<CircleSummary[]>(['circles']),
    meta: { entities: user?.id ? [E.userCircles(user.id), E.user(user.id)] : [] },
  });

  if (isLoading) return <PageLoader />;

  // v1 list shows top-level circles; children appear on their parent's page.
  const topLevel = (circles ?? []).filter(c => !c.parentCircleId);

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold text-[#1a1a2e]">Circles</h1>
          <p className="text-gray-500 text-sm mt-1">Communities of people who share your intent</p>
        </div>
        <div className="flex items-center gap-2">
          {admin ? (
            <Button size="sm" onClick={() => setSheet('new')} className="min-h-[44px]" data-testid="circle-new-open">
              <Plus className="h-4 w-4 mr-1" /> New circle
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setSheet('request')} className="min-h-[44px]" data-testid="circle-request-open">
              <Plus className="h-4 w-4 mr-1" /> Request a circle
            </Button>
          )}
          <CircleDashed className="hidden sm:block h-8 w-8 text-rsn-red" />
        </div>
      </div>

      {!admin && <MyCircleRequests userId={user?.id} />}

      {topLevel.length === 0 ? (
        <EmptyState
          title="No circles yet"
          description={admin ? 'Create the first circle to get things going.' : 'Is there a community you belong to? Request a circle for it.'}
          icon={<CircleDashed className="h-12 w-12" />}
        />
      ) : (
        <div className="grid gap-3 animate-fade-in-up">
          {topLevel.map(c => (
            <Card key={c.id} className="card-hover">
              <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
                <Link to={`/circles/${c.id}`} className="min-w-0 flex-1">
                  <p className="font-semibold text-gray-900">{c.name}</p>
                  {c.description && (
                    <p className="text-sm text-gray-500 mt-0.5 line-clamp-2">{c.description}</p>
                  )}
                  <p className="flex items-center gap-1.5 text-xs text-gray-400 mt-2">
                    <Users className="h-3.5 w-3.5" />
                    {c.memberCount} {c.memberCount === 1 ? 'member' : 'members'}
                    {c.podCount > 0 && <> · {c.podCount} {c.podCount === 1 ? 'pod' : 'pods'}</>}
                    {isRestricted(c.joinPolicy) && <> · <Lock className="h-3 w-3" aria-hidden="true" /> {POLICY_LABEL[c.joinPolicy!]}</>}
                  </p>
                </Link>
                <CircleJoinButton circle={c} size="sm" />
              </div>
            </Card>
          ))}
        </div>
      )}

      <ArchivedCirclesSection />

      {sheet === 'new' && <NewCircleSheet onClose={() => setSheet(null)} />}
      {sheet === 'request' && <RequestCircleSheet onClose={() => setSheet(null)} />}
    </div>
  );
}
