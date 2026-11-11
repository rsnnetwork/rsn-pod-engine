// ─── Circle Detail ───────────────────────────────────────────────────────────
//
// REASON v1 Phase 3a (19 Jul 2026). A circle's home: who's in it, which pods
// are attached, upcoming events those pods run, nested child circles, the wall.
// T14 (1 Nov 2026; 30 Oct review 7.4 to 7.6): the server says what the viewer may do (CircleAccess). One button joins,
// asks to join a closed circle, withdraws the ask or leaves; Invite opens the shared invite sheet for whoever may
// invite; the people who run it choose who can join, answer the asks (also opened by a bell's ?requests=1), make or
// attach pods and remove members. A closed circle shows people outside it its name and counts and nothing else.
// The page follows circle:<id> and the member's own circles (and, for its managers, the asks), so every change shows
// without a refresh. T15: its Organisations (the entities linked to it), after its pods.
// T13 (1 Nov 2026; 30 Oct review 6.5): its managers schedule an event for everyone in it ("Schedule an event" in the
// header's row of actions). Its events are its own and its pods', as the server lists them, and the page follows the
// member's own events too, so a new circle event shows without a refresh.
// Shirley pilot S7 (item 20): its owner and moderators export its data (Export, in the same row of organiser actions).

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Users, CalendarPlus, CircleDashed, MessagesSquare, Mail, Lock, Settings2, Inbox, Pencil, Send, Download } from 'lucide-react';
import Card from '@/components/ui/Card';
import { PageLoader } from '@/components/ui/Spinner';
import api from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import InvitePickerSheet from '@/features/invites/InvitePickerSheet';
import CircleWall from './CircleWall';
import CircleJoinButton from './CircleJoinButton';
import CircleSettingsSheet from './CircleSettingsSheet';
import CircleRequestsSheet from './CircleRequestsSheet';
import CirclePodsSection from './CirclePodsSection';
import CircleMembersSection from './CircleMembersSection';
import CircleEventsSection from './CircleEventsSection';
import { scheduleForCircleHref } from '@/features/sessions/circle-preset';
import CircleOrganisationsSection from './CircleOrganisationsSection';
import EditCircleSheet from './EditCircleSheet';
import CircleInvitesSheet from './CircleInvitesSheet';
import SpaceExportSheet from '@/features/spaces/SpaceExportSheet';
import { mayExportCircle } from '@/features/spaces/space-export';
import { LOCKED_COPY, WHO_CAN_JOIN, circleEntities, requestsLabel, type CircleDetail } from './circle-logic';
import { EDIT_DETAILS, INVITATIONS } from './circle-admin';

const HEADER_ACTION = 'inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-gray-200 px-3 text-sm font-medium text-[#1a1a2e] hover:bg-gray-50';

