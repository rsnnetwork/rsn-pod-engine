import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { Loader2, LogOut, UserPlus } from 'lucide-react';
import type { DmGroupDetail, DmGroupMember } from '@rsn/shared';
import Avatar from '@/components/ui/Avatar';
import Sheet from '@/features/reason/ui/Sheet';
import { personHref } from '@/features/reason/human/profile-text';
import { formResolver } from '@/lib/form-resolver';
import { useToastStore } from '@/stores/toastStore';
import { TEXT_BUTTON } from './buttons';
import PeopleChoices from './PeopleChoices';
import { useAddGroupMembers, useEventPeople, useLeaveGroup, useRemoveGroupMember } from './useGroups';
import {
  ADD_FAILED, ADD_PEOPLE, ADD_TITLE, ADMIN, CANCEL, EVERYONE_IN, FORMER_MEMBER, GROUP_FULL, GROUP_LIMIT, LEAVE,
  LEAVE_FAILED, LEAVE_WARNING, MEMBERS_TITLE, PEOPLE_FAILED, PEOPLE_LEGEND, REMOVE, REMOVE_FAILED, TRY_AGAIN, YOU,
  addLabel, addSchema, addedSentence, byName, groupErrorSentence, leftSentence, membersInOrder, ofMax, removeAsk,
  removedSentence, roomLeft, tookPart, type AddValues,
} from './group-chat-text';

// ─── A group chat's members (26 Oct 2026, C12, COM-04) ───
//
// Opened from the group's header: who is in it, "{n} of 50" and that group chats hold up to 50 people; Leave for
// everyone, asked first; and for the group's admin, Remove beside each other member and "Add people" who took part in
// the group's event, never past 50. Every change shows in every member's open screens through dm-group:<id>.
// The REASON sheet: a bottom sheet on a phone, portalled to the page.

const QUIET = `${TEXT_BUTTON} border border-gray-300 bg-white text-gray-700 hover:bg-gray-50`;
const DANGER = `${TEXT_BUTTON} bg-red-600 text-white hover:bg-red-700`;

interface Props {
  open: boolean;
  onClose: () => void;
  group: DmGroupDetail;
  myUserId: string;
}

