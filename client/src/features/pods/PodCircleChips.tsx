// ─── The circles a pod is in ("In circles", REASON P3b; Shirley pilot S2, 11 Nov 2026, brief RSN 03) ──────────────
// Each circle the pod is attached to, as a chip that opens it. S2: the list follows pod:<id> (attaching or taking the pod
// out tells the pod's members), so it changes without a reload; it is read only by someone who may see the pod (the
// server answers 404 otherwise, and nothing is shown). The pod's own director (and platform admins) may take the pod
// out of any circle, run by them or not: a 44px "Remove" beside each chip asks first and says the pod keeps its
// members, settings, discussion and events.
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import { useConfirm } from '@/hooks/useConfirm';
import { useToastStore } from '@/stores/toastStore';
import { circleErrorSentence } from '@/features/circles/useCircleActions';

interface Props { podId?: string; podName: string; canUnlink: boolean }

export default function PodCircleChips({ podId, podName, canUnlink }: Props) {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const { ask, confirmDialog } = useConfirm();
  const { data: circles } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['circlesOfPod', podId],
    queryFn: () => api.get(`/circles/of-pod/${podId}`).then(r => r.data.data ?? []),
    enabled: !!podId,
    meta: { entities: podId ? [E.pod(podId)] : [] },
  });
  const unlink = useMutation({
    networkMode: 'always',
    mutationFn: (circle: { id: string; name: string }) => api.delete(`/circles/${circle.id}/pods/${podId}`),
    onSuccess: async (_res, circle) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['circlesOfPod', podId] }),
        qc.invalidateQueries({ queryKey: ['circle', circle.id] }),
      ]);
      addToast(`${podName} is no longer in ${circle.name}.`, 'success');
    },
    onError: (err) => addToast(circleErrorSentence(err, 'The pod could not be taken out of that circle. Try again.'), 'error'),
  });

  const remove = async (circle: { id: string; name: string }) => {
    if (unlink.isPending) return;
    if (!(await ask({
      title: `Take ${podName} out of ${circle.name}?`,
      body: 'It is no longer listed in that circle. The pod keeps its members, settings, discussion and events.',
      confirmLabel: 'Take it out',
      tone: 'danger',
    }))) return;
    unlink.mutate(circle);
  };

  if (!circles || circles.length === 0) return null;
  return (
    <div className="animate-fade-in-up" data-testid="pod-circle-chips">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-semibold text-gray-500">In circles:</span>
        {circles.map(c => (
          <span key={c.id} className="inline-flex items-center">
            {/* A 44px tap around the 28px chip, inside the app (a bare link reloaded the whole page). */}
            <Link to={`/circles/${c.id}`} className="inline-flex min-h-[44px] items-center hover:opacity-80 transition-opacity">
              <span className="inline-flex min-h-[28px] items-center rounded-full bg-rsn-red-light px-2.5 py-1 text-xs font-medium text-rsn-red">{c.name}</span>
            </Link>
            {canUnlink && (
              <button
                type="button"
                onClick={() => void remove(c)}
                disabled={unlink.isPending}
                className="flex min-h-[44px] min-w-[44px] items-center justify-center text-gray-400 hover:text-red-500 disabled:opacity-50"
                aria-label={`Take ${podName} out of ${c.name}`}
                data-testid={`pod-unlink-${c.id}`}
              ><X className="h-4 w-4" /></button>
            )}
          </span>
        ))}
      </div>
      {confirmDialog}
    </div>
  );
}