export default function CircleDetailPage() {
  const { circleId } = useParams();
  // ?post=<id>: a shared link or a bell entry lands on one post; the wall scrolls to it. ?requests=1: a manager's
  // join_request bell opens the asks.
  const [searchParams, setSearchParams] = useSearchParams();
  const highlightPostId = searchParams.get('post') || undefined;
  const { user } = useAuthStore();
  const [sheet, setSheet] = useState<'invite' | 'settings' | 'edit' | 'invitations' | 'export' | null>(null);
  const qc = useQueryClient();
  // Final fix wave CM5 (2 Nov 2026): the people who run the circle also follow its asks (circle:<id>:requests), so its
  // Requests (n) count moves with them. Read from the page's own answer once it has one; the tags follow each render.
  const runsIt = !!qc.getQueryData<CircleDetail>(['circle', circleId])?.canManage;

  const { data: circle, isLoading, isError, refetch } = useQuery<CircleDetail>({
    queryKey: ['circle', circleId],
    queryFn: () => api.get(`/circles/${circleId}`).then(r => r.data.data),
    enabled: !!circleId,
    meta: { entities: circleEntities(circleId ?? '', user?.id, runsIt) },
  });

  if (isLoading) return <PageLoader />;
  if (isError || !circle) {
    return (
      <div className="max-w-3xl mx-auto space-y-4">
        <Link to="/circles" className="inline-flex items-center gap-1.5 min-h-[44px] text-sm text-gray-500 hover:text-gray-800"><ArrowLeft className="h-4 w-4" /> All circles</Link>
        <Card>
          <p className="text-sm text-gray-700" role="alert">We could not open this circle. It may have been archived.</p>
          <button type="button" onClick={() => void refetch()} className={`${HEADER_ACTION} mt-3`}>Try again</button>
        </Card>
      </div>
    );
  }

  const requestsOpen = !!circle.canManage && searchParams.get('requests') === '1';
  const closeRequests = () => { const next = new URLSearchParams(searchParams); next.delete('requests'); setSearchParams(next, { replace: true }); };
  const openRequests = () => { const next = new URLSearchParams(searchParams); next.set('requests', '1'); setSearchParams(next); };
  const canInvite = circle.canInvite ?? circle.isMember;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <Link to="/circles" className="inline-flex items-center gap-1.5 min-h-[44px] text-sm text-gray-500 hover:text-gray-800 transition-colors animate-fade-in">
        <ArrowLeft className="h-4 w-4" /> All circles
      </Link>

      {/* The title, then its actions on a row of their own at every width: beside a long name they squeezed it at 768. */}
      <div className="flex flex-col gap-3 animate-fade-in">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-[#1a1a2e] break-words">{circle.name}</h1>
          {circle.description && <p className="text-gray-500 text-sm mt-1 break-words">{circle.description}</p>}
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-gray-400 mt-2">
            <Users className="h-3.5 w-3.5" /> {circle.memberCount} {circle.memberCount === 1 ? 'member' : 'members'}
            {circle.joinPolicy === 'closed' && <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-gray-600" data-testid="circle-closed-badge"><Lock className="h-3 w-3" /> Closed</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* T13: its managers schedule an event for everyone in it. */}
          {circle.canManage && (
            <Link to={scheduleForCircleHref(circle.id)} data-testid="circle-schedule-event" className={HEADER_ACTION}>
              <CalendarPlus className="h-4 w-4" /> Schedule an event
            </Link>
          )}
          {canInvite && (
            <button type="button" onClick={() => setSheet('invite')} data-testid="circle-invite" className={HEADER_ACTION}>
              <Mail className="h-4 w-4" /> Invite
            </button>
          )}
          {/* S2: the people who run it edit its name and description; the owner also chooses who can join there. */}
          {circle.canManage && (
            <button type="button" onClick={() => setSheet('edit')} data-testid="circle-edit" className={HEADER_ACTION}>
              <Pencil className="h-4 w-4" /> {EDIT_DETAILS}
            </button>
          )}
          {circle.canManage && (
            <button type="button" onClick={() => setSheet('invitations')} data-testid="circle-invitations" className={HEADER_ACTION}>
              <Send className="h-4 w-4" /> {INVITATIONS}
            </button>
          )}
          {/* S2 (D3): who can join is the owner's choice (or a platform admin's). */}
          {circle.isOwner && circle.joinPolicy !== undefined && (
            <button type="button" onClick={() => setSheet('settings')} data-testid="circle-settings" className={HEADER_ACTION} aria-label={WHO_CAN_JOIN}>
              <Settings2 className="h-4 w-4" /> {WHO_CAN_JOIN}
            </button>
          )}
          {mayExportCircle(circle.myRole) && (
            <button type="button" onClick={() => setSheet('export')} data-testid="circle-export" className={HEADER_ACTION}>
              <Download className="h-4 w-4" /> Export
            </button>
          )}
          {circle.canManage && (circle.joinPolicy === 'closed' || (circle.requestCount ?? 0) > 0) && (
            <button type="button" onClick={openRequests} data-testid="circle-requests-open" className={HEADER_ACTION}>
              <Inbox className="h-4 w-4" /> {requestsLabel(circle.requestCount)}
            </button>
          )}
          <CircleJoinButton circle={circle} />
        </div>
      </div>

      {circle.locked && (
        <Card className="animate-fade-in-up" data-testid="circle-locked">
          <div className="flex items-start gap-3">
            <Lock className="mt-0.5 h-5 w-5 shrink-0 text-rsn-red" aria-hidden="true" />
            <p className="text-sm text-gray-700">{LOCKED_COPY}</p>
          </div>
        </Card>
      )}

      {circle.children.length > 0 && (
        <div className="space-y-2 animate-fade-in-up">
          <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
            <CircleDashed className="h-4 w-4 text-rsn-red" /> Circles inside
          </h2>
          <div className="grid gap-2">
            {circle.children.map(ch => (
              <Card key={ch.id} className="card-hover !p-4">
                <Link to={`/circles/${ch.id}`} className="flex items-center justify-between min-h-[36px]">
                  <p className="font-medium text-gray-900">{ch.name}</p>
                  <p className="text-xs text-gray-400">{ch.memberCount} members</p>
                </Link>
              </Card>
            ))}
          </div>
        </div>
      )}

      {!circle.locked && <CircleEventsSection circle={circle} />}

      {!circle.locked && <CirclePodsSection circle={circle} />}

      {!circle.locked && <CircleOrganisationsSection circle={circle} />}

      {!circle.locked && (
        <div className="space-y-2 animate-fade-in-up">
          <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
            <MessagesSquare className="h-4 w-4 text-rsn-red" /> Wall
          </h2>
          <CircleWall circleId={circle.id} isMember={circle.isMember} highlightPostId={highlightPostId} />
        </div>
      )}

      {!circle.locked && <CircleMembersSection circle={circle} />}

      <InvitePickerSheet open={sheet === 'invite'} onClose={() => setSheet(null)} target={{ type: 'circle', circleId: circle.id }} />
      {sheet === 'settings' && circle.joinPolicy && (
        <CircleSettingsSheet circleId={circle.id} name={circle.name} current={circle.joinPolicy} waiting={circle.requestCount ?? 0} onClose={() => setSheet(null)} />
      )}
      {requestsOpen && <CircleRequestsSheet circleId={circle.id} onClose={closeRequests} />}
      {sheet === 'edit' && <EditCircleSheet circle={circle} onClose={() => setSheet(null)} />}
      {sheet === 'export' && <SpaceExportSheet kind="circle" spaceId={circle.id} name={circle.name} onClose={() => setSheet(null)} />}
      {sheet === 'invitations' && (
        <CircleInvitesSheet circleId={circle.id} circleName={circle.name} onClose={() => setSheet(null)} onInvite={() => setSheet('invite')} />
      )}
    </div>
  );
}
