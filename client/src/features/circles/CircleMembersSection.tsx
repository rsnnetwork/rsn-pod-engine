// ─── A circle's members (T14, 1 Nov 2026; Shirley pilot S2, 11 Nov 2026) ─────────────────────────────────────────
// The active members the server lists, each linking to their profile, with OWNER or MOD beside the people who run it.
// S2 (D3): each row the viewer may act on has a "Manage" button (44px) that opens a sheet of what they may do
// (memberActions): the owner makes or unmakes a moderator, makes someone the owner (a confirm names what changes for
// both) or removes them; a moderator removes plain members. Removing asks first. Every change is the server's to
// allow; the page reads the circle again at once and every other screen hears circle:<id>:members.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Users } from 'lucide-react';
import Card from '@/components/ui/Card';
import Avatar from '@/components/ui/Avatar';
import Sheet from '@/features/reason/ui/Sheet';
import api from '@/lib/api';
import { useConfirm } from '@/hooks/useConfirm';
import { personHref } from '@/features/reason/human/profile-text';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { roleBadge, type CircleDetail, type CircleMember } from './circle-logic';
import { MEMBER_ACTION_LABEL, handoverQuestion, memberActions, roleToast, type MemberAction } from './circle-admin';
import { circleErrorSentence, refreshCircle } from './useCircleActions';

const SHEET_ACTION = 'flex min-h-[48px] w-full items-center rounded-xl border px-4 text-left text-[15px] font-medium disabled:opacity-50';

export default function CircleMembersSection({ circle }: { circle: CircleDetail }) {
  const me = useAuthStore((s) => s.user?.id as string | undefined);
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const { ask, confirmDialog } = useConfirm();
  const [managing, setManaging] = useState<CircleMember | null>(null);

  const act = useMutation({
    networkMode: 'always',
    mutationFn: ({ action, userId }: { action: MemberAction; userId: string; name: string }) => {
      if (action === 'remove') return api.delete(`/circles/${circle.id}/members/${userId}`);
      if (action === 'make-owner') return api.post(`/circles/${circle.id}/transfer`, { toUserId: userId });
      return api.patch(`/circles/${circle.id}/members/${userId}/role`, { role: action === 'make-moderator' ? 'moderator' : 'member' });
    },
    onSuccess: async (_res, { action, name }) => {
      setManaging(null);
      await refreshCircle(qc, circle.id);
      addToast(action === 'remove' ? `${name} was removed from ${circle.name}.` : roleToast(action, name, circle.name), 'success');
    },
    onError: async (err) => {
      addToast(circleErrorSentence(err, 'That change could not be saved. Try again.'), 'error');
      await refreshCircle(qc, circle.id);
    },
  });

  const run = async (m: CircleMember, action: MemberAction) => {
    if (act.isPending) return;
    const name = m.displayName || 'This member';
    if (action === 'make-owner') {
      const q = handoverQuestion(name, circle.name);
      if (!(await ask({ ...q, confirmLabel: 'Make owner', tone: 'danger' }))) return;
    }
    if (action === 'remove' && !(await ask({
      title: `Remove ${name}?`,
      // S2 fix round 1: an organiser's removal is final unless an organiser lets them back in.
      body: circle.joinPolicy === 'closed'
        ? 'They leave the circle. To come back they ask to join again, and you decide, or you invite them.'
        : 'They leave the circle. They cannot rejoin by themselves: only an invitation from you or a moderator brings them back.',
      confirmLabel: 'Remove',
      tone: 'danger',
    }))) return;
    act.mutate({ action, userId: m.userId, name });
  };

  const managingActions = managing ? memberActions(managing, me, circle) : [];

  return (
    <div id="circle-members" className="scroll-mt-4 space-y-2 animate-fade-in-up" data-testid="circle-members">
      <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
        <Users className="h-4 w-4 text-rsn-red" /> Members
      </h2>
      {circle.members.length === 0 ? (
        <Card><p className="text-sm text-gray-500 text-center py-2">Nobody here yet. Be the first to join.</p></Card>
      ) : (
        <div className="grid grid-cols-1 gap-2">
          {circle.members.map((m) => {
            const name = m.displayName || 'Member';
            const badge = roleBadge(m.role);
            const actions = memberActions(m, me, circle);
            return (
              <Card key={m.userId} className="!p-3">
                <div className="flex items-center gap-2">
                  <Link to={personHref(m.userId, 'Circles')} className="flex min-h-[44px] min-w-0 flex-1 items-center gap-3 hover:opacity-80 transition-opacity">
                    <Avatar src={m.avatarUrl || undefined} name={name} size="sm" />
                    <p className="text-sm font-medium text-gray-900 truncate">{name}</p>
                    {badge && <span className="ml-auto shrink-0 text-[10px] font-semibold text-rsn-red bg-rsn-red-light px-2 py-0.5 rounded-full" data-testid={`circle-role-${m.userId}`}>{badge}</span>}
                  </Link>
                  {actions.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setManaging(m)}
                      disabled={act.isPending}
                      className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-50 hover:text-gray-800 disabled:opacity-50"
                      aria-label={`Manage ${name}`}
                      aria-haspopup="dialog"
                      data-testid={`circle-member-manage-${m.userId}`}
                    ><MoreHorizontal className="h-5 w-5" /></button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <Sheet open={!!managing && managingActions.length > 0} onClose={() => { if (!act.isPending) setManaging(null); }} title={managing?.displayName || 'Member'}>
        <div className="mt-2 grid gap-2" data-testid="circle-member-actions">
          {managingActions.map((action) => (
            <button
              key={action}
              type="button"
              onClick={() => managing && void run(managing, action)}
              disabled={act.isPending}
              data-testid={`circle-member-action-${action}`}
              className={`${SHEET_ACTION} ${action === 'remove' || action === 'make-owner' ? 'border-red-200 text-red-700 hover:bg-red-50' : 'border-gray-200 text-[#1a1a2e] hover:bg-gray-50'}`}
            >
              {act.isPending && act.variables?.action === action ? 'Saving…' : MEMBER_ACTION_LABEL[action]}
            </button>
          ))}
        </div>
      </Sheet>
      {confirmDialog}
    </div>
  );
}
