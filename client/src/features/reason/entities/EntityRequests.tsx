// client/src/features/reason/entities/EntityRequests.tsx
// "Requests" (30 Oct review, 7.2: "the owner should approve it"), for the entity's admins and platform admins only:
// the people who say they are part of it, and the active members who asked to change their role, oldest first, each
// with Approve and Decline. A bell's link (?requests=1) opens the page here. The list is the page's own (entity:<id>),
// so it follows a new request, or another admin's answer, without a reload. On a phone each row is two lines, with
// the two 44px buttons on their own row.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { EntityPage, EntityRequest } from '@rsn/shared';
import Avatar from '@/components/ui/Avatar';
import { useToastStore } from '@/stores/toastStore';
import { statusOf } from '../human/profile-text';
import { personName } from '../person';
import { approveEntityMember, declineEntityMember, entityKeys } from './entity-api';
import { approvedToast, declinedToast, entityError, requestLine } from './entity-text';
import { PRIMARY_BUTTON, QUIET_BUTTON } from './look';

interface Props {
  page: EntityPage;
  /** Opened from a bell (?requests=1): scrolled to and focused once. */
  focus: boolean;
}

export default function EntityRequests({ page, focus }: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  // Whose request is being answered, so only that row is busy and a second press does nothing.
  const [answering, setAnswering] = useState<string | null>(null);
  // A ref as well: a double tap lands before React draws the buttons as disabled.
  const busy = useRef(false);
  const { entity } = page;
  const requests = page.requests ?? [];
  const count = page.requestCount ?? requests.length;

  useEffect(() => {
    if (!focus || !heading.current) return;
    heading.current.scrollIntoView({ block: 'start' });
    heading.current.focus({ preventScroll: true });
  }, [focus]);

  const answer = useMutation({
    networkMode: 'always',
    mutationFn: ({ person, approve }: { person: EntityRequest; approve: boolean }) =>
      (approve ? approveEntityMember : declineEntityMember)(entity.id, person.id),
    onSuccess: (_r, { person, approve }) => {
      const name = personName(person.displayName);
      addToast(approve ? approvedToast(name, entity.name) : declinedToast(name), 'success');
      return qc.invalidateQueries({ queryKey: entityKeys.all });
    },
    onError: (err) => {
      addToast(entityError(err, 'Could not answer that request just now. Try again in a moment.'), 'error');
      // Answered already (another admin, another tab): the page catches up.
      return statusOf(err) === 404 ? qc.invalidateQueries({ queryKey: entityKeys.page(entity.id) }) : undefined;
    },
    onSettled: () => { busy.current = false; setAnswering(null); },
  });
  const press = (person: EntityRequest, approve: boolean) => {
    if (busy.current) return;
    busy.current = true;
    setAnswering(person.id);
    answer.mutate({ person, approve });
  };

  if (!page.canEdit) return null;
  return (
    <section aria-labelledby="entity-requests-title" data-testid="entity-requests" className="mt-[11px] min-w-0 rounded-[19px] border border-reason-line bg-white p-[17px] md:mt-[18px] md:rounded-[24px] md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 ref={heading} tabIndex={-1} id="entity-requests-title" className="scroll-mt-[calc(84px+env(safe-area-inset-top))] text-[22px] font-bold tracking-[-0.035em] outline-none md:text-[24px]">Requests</h2>
          <p className="mt-1 text-[13px] text-reason-muted">People who say they are part of {entity.name}. Only the people you approve are listed.</p>
        </div>
        <span className="rounded-full bg-[#f2f3f5] px-2.5 py-1.5 text-[11px] font-extrabold text-[#555d69]">{count === 1 ? '1 waiting' : `${count} waiting`}</span>
      </div>
      {requests.length === 0 ? (
        <p className="mt-3.5 rounded-2xl bg-reason-soft p-3.5 text-[13px] text-[#646a77]">No one is waiting for an answer.</p>
      ) : (
        <ul className="mt-3.5 grid gap-2.5">
          {requests.map((r) => {
            const name = personName(r.displayName);
            const busy = answering === r.id;
            return (
              <li key={r.id} data-request-id={r.id} className="grid gap-3 rounded-[18px] border border-reason-line p-[13px] md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                <Link to={`/people/${r.id}`} className="grid min-h-[44px] min-w-0 grid-cols-[44px_minmax(0,1fr)] items-center gap-2.5">
                  <span aria-hidden="true" className="flex">
                    <Avatar src={r.avatarUrl} name={name} size="lg" className="h-11 w-11 rounded-[12px] text-[15px]" />
                  </span>
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    <b className="block text-[15px] leading-tight">{name}</b>
                    <span className="mt-0.5 block text-[12px] text-reason-muted">{requestLine(r)}</span>
                  </span>
                </Link>
                <div className="grid grid-cols-2 gap-2 md:flex">
                  <button type="button" onClick={() => press(r, true)} disabled={!!answering} className={PRIMARY_BUTTON}>
                    {busy && answer.variables?.approve ? 'Approving…' : 'Approve'}
                  </button>
                  <button type="button" onClick={() => press(r, false)} disabled={!!answering} className={QUIET_BUTTON}>
                    {busy && answer.variables?.approve === false ? 'Declining…' : 'Decline'}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {requests.length < count && <p className="mt-3 text-[12px] text-reason-muted">Showing the first {requests.length} of {count}.</p>}
    </section>
  );
}
