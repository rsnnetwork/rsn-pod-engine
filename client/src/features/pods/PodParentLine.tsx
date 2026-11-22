// ─── "Part of <main pod>" on a pod inside a main pod (Stefan, 22 Nov 2026) ─────────────────────────────────────────
// A link to the main pod, or "Part of a private pod" when the viewer may not see it (the server does not name it).
// The pod's director (or a platform admin) may take it out (asked first): it stands on its own again and keeps its
// members, settings, discussion and events.
import { Link } from 'react-router-dom';
import { Layers } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useConfirm } from '@/hooks/useConfirm';
import { NESTED_COPY, mayTakeOutHere, partOfLine, takeOutQuestion, type PodNestingView } from './nested-pods-view';
import { useTakePodOut } from './useNestedPods';

interface Props {
  pod: PodNestingView & { id: string; name: string };
  directsPod: boolean;
  platformAdmin: boolean;
}

export default function PodParentLine({ pod, directsPod, platformAdmin }: Props) {
  const takeOut = useTakePodOut();
  const { ask, confirmDialog } = useConfirm();
  if (!pod.parentPod && !pod.parentPodHidden) return null;
  const mainName = pod.parentPod?.name ?? null;
  const canTakeOut = mayTakeOutHere(pod, { directsPod, platformAdmin });

  const askTakeOut = async () => {
    if (takeOut.isPending) return;
    if (!(await ask({ ...takeOutQuestion(pod.name, mainName), confirmLabel: NESTED_COPY.takeOut, tone: 'danger' }))) return;
    takeOut.mutate({ id: pod.id, name: pod.name, parentPodId: pod.parentPod?.id ?? null });
  };

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 animate-fade-in-up" data-testid="pod-parent-line">
      <Layers className="h-4 w-4 shrink-0 text-rsn-red" aria-hidden />
      {pod.parentPod ? (
        <Link
          to={`/pods/${pod.parentPod.id}`}
          className="inline-flex min-h-[44px] min-w-0 items-center break-words text-sm font-medium text-[#1a1a2e] underline-offset-2 hover:underline"
          data-testid="pod-parent-link"
        >
          {partOfLine(pod.parentPod.name)}
        </Link>
      ) : (
        <span className="text-sm text-gray-600">{NESTED_COPY.hiddenParent}</span>
      )}
      {canTakeOut && (
        <Button
          variant="ghost"
          onClick={() => void askTakeOut()}
          isLoading={takeOut.isPending}
          data-testid="pod-parent-takeout"
        >
          {NESTED_COPY.takeOut}
        </Button>
      )}
      {confirmDialog}
    </div>
  );
}