export default function GroupMembersSheet({ open, onClose, group, myUserId }: Props) {
  const navigate = useNavigate();
  const addToast = useToastStore((s) => s.addToast);
  const leave = useLeaveGroup(group.id);
  const isAdmin = group.myRole === 'admin';
  const [askLeave, setAskLeave] = useState(false);
  const [leaveProblem, setLeaveProblem] = useState<string | null>(null);

  const close = () => {
    if (leave.isPending) return;
    setAskLeave(false);
    setLeaveProblem(null);
    onClose();
  };
  const doLeave = () => {
    setLeaveProblem(null);
    leave.mutate(undefined, {
      onSuccess: () => {
        onClose();
        navigate('/messages', { replace: true });
        addToast(leftSentence(group.name), 'success');
      },
      onError: (err) => setLeaveProblem(groupErrorSentence(err, LEAVE_FAILED)),
    });
  };

  const footer = askLeave ? (
    <div className="w-full" data-testid="leave-confirm">
      <p className="text-sm text-gray-700">{LEAVE_WARNING}</p>
      {leaveProblem && <p role="alert" className="mt-1 text-sm text-red-600">{leaveProblem}</p>}
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={() => { setAskLeave(false); setLeaveProblem(null); }} disabled={leave.isPending} className={QUIET}>
          {CANCEL}
        </button>
        <button type="button" onClick={doLeave} disabled={leave.isPending} className={DANGER}>
          {leave.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {LEAVE}
        </button>
      </div>
    </div>
  ) : (
    <button type="button" onClick={() => setAskLeave(true)} className={`${TEXT_BUTTON} border border-red-200 bg-white text-red-600 hover:bg-red-50`}>
      <LogOut className="h-4 w-4" aria-hidden="true" /> {LEAVE}
    </button>
  );

  return (
    <Sheet open={open} onClose={close} title={MEMBERS_TITLE} footer={footer}>
      <p data-testid="group-members-count" className="text-sm font-semibold text-[#1a1a2e]">{ofMax(group.memberCount)}</p>
      <p className="mt-0.5 text-sm text-gray-500">{GROUP_LIMIT}</p>
      <ul data-testid="group-members" className="mt-3 divide-y divide-gray-100">
        {membersInOrder(group.members).map((m) => (
          <MemberRow key={m.userId} groupId={group.id} member={m} myUserId={myUserId} canRemove={isAdmin && m.userId !== myUserId} />
        ))}
      </ul>
      {isAdmin && group.type === 'event' && group.sessionId && (
        <AddPeople group={group} sessionId={group.sessionId} myUserId={myUserId} />
      )}
    </Sheet>
  );
}

function Tag({ children }: { children: ReactNode }) {
  return <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-600">{children}</span>;
}

/** One member: their profile (not for yourself, nor a closed account), their role, and for the admin, Remove (asked first). */
function MemberRow({ groupId, member, myUserId, canRemove }: { groupId: string; member: DmGroupMember; myUserId: string; canRemove: boolean }) {
  const remove = useRemoveGroupMember(groupId);
  const addToast = useToastStore((s) => s.addToast);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const me = member.userId === myUserId;
  const linkable = !me && member.displayName !== FORMER_MEMBER;

  const doRemove = () => {
    setProblem(null);
    remove.mutate(member.userId, {
      onSuccess: () => {
        setAsking(false);
        addToast(removedSentence(member.displayName), 'success');
      },
      onError: (err) => setProblem(groupErrorSentence(err, REMOVE_FAILED)),
    });
  };

  const who = (
    <>
      <Avatar src={member.avatarUrl} name={member.displayName} size="sm" className="shrink-0" />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-[#1a1a2e]">{member.displayName}</span>
        {(member.role === 'admin' || me) && (
          <span className="mt-0.5 flex gap-1.5">
            {member.role === 'admin' && <Tag>{ADMIN}</Tag>}
            {me && <Tag>{YOU}</Tag>}
          </span>
        )}
      </span>
    </>
  );

  return (
    <li data-testid="group-member" className="py-1.5">
      <div className="flex items-center gap-2">
        {linkable ? (
          <Link to={personHref(member.userId, 'Messages')} className="flex min-h-[44px] min-w-0 flex-1 items-center gap-3 rounded-lg hover:bg-gray-50">
            {who}
          </Link>
        ) : (
          <div className="flex min-h-[44px] min-w-0 flex-1 items-center gap-3">{who}</div>
        )}
        {canRemove && !asking && (
          <button type="button" onClick={() => setAsking(true)} className={`${QUIET} shrink-0 px-3`}>{REMOVE}</button>
        )}
      </div>
      {asking && (
        <div className="mt-1 flex flex-wrap items-center justify-end gap-2">
          <p className="mr-auto min-w-0 text-sm text-gray-700 [overflow-wrap:anywhere]">{removeAsk(member.displayName)}</p>
          <button type="button" onClick={() => { setAsking(false); setProblem(null); }} disabled={remove.isPending} className={QUIET}>
            {CANCEL}
          </button>
          <button type="button" onClick={doRemove} disabled={remove.isPending} className={DANGER}>
            {remove.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {REMOVE}
          </button>
        </div>
      )}
      {problem && <p role="alert" className="mt-1 text-sm text-red-600">{problem}</p>}
    </li>
  );
}

/** The admin adds people who took part in the group's event. A full group says so instead. */
function AddPeople({ group, sessionId, myUserId }: { group: DmGroupDetail; sessionId: string; myUserId: string }) {
  const [open, setOpen] = useState(false);
  const full = roomLeft(group.memberCount, 0) === 0;
  return (
    <section aria-labelledby="add-people-title" className="mt-4 border-t border-gray-100 pt-4">
      <h3 id="add-people-title" className="text-sm font-semibold text-[#1a1a2e]">{ADD_TITLE}</h3>
      {full ? (
        <p data-testid="group-full" className="mt-1 text-sm text-gray-600">{GROUP_FULL}</p>
      ) : open ? (
        <AddPeopleList group={group} sessionId={sessionId} myUserId={myUserId} onDone={() => setOpen(false)} />
      ) : (
        <button type="button" onClick={() => setOpen(true)} className={`${QUIET} mt-2 w-full sm:w-auto`}>
          <UserPlus className="h-4 w-4" aria-hidden="true" /> {ADD_PEOPLE}
        </button>
      )}
    </section>
  );
}

function AddPeopleList({ group, sessionId, myUserId, onDone }: { group: DmGroupDetail; sessionId: string; myUserId: string; onDone: () => void }) {
  const people = useEventPeople(sessionId);
  if (people.isPending) {
    return (
      <div data-testid="add-people-loading" aria-busy="true" className="mt-2 space-y-2">
        {[0, 1, 2].map((i) => <div key={i} className="h-11 animate-pulse rounded-xl bg-gray-100" />)}
      </div>
    );
  }
  if (people.isError) {
    return (
      <div className="mt-2">
        <p className="text-sm text-gray-700">{PEOPLE_FAILED}</p>
        <button type="button" onClick={() => { void people.refetch(); }} className={`${QUIET} mt-2`}>{TRY_AGAIN}</button>
      </div>
    );
  }
  const candidates = byName(tookPart(people.data, [myUserId, ...group.members.map((m) => m.userId)]));
  if (candidates.length === 0) return <p className="mt-1 text-sm text-gray-600">{EVERYONE_IN}</p>;
  return <AddPeopleForm group={group} candidates={candidates} onDone={onDone} />;
}

function AddPeopleForm({ group, candidates, onDone }: { group: DmGroupDetail; candidates: ReturnType<typeof tookPart>; onDone: () => void }) {
  const add = useAddGroupMembers(group.id);
  const addToast = useToastStore((s) => s.addToast);
  const [refusal, setRefusal] = useState<string | null>(null);
  const { register, handleSubmit, watch } = useForm<AddValues>({
    defaultValues: { userIds: [] },
    resolver: formResolver(addSchema),
  });
  const chosen = watch('userIds') ?? [];
  const room = roomLeft(group.memberCount, chosen.length);

  const submit = handleSubmit(({ userIds }) => {
    setRefusal(null);
    add.mutate(userIds, {
      onSuccess: (result) => {
        addToast(addedSentence(result.added.length), 'success');
        onDone();
      },
      onError: (err) => setRefusal(groupErrorSentence(err, ADD_FAILED)),
    });
  });

  return (
    <form onSubmit={submit} noValidate className="mt-2" data-testid="add-people-form">
      <PeopleChoices legend={PEOPLE_LEGEND} legendHidden people={candidates} chosen={chosen} room={room} field={register('userIds')} />
      {/* The choice has filled the group: the boxes not ticked are off, and this says why. */}
      {room === 0 && <p data-testid="add-people-full" className="mt-2 text-sm text-gray-600">{GROUP_FULL}</p>}
      {refusal && <p role="alert" className="mt-2 text-sm text-red-600">{refusal}</p>}
      <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" onClick={onDone} disabled={add.isPending} className={QUIET}>{CANCEL}</button>
        <button type="submit" disabled={chosen.length === 0 || add.isPending} className={`${TEXT_BUTTON} bg-rsn-red text-white hover:bg-rsn-red-hover`}>
          {add.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {chosen.length > 0 ? addLabel(chosen.length) : ADD_PEOPLE}
        </button>
      </div>
    </form>
  );
}
