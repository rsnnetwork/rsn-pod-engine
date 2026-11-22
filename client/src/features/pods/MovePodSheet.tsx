// ─── "Put one of your pods inside" (Stefan, 22 Nov 2026) ──────────────────────────────────────────────────────────
// A sheet (a bottom sheet on phones, a dialog from 768px) listing the pods the viewer directs that could go inside this
// main pod: not archived, not inside another pod and holding none (the server lists only those, and checks again under
// a lock). Choosing one puts it inside and closes the sheet; a refusal says why in the server's words.
import Sheet from '@/features/reason/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Spinner';
import { NESTED_COPY } from './nested-pods-view';
import { useInnerPodCandidates, usePutPodInside } from './useNestedPods';

interface Props { open: boolean; onClose: () => void; main: { id: string; name: string } }

export default function MovePodSheet({ open, onClose, main }: Props) {
  if (!open) return null;
  return <MovePodSheetBody onClose={onClose} main={main} />;
}

function MovePodSheetBody({ onClose, main }: Omit<Props, 'open'>) {
  const candidates = useInnerPodCandidates(main.id, true);
  const put = usePutPodInside(main);
  const close = () => { if (!put.isPending) onClose(); };

  return (
    <Sheet open onClose={close} title={NESTED_COPY.pickerTitle}>
      <div className="space-y-2 pb-2 pt-3" data-testid="pod-move-sheet">
        <p className="break-words text-sm text-gray-500">It goes inside {main.name} and keeps its members, settings, discussion and events.</p>
        {candidates.isError && !candidates.data ? (
          <div className="rounded-xl border border-gray-200 p-4 text-center">
            <p className="text-sm text-gray-600">{NESTED_COPY.pickerFailed}</p>
            <Button variant="ghost" onClick={() => void candidates.refetch()} className="mx-auto mt-2">{NESTED_COPY.tryAgain}</Button>
          </div>
        ) : !candidates.data ? (
          <div className="space-y-2"><Skeleton className="h-14" /><Skeleton className="h-14" /></div>
        ) : candidates.data.length === 0 ? (
          <p className="rounded-xl border border-dashed border-gray-200 p-4 text-sm text-gray-500" data-testid="pod-move-empty">
            {NESTED_COPY.pickerEmpty}
          </p>
        ) : (
          <ul className="space-y-2">
            {candidates.data.map((pod) => (
              <li key={pod.id} className="flex min-w-0 items-center justify-between gap-3 rounded-xl border border-gray-200 px-3 py-2">
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium text-[#1a1a2e]">{pod.name}</p>
                  <p className="text-xs text-gray-500">{pod.memberCount} {pod.memberCount === 1 ? 'member' : 'members'}</p>
                </div>
                <Button
                  size="md"
                  variant="secondary"
                  className="shrink-0"
                  disabled={put.isPending}
                  isLoading={put.isPending && put.variables?.id === pod.id}
                  onClick={() => put.mutate(pod, { onSuccess: onClose })}
                  data-testid={`pod-move-pick-${pod.id}`}
                >
                  {NESTED_COPY.pickerAction}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Sheet>
  );
}
