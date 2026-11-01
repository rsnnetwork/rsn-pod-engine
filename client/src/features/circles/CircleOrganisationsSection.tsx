// ─── A circle's organisations (T15, 1 Nov 2026; 30 Oct review 7.3: "An entity should be linkable to one or more Circles")
// Everyone who may see the circle sees the entities linked to it, drawn as the Entities pages draw a person's entities
// (EntityRows, with each logo). The people who run it (canManage) get "Link an entity" (a search sheet) and an Unlink
// beside each, which asks first. A locked circle shows none (the page leaves this section out). The page's own query
// follows circle:<id>, which a link and an unlink send, so the list changes without a reload on every screen.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Building2, Link2, Loader2, X } from 'lucide-react';
import Card from '@/components/ui/Card';
import api from '@/lib/api';
import { useConfirm } from '@/hooks/useConfirm';
import { useToastStore } from '@/stores/toastStore';
import EntityRows from '@/features/reason/entities/EntityRows';
import { entityKeys } from '@/features/reason/entities/entity-api';
import LinkEntitySheet from './LinkEntitySheet';
import { LINK_ENTITY, ORGANISATIONS, ORGANISATIONS_EMPTY, unlinkedToast, type CircleDetail } from './circle-logic';
import { circleErrorSentence, refreshCircle } from './useCircleActions';

const ACTION = 'inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-gray-200 px-3 text-sm font-medium text-[#1a1a2e] hover:bg-gray-50';

export default function CircleOrganisationsSection({ circle }: { circle: CircleDetail }) {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const { ask, confirmDialog } = useConfirm();
  const [linking, setLinking] = useState(false);
  const manager = !!circle.canManage;
  const entities = circle.entities ?? [];
  // As the members' Remove does it (CircleMembersSection): one mutation, a second press refused while one is on its
  // way (before the confirm opens), and the row's button busy until the circle is read again.
  const unlinking = useMutation({
    networkMode: 'always',
    mutationFn: ({ entityId }: { entityId: string; name: string }) => api.delete(`/circles/${circle.id}/entities/${entityId}`),
    onSuccess: async (_res, { name }) => {
      await Promise.all([refreshCircle(qc, circle.id), qc.invalidateQueries({ queryKey: entityKeys.all })]);
      addToast(unlinkedToast(name, circle.name), 'success');
    },
    onError: (err) => addToast(circleErrorSentence(err, 'That organisation could not be unlinked. Try again.'), 'error'),
  });
  // Every hook above runs on every render; only then does a member with nothing to see get nothing.
  if (entities.length === 0 && !manager) return null;

  const unlink = async (entityId: string, name: string) => {
    if (unlinking.isPending) return;
    if (!(await ask({ title: `Unlink ${name}?`, body: `It leaves ${circle.name}'s organisations. The entity itself is untouched.`, confirmLabel: 'Unlink', tone: 'danger' }))) return;
    unlinking.mutate({ entityId, name });
  };

  return (
    <div className="space-y-2 animate-fade-in-up" data-testid="circle-organisations">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
          <Building2 className="h-4 w-4 text-rsn-red" aria-hidden="true" /> {ORGANISATIONS}
        </h2>
        {manager && (
          <button type="button" onClick={() => setLinking(true)} className={ACTION} data-testid="circle-link-entity">
            <Link2 className="h-4 w-4" aria-hidden="true" /> {LINK_ENTITY}
          </button>
        )}
      </div>
      {entities.length === 0 ? (
        <Card><p className="text-sm text-gray-500 text-center py-2">{ORGANISATIONS_EMPTY}</p></Card>
      ) : (
        <Card className="!p-3">
          <EntityRows
            entities={entities}
            trailing={manager ? (e) => (
              <button
                type="button"
                onClick={() => void unlink(e.id, e.name)}
                disabled={unlinking.isPending}
                aria-busy={unlinking.isPending && unlinking.variables?.entityId === e.id}
                className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-gray-400 hover:bg-gray-50 hover:text-red-500 disabled:opacity-50"
                title="Unlink from circle"
                aria-label={`Unlink ${e.name} from this circle`}
              >
                {unlinking.isPending && unlinking.variables?.entityId === e.id
                  ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  : <X className="h-4 w-4" aria-hidden="true" />}
              </button>
            ) : undefined}
          />
        </Card>
      )}
      {linking && (
        <LinkEntitySheet circleId={circle.id} circleName={circle.name} linked={entities.map((e) => e.id)} onClose={() => setLinking(false)} />
      )}
      {confirmDialog}
    </div>
  );
}
