// client/src/features/reason/entities/NameTaken.tsx
// The create form's answer to a 409: another active entity already has this name. The member can open it, or join it
// with the role (and title) they chose in the form; "Join it" is the same intent as creating it ("this is my company").
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EntityRole } from '@rsn/shared';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { E } from '@/realtime/entities';
import { shouldRetry, statusOf } from '../human/profile-text';
import { entityKeys, fetchEntity, setMyEntityRole } from './entity-api';
import { entityError, joinedToast, roleLabel } from './entity-text';
import { PRIMARY_BUTTON, QUIET_BUTTON } from './look';

interface Props {
  taken: { id: string; name: string };
  role: EntityRole;
  title: string;
  /** Closes the create sheet: the member is leaving it for the entity's page. */
  onLeave: () => void;
}

export default function NameTaken({ taken, role, title, onLeave }: Props) {
  const me = useAuthStore((s) => s.user?.id as string | undefined);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const [error, setError] = useState<string | null>(null);
  const joining = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  // It appears under the name, at the top of a body that can be scrolled to its end (the website field, the keyboard up).
  useEffect(() => { box.current?.scrollIntoView({ block: 'nearest' }); }, []);

  // The entity that has the name: its own spelling, and whether the member is already linked to it. Asked for here,
  // so "Open it" also finds its page ready.
  const existing = useQuery({
    queryKey: entityKeys.page(taken.id),
    queryFn: () => fetchEntity(taken.id),
    enabled: !!me,
    retry: shouldRetry,
    meta: { entities: me ? [E.entity(taken.id), E.userEntities(me)] : [] },
  });
  const name = existing.data?.entity.name ?? taken.name;
  const linkedAs = existing.data?.myRole ?? null;
  // Archived since the 409 came back: the name is free again, and Create can be pressed again.
  const gone = existing.isError && statusOf(existing.error) === 404;

  const join = useMutation({
    networkMode: 'always',
    mutationFn: () => setMyEntityRole(taken.id, role, title.trim() || null),
    onSuccess: (result) => {
      addToast(joinedToast(name, result.companyUpdated), 'success');
      onLeave();
      navigate(`/entities/${taken.id}`);
      return qc.invalidateQueries({ queryKey: entityKeys.all });
    },
    onError: (err) => {
      setError(entityError(err, 'Could not join it just now. Try again in a moment.'));
      if (statusOf(err) === 404) return qc.invalidateQueries({ queryKey: entityKeys.page(taken.id) });
      return undefined;
    },
    onSettled: () => { joining.current = false; },
  });
  const pressJoin = () => {
    if (joining.current) return;
    joining.current = true;
    setError(null);
    join.mutate();
  };

  if (gone) {
    return (
      <div role="status" className="rounded-[14px] border border-reason-line bg-reason-soft p-3.5 text-[13px] [overflow-wrap:anywhere]">
        {taken.name} was just archived, so the name is free again. Press Create to make it yours.
      </div>
    );
  }

  return (
    <div ref={box} role="alert" className="rounded-[14px] border border-[#ffd4d0] bg-reason-pink p-3.5 [overflow-wrap:anywhere]">
      <p className="text-[14px] font-bold">There is already an entity called {name}.</p>
      <p className="mt-1 text-[12px] text-[#5e4a48]">
        {linkedAs ? `You are already linked to it, as ${roleLabel(linkedAs)}.` : `You can join it instead, as ${roleLabel(role)}.`}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link to={`/entities/${taken.id}`} onClick={onLeave} className={QUIET_BUTTON}>Open it</Link>
        {!linkedAs && (
          <button type="button" onClick={pressJoin} disabled={join.isPending} className={PRIMARY_BUTTON}>
            {join.isPending ? 'Joining…' : 'Join it'}
          </button>
        )}
      </div>
      {error && <p className="mt-2 text-[12px] text-reason-red-hover">{error}</p>}
    </div>
  );
}
