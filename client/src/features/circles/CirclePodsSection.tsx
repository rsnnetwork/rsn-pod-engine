// ─── A circle's pods (T14, 1 Nov 2026; 30 Oct review 7.6) ────────────────────────────────────────────────────────
// Everyone sees the pods the server lists (archived pods never, a private pod only to its members). The people who
// run the circle (canManage) get New pod (the pod form, attached in the same call, the page stays here) and Attach a
// pod (a searchable sheet whose top offers Create a new pod), and may detach one, which asks first.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Box, Link2, Plus, X } from 'lucide-react';
import Card from '@/components/ui/Card';
import api from '@/lib/api';
import { useConfirm } from '@/hooks/useConfirm';
import { useToastStore } from '@/stores/toastStore';
import CreatePodModal from '@/features/pods/CreatePodModal';
import AttachPodSheet from './AttachPodSheet';
import type { CircleDetail } from './circle-logic';
import { circleErrorSentence, refreshCircle } from './useCircleActions';

const ACTION = 'inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-gray-200 px-3 text-sm font-medium text-[#1a1a2e] hover:bg-gray-50';

export default function CirclePodsSection({ circle }: { circle: CircleDetail }) {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const { ask, confirmDialog } = useConfirm();
  const [sheet, setSheet] = useState<'new' | 'attach' | null>(null);
  const manager = !!circle.canManage;
  if (circle.pods.length === 0 && !manager) return null;

  const detach = async (podId: string, name: string) => {
    if (!(await ask({ title: `Detach ${name}?`, body: 'It leaves this circle. The pod itself is untouched.', confirmLabel: 'Detach', tone: 'danger' }))) return;
    try {
      await api.delete(`/circles/${circle.id}/pods/${podId}`);
      await refreshCircle(qc, circle.id);
    } catch (err) { addToast(circleErrorSentence(err, 'That pod could not be detached. Try again.'), 'error'); }
  };

  return (
    <div className="space-y-2 animate-fade-in-up" data-testid="circle-pods">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
          <Box className="h-4 w-4 text-rsn-red" /> Pods in this circle
        </h2>
        {manager && (
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setSheet('new')} className={ACTION} data-testid="circle-new-pod">
              <Plus className="h-4 w-4" aria-hidden="true" /> New pod
            </button>
            <button type="button" onClick={() => setSheet('attach')} className={ACTION} data-testid="circle-attach-pod">
              <Link2 className="h-4 w-4" aria-hidden="true" /> Attach a pod
            </button>
          </div>
        )}
      </div>
      {circle.pods.length === 0 ? (
        <Card><p className="text-sm text-gray-500 text-center py-2">No pods here yet. Make one or attach one you run.</p></Card>
      ) : (
        <div className="grid grid-cols-1 gap-2">
          {circle.pods.map((p) => (
            <Card key={p.podId} className="card-hover !p-4">
              <div className="flex items-center justify-between gap-2">
                <Link to={`/pods/${p.podId}`} className="flex min-h-[44px] min-w-0 flex-1 flex-col justify-center">
                  <p className="font-medium text-gray-900 break-words">{p.name}</p>
                  {p.description && <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">{p.description}</p>}
                </Link>
                {manager && (
                  <button
                    type="button"
                    onClick={() => void detach(p.podId, p.name)}
                    className="flex min-h-[44px] min-w-[44px] items-center justify-center text-gray-400 hover:text-red-500"
                    title="Detach from circle"
                    aria-label={`Detach ${p.name} from this circle`}
                  ><X className="h-4 w-4" /></button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
      <CreatePodModal open={sheet === 'new'} onClose={() => setSheet(null)} circle={{ id: circle.id, name: circle.name }} />
      {sheet === 'attach' && (
        <AttachPodSheet circleId={circle.id} circleName={circle.name} onClose={() => setSheet(null)} onCreate={() => setSheet('new')} />
      )}
      {confirmDialog}
    </div>
  );
}
