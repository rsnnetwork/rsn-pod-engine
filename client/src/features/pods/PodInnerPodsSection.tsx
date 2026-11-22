// ─── "Pods inside" on a main pod's page (Stefan, 22 Nov 2026) ─────────────────────────────────────────────────────
// Circle > main pod > the pods inside it > events. The pods inside this one that the viewer may see (the server leaves
// out a private pod they are not in), each with its member count and a link. Its director (or a platform admin) also
// creates a pod inside, puts one of their own pods inside, takes one out (asked first) and chooses whether people must
// be members of this pod to join its pods. Shown when there are pods to see, or when the viewer may add one; never on a
// pod that is itself inside another (one level only).
import { Link } from 'react-router-dom';
import { Layers, Plus, FolderInput } from 'lucide-react';
import { useState } from 'react';
import type { InnerPodItem } from '@rsn/shared';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Spinner';
import { useConfirm } from '@/hooks/useConfirm';
import CreatePodModal from './CreatePodModal';
import MovePodSheet from './MovePodSheet';
import InnerPodsMembersOnlySwitch from './InnerPodsMembersOnlySwitch';
import { podStatusLabel } from './pod-header-text';
import { NESTED_COPY, nestedPodActions, takeOutQuestion, type PodNestingView } from './nested-pods-view';
import { useInnerPods, useTakePodOut } from './useNestedPods';

interface Props {
  pod: PodNestingView & { id: string; name: string };
  directsPod: boolean;
  platformAdmin: boolean;
}

export default function PodInnerPodsSection({ pod, directsPod, platformAdmin }: Props) {
  const actions = nestedPodActions(pod, { directsPod, platformAdmin });
  const inner = useInnerPods(pod.id, actions.showSection);
  const takeOut = useTakePodOut();
  const { ask, confirmDialog } = useConfirm();
  const [createOpen, setCreateOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const main = { id: pod.id, name: pod.name };

  if (!actions.showSection) return null;

  const askTakeOut = async (item: InnerPodItem) => {
    if (takeOut.isPending) return;
    const q = takeOutQuestion(item.name, pod.name);
    if (!(await ask({ ...q, confirmLabel: NESTED_COPY.takeOut, tone: 'danger' }))) return;
    takeOut.mutate({ id: item.id, name: item.name, parentPodId: pod.id });
  };

  const list = inner.data;
  return (
    <section id="pod-inner-pods" className="min-w-0 scroll-mt-4 animate-fade-in-up" data-testid="pod-inner-pods">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-[#1a1a2e]">
          <Layers className="h-5 w-5 text-rsn-red" /> {NESTED_COPY.sectionTitle}{list ? ` (${list.length})` : ''}
        </h2>
        {(actions.createInside || actions.putInside) && (
          <div className="flex flex-wrap gap-2">
            {actions.createInside && (
              <Button variant="secondary" onClick={() => setCreateOpen(true)} data-testid="pod-inner-create">
                <Plus className="mr-2 h-4 w-4" /> {NESTED_COPY.createInside}
              </Button>
            )}
            {actions.putInside && (
              <Button variant="outline" onClick={() => setMoveOpen(true)} data-testid="pod-inner-put">
                <FolderInput className="mr-2 h-4 w-4" /> {NESTED_COPY.putInside}
              </Button>
            )}
          </div>
        )}
      </div>

      {actions.setMembersOnly && (
        <div className="mb-3">
          <InnerPodsMembersOnlySwitch main={main} on={!!pod.innerPodsMembersOnly} />
        </div>
      )}

      {inner.isError && !list ? (
        <Card className="!p-4 text-center">
          <p className="text-sm text-gray-600">{NESTED_COPY.loadFailed}</p>
          <Button variant="ghost" onClick={() => void inner.refetch()} className="mx-auto mt-2">{NESTED_COPY.tryAgain}</Button>
        </Card>
      ) : !list ? (
        <div className="grid gap-2"><Skeleton className="h-16" /><Skeleton className="h-16" /></div>
      ) : list.length === 0 ? (
        <Card className="!p-4">
          <p className="text-center text-sm text-gray-500" data-testid="pod-inner-empty">
            {actions.createInside ? NESTED_COPY.emptyForDirector : NESTED_COPY.empty}
          </p>
        </Card>
      ) : (
        <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {list.map((item) => (
            <li key={item.id} className="min-w-0" data-testid={`pod-inner-row-${item.id}`}>
              <Card className="!p-3">
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <Link to={`/pods/${item.id}`} className="flex min-h-[44px] min-w-0 flex-1 flex-col justify-center hover:opacity-80">
                    <span className="break-words text-sm font-medium text-[#1a1a2e]">{item.name}</span>
                    <span className="text-xs text-gray-500">
                      {item.memberCount} {item.memberCount === 1 ? 'member' : 'members'} · {item.sessionCount} {item.sessionCount === 1 ? 'event' : 'events'}
                    </span>
                  </Link>
                  {item.status !== 'active' && <Badge className="shrink-0">{podStatusLabel(item.status)}</Badge>}
                  {item.mayTakeOut && (
                    <Button
                      variant="ghost"
                      className="shrink-0"
                      disabled={takeOut.isPending}
                      isLoading={takeOut.isPending && takeOut.variables?.id === item.id}
                      onClick={() => void askTakeOut(item)}
                      aria-label={`Take ${item.name} out of ${pod.name}`}
                      data-testid={`pod-inner-takeout-${item.id}`}
                    >
                      {NESTED_COPY.takeOut}
                    </Button>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <CreatePodModal open={createOpen} onClose={() => setCreateOpen(false)} parent={main} />
      <MovePodSheet open={moveOpen} onClose={() => setMoveOpen(false)} main={main} />
      {confirmDialog}
    </section>
  );
}
