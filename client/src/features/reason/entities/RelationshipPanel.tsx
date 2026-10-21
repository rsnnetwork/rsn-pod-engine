// client/src/features/reason/entities/RelationshipPanel.tsx
// "Your relationship" (the v4 prototype's pink panel beside the entity): your role and title with [Change] and
// [Leave], or [Join] with a role. Leaving asks first, and says so when you are the only person here (the entity is
// archived with you).
import { useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ENTITY_ROLES, ENTITY_ROLE_LABELS, type EntityPage, type EntityRole } from '@rsn/shared';
import { cn } from '@/lib/utils';
import { useToastStore } from '@/stores/toastStore';
import { statusOf } from '../human/profile-text';
import ConfirmSheet from './ConfirmSheet';
import RoleSheet from './RoleSheet';
import { entityKeys, leaveEntity, setMyEntityRole } from './entity-api';
import { entityError, joinedToast, leftToast, roleLabel } from './entity-text';
import { PRIMARY_BUTTON, QUIET_BUTTON } from './look';

const KICKER = 'text-[10px] font-extrabold uppercase tracking-[0.14em] text-reason-red-hover md:text-[11px]';
// The prototype's own brown for text on the pink, 7.5:1 (the app's muted grey is 4.3:1 there).
const ON_PINK = 'text-[#5e4a48]';

interface Props {
  page: EntityPage;
  me: string | undefined;
  /** A leave is on its way and may archive the entity: the page stops asking for itself until it is answered. */
  onClosing: (closing: boolean) => void;
}

export default function RelationshipPanel({ page, me, onClosing }: Props) {
  const { entity, myRole } = page;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const addToast = useToastStore((s) => s.addToast);
  const roleId = useId();
  const hintId = useId();
  const [joinAs, setJoinAs] = useState<EntityRole | ''>('');
  const [changing, setChanging] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  // Refs, not isPending: a double tap lands before React draws the button as disabled.
  const busy = useRef(false);
  const mine = page.people.find((p) => p.id === me);
  // The only person here: leaving archives it (the server's rule), so the sheet says so first.
  const lastOne = myRole !== null && entity.peopleCount <= 1;

  const join = useMutation({
    networkMode: 'always',
    mutationFn: (role: EntityRole) => setMyEntityRole(entity.id, role),
    onSuccess: (result) => {
      addToast(joinedToast(entity.name, result.companyUpdated), 'success');
      setJoinAs('');
      return qc.invalidateQueries({ queryKey: entityKeys.all });
    },
    onError: (err) => {
      addToast(entityError(err, 'Could not join it just now. Try again in a moment.'), 'error');
      return statusOf(err) === 404 ? qc.invalidateQueries({ queryKey: entityKeys.page(entity.id) }) : undefined;
    },
    onSettled: () => { busy.current = false; },
  });

  // Whether the leave archives it is the server's answer (it can know of people this page cannot show), so the page
  // stops asking for itself for every leave, and asks again (it is stale by then) when the member stays.
  const leave = useMutation({
    networkMode: 'always',
    mutationFn: () => leaveEntity(entity.id),
    onMutate: () => onClosing(true),
    onSuccess: (result) => {
      addToast(leftToast(entity.name, result.archived), 'success');
      setLeaving(false);
      // Archived with you: its page is closed now, so the page you are on is the list.
      if (result.archived) navigate('/entities', { replace: true });
      else onClosing(false);
      return qc.invalidateQueries({ queryKey: entityKeys.all });
    },
    onError: (err) => {
      onClosing(false);
      setLeaveError(entityError(err, 'Could not leave it just now. Try again in a moment.'));
      return statusOf(err) === 404 ? qc.invalidateQueries({ queryKey: entityKeys.page(entity.id) }) : undefined;
    },
    onSettled: () => { busy.current = false; },
  });

  const pressJoin = () => {
    if (!joinAs || busy.current) return;
    busy.current = true;
    join.mutate(joinAs);
  };
  const pressLeave = () => {
    if (busy.current) return;
    busy.current = true;
    setLeaveError(null);
    leave.mutate();
  };

  return (
    <aside aria-labelledby={`${roleId}-title`} className="flex min-w-0 flex-col rounded-[21px] border border-[#ffd8d4] bg-reason-pink p-[18px] md:rounded-[26px] md:p-[26px]">
      <p className={KICKER}>Your relationship</p>
      {myRole ? (
        <>
          <h2 id={`${roleId}-title`} className="mt-3 text-[26px] font-bold leading-[1.06] tracking-[-0.045em] [overflow-wrap:anywhere] md:text-[29px]">{roleLabel(myRole)}</h2>
          <p className={cn('mt-2 text-[14px] leading-relaxed [overflow-wrap:anywhere]', ON_PINK)}>
            {mine?.title ? `Your title here: ${mine.title}.` : 'You have not added a title here.'}
            {mine?.isAdmin ? ' You look after this page.' : ''}
          </p>
          <div className="mt-[18px] grid grid-cols-2 gap-2 md:mt-auto md:pt-[22px]">
            <button type="button" onClick={() => setChanging(true)} className={QUIET_BUTTON}>Change</button>
            <button type="button" onClick={() => { setLeaveError(null); setLeaving(true); }} className={QUIET_BUTTON}>Leave</button>
          </div>
        </>
      ) : (
        <>
          <h2 id={`${roleId}-title`} className="mt-3 text-[24px] font-bold leading-[1.08] tracking-[-0.04em] [overflow-wrap:anywhere] md:text-[27px]">Are you part of {entity.name}?</h2>
          <p className={cn('mt-2 text-[14px] leading-relaxed', ON_PINK)}>Join it with your role, and you are listed among its people.</p>
          <div className="mt-[18px] grid gap-1.5 md:mt-auto md:pt-[22px]">
            <label htmlFor={roleId} className="text-[12px] font-bold">Your role</label>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
              <select
                id={roleId}
                value={joinAs}
                onChange={(e) => setJoinAs(e.target.value as EntityRole | '')}
                className="min-h-[44px] w-full min-w-0 rounded-[11px] border border-[#ffd4d0] bg-white px-3 text-[16px] outline-none focus:border-[#cfd2d8] md:text-[14px]"
              >
                <option value="">Choose your role</option>
                {ENTITY_ROLES.map((r) => <option key={r} value={r}>{ENTITY_ROLE_LABELS[r]}</option>)}
              </select>
              <button type="button" onClick={pressJoin} disabled={!joinAs || join.isPending} aria-describedby={joinAs ? undefined : hintId} className={PRIMARY_BUTTON}>
                {join.isPending ? 'Joining…' : 'Join'}
              </button>
            </div>
            {!joinAs && <p id={hintId} className={cn('text-[12px]', ON_PINK)}>Choose your role first.</p>}
          </div>
        </>
      )}

      {changing && myRole && (
        <RoleSheet entityId={entity.id} entityName={entity.name} role={myRole} title={mine?.title ?? null} onClose={() => setChanging(false)} />
      )}
      <ConfirmSheet
        open={leaving}
        title={`Leave ${entity.name}?`}
        text={lastOne
          ? `You are the only person here. If you leave, ${entity.name} is archived: it leaves every list, its page closes, and its name is free again.`
          : 'You are no longer listed among its people. You can join again at any time.'}
        confirmLabel="Leave"
        busyLabel="Leaving…"
        busy={leave.isPending}
        error={leaveError}
        onConfirm={pressLeave}
        onClose={() => setLeaving(false)}
      />
    </aside>
  );
}
