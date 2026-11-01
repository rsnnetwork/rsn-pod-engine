// ─── A circle's members (T14, 1 Nov 2026) ────────────────────────────────────────────────────────────────────────
// The active members the server lists, each linking to their profile, with OWNER or MOD beside the people who run it.
// The people who run the circle may remove a member ("same as Parts"): never the owner, never themselves; it asks first.
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { UserMinus, Users } from 'lucide-react';
import Card from '@/components/ui/Card';
import Avatar from '@/components/ui/Avatar';
import api from '@/lib/api';
import { useConfirm } from '@/hooks/useConfirm';
import { personHref } from '@/features/reason/human/profile-text';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { canRemoveMember, roleBadge, type CircleDetail } from './circle-logic';
import { circleErrorSentence, refreshCircle } from './useCircleActions';

export default function CircleMembersSection({ circle }: { circle: CircleDetail }) {
  const me = useAuthStore((s) => s.user?.id as string | undefined);
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const { ask, confirmDialog } = useConfirm();
  const remove = useMutation({
    networkMode: 'always',
    mutationFn: ({ userId }: { userId: string; name: string }) => api.delete(`/circles/${circle.id}/members/${userId}`),
    onSuccess: async (_res, { name }) => {
      await refreshCircle(qc, circle.id);
      addToast(`${name} was removed from ${circle.name}.`, 'success');
    },
    onError: (err) => addToast(circleErrorSentence(err, 'They could not be removed. Try again.'), 'error'),
  });

  const removeMember = async (userId: string, name: string) => {
    if (remove.isPending) return;
    if (!(await ask({
      title: `Remove ${name}?`,
      body: circle.joinPolicy === 'closed' ? 'They leave the circle. To come back they ask to join again.' : 'They leave the circle. They can join again.',
      confirmLabel: 'Remove',
      tone: 'danger',
    }))) return;
    remove.mutate({ userId, name });
  };

  return (
    <div className="space-y-2 animate-fade-in-up" data-testid="circle-members">
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
            return (
              <Card key={m.userId} className="!p-3">
                <div className="flex items-center gap-2">
                  <Link to={personHref(m.userId, 'Circles')} className="flex min-h-[44px] min-w-0 flex-1 items-center gap-3 hover:opacity-80 transition-opacity">
                    <Avatar src={m.avatarUrl || undefined} name={name} size="sm" />
                    <p className="text-sm font-medium text-gray-900 truncate">{name}</p>
                    {badge && <span className="ml-auto shrink-0 text-[10px] font-semibold text-rsn-red bg-rsn-red-light px-2 py-0.5 rounded-full">{badge}</span>}
                  </Link>
                  {canRemoveMember(m, me, circle.canManage) && (
                    <button
                      type="button"
                      onClick={() => void removeMember(m.userId, name)}
                      disabled={remove.isPending}
                      className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center text-gray-400 hover:text-red-500 disabled:opacity-50"
                      aria-label={`Remove ${name} from this circle`}
                      title="Remove from circle"
                    ><UserMinus className="h-4 w-4" /></button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {confirmDialog}
    </div>
  );
}
