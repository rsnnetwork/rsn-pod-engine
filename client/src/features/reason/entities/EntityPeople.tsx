// client/src/features/reason/entities/EntityPeople.tsx
// "People around this entity": people first, the entity is their context (the v4 prototype's entity-person cards).
// Each card opens the person's Human Profile, with their role and title here.
// 30 Oct review (T15, 7.2: "be able to remove members"): the entity's admins see Remove under each card, which asks
// first. Never on yourself (you leave instead) or on the last admin; an admin's card has it only for a platform admin
// (the server's own rules, said on the screen so nobody presses a button that can only refuse).
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { EntityPage, EntityPerson } from '@rsn/shared';
import Avatar from '@/components/ui/Avatar';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { statusOf } from '../human/profile-text';
import { personName } from '../person';
import { entityKeys, removeEntityMember } from './entity-api';
import { entityError, peopleCount, removedToast, roleLine } from './entity-text';

interface Props { page: EntityPage; me: string | undefined }

const REMOVE = 'inline-flex min-h-[44px] items-center justify-center rounded-[11px] px-3 text-[13px] font-bold text-reason-red-hover hover:bg-reason-pink disabled:opacity-60';

export default function EntityPeople({ page, me }: Props) {
  const { entity, people } = page;
  const role = useAuthStore((s) => s.user?.role as string | undefined);
  const platformAdmin = role === 'admin' || role === 'super_admin';
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const [asking, setAsking] = useState<EntityPerson | null>(null);
  // A ref, not isPending: a double tap on Remove lands before React draws the dialog as busy.
  const busy = useRef(false);
  const admins = people.filter((p) => p.isAdmin).length;
  const removable = (p: EntityPerson) => page.canEdit && p.id !== me && (!p.isAdmin || (platformAdmin && admins > 1));

  const remove = useMutation({
    networkMode: 'always',
    mutationFn: (p: EntityPerson) => removeEntityMember(entity.id, p.id),
    onSuccess: async (_r, p) => {
      await qc.invalidateQueries({ queryKey: entityKeys.all });
      setAsking(null);
      addToast(removedToast(personName(p.displayName), entity.name), 'success');
    },
    onError: (err) => {
      addToast(entityError(err, 'Could not remove them just now. Try again in a moment.'), 'error');
      return statusOf(err) === 404 ? qc.invalidateQueries({ queryKey: entityKeys.page(entity.id) }) : undefined;
    },
    onSettled: () => { busy.current = false; },
  });
  const pressRemove = () => {
    if (busy.current) return;
    if (!asking) return;
    busy.current = true;
    remove.mutate(asking);
  };

  return (
    <section aria-labelledby="entity-people-title" className="mt-[11px] min-w-0 rounded-[19px] border border-reason-line bg-white p-[17px] md:mt-[18px] md:rounded-[24px] md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 id="entity-people-title" className="text-[22px] font-bold tracking-[-0.035em] md:text-[24px]">People around this entity</h2>
          <p className="mt-1 text-[13px] text-reason-muted">Start with the people. Open anyone to see why they might matter to you.</p>
        </div>
        <span className="rounded-full bg-[#f2f3f5] px-2.5 py-1.5 text-[11px] font-extrabold text-[#555d69]">{peopleCount(entity.peopleCount)}</span>
      </div>

      {people.length === 0 ? (
        <p className="mt-3.5 rounded-2xl bg-reason-soft p-3.5 text-[13px] text-[#646a77]">No one is listed here yet.</p>
      ) : (
        <ul className="mt-3.5 grid grid-cols-1 gap-3 min-[721px]:grid-cols-2 min-[1200px]:grid-cols-3">
          {people.map((p) => {
            const name = personName(p.displayName);
            const you = p.id === me;
            return (
              <li key={p.id} className="min-w-0 rounded-[18px] border border-reason-line bg-white transition hover:shadow-[0_10px_28px_rgba(16,18,24,.06)]">
                <Link
                  to={you ? '/profile' : `/people/${p.id}`}
                  data-person-id={p.id}
                  className="grid min-h-[44px] grid-cols-[58px_minmax(0,1fr)_44px] items-center gap-2.5 rounded-[18px] p-[13px]"
                >
                  {/* The photo repeats the name beside it, so a screen reader skips it. */}
                  <span aria-hidden="true" className="flex">
                    <Avatar src={p.avatarUrl} name={name} size="xl" className="h-[58px] w-[58px] rounded-[14px] text-[18px]" />
                  </span>
                  <div className="min-w-0 [overflow-wrap:anywhere]">
                    <h3 className="text-[15px] font-bold leading-tight">{name}{you && <span className="font-normal text-reason-muted"> (you)</span>}</h3>
                    <p className="mt-0.5 text-[12px] text-reason-muted">{roleLine(p.role, p.title)}</p>
                    {p.isAdmin && <p className="mt-1.5 inline-flex rounded-full bg-[#f2f3f5] px-2 py-1 text-[10px] font-extrabold text-[#555d69]">Looks after this page</p>}
                  </div>
                  <span aria-hidden="true" className="grid h-11 w-11 place-items-center rounded-full border border-reason-line text-[15px]">→</span>
                </Link>
                {removable(p) && (
                  <div className="flex justify-end border-t border-[#f0f1f3] px-[13px] py-1">
                    <button type="button" onClick={() => setAsking(p)} disabled={remove.isPending} className={REMOVE} aria-label={`Remove ${name}`}>Remove</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {people.length < entity.peopleCount && (
        <p className="mt-3 text-[12px] text-reason-muted">Showing the first {people.length} of {entity.peopleCount}.</p>
      )}
      <ConfirmDialog
        open={!!asking}
        title={`Remove ${asking ? personName(asking.displayName) : ''}?`}
        body={`They are no longer listed among ${entity.name}'s people, and it leaves their profile. They can ask to join again.`}
        confirmLabel="Remove"
        tone="danger"
        busy={remove.isPending}
        busyLabel="Removing…"
        onConfirm={pressRemove}
        onCancel={() => setAsking(null)}
      />
    </section>
  );
}
