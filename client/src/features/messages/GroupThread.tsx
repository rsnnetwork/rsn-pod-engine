import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { ArrowLeft, Loader2, Send, Users } from 'lucide-react';
import type { DmGroupDetail, GroupChatMessage } from '@rsn/shared';
import Avatar from '@/components/ui/Avatar';
import Linkify from '@/components/ui/Linkify';
import { Spinner } from '@/components/ui/Spinner';
import { formResolver } from '@/lib/form-resolver';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { TEXT_BUTTON } from './buttons';
import GroupMembersSheet from './GroupMembersSheet';
import { dayHeaderLabel, sameLocalDay, timeOnly } from './message-time';
import { isGroupId, useGroup, useGroupMessages, useMarkGroupRead, useSendGroupMessage } from './useGroups';
import {
  BACK_TO_MESSAGES, EARLIER_FAILED, GROUP_EMPTY, GROUP_FAILED, GROUP_GONE, GROUP_MESSAGE_MAX, MESSAGE_PLACEHOLDER,
  MESSAGE_PLACEHOLDER_SHORT, NOT_IN_GROUP, SEND_FAILED, SHOW_EARLIER, TRY_AGAIN,
  MARK_READ_DEBOUNCE_MS, clusterGroupMessages, groupErrorSentence, groupLoadProblem, isRateLimited, newestFromOthers,
  ofMax, readMarkKey, sendSchema, threadInOrder, untilEarlierPage, type SendValues,
} from './group-chat-text';

// ─── A group chat, open in Messages (26 Oct 2026, C12, COM-04) ───
//
// The right pane of Messages at /messages/g/:groupId, laid out as a one-to-one thread is: the header (the group's name
// and "{n} of 50", which opens its members), the messages a page at a time with "Show earlier messages" above them, and
// the message box. Others' messages arrive live (dm-group:<id>). The group is marked read when it opens with something
// unread and again after a burst of newer messages from others, while the page is in front of the member, so the unread
// counts in the inbox and on the Messages badge clear without a reload.

const BACK = '-ml-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-gray-100 lg:hidden';
/** How close to the end the member must be reading for a new message to scroll into view. */
const NEAR_BOTTOM_PX = 80;

/** Whether the page is in front of the member now: a tab in the background has not been read. */
function usePageSeen(): boolean {
  const [seen, setSeen] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    const onChange = () => setSeen(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return seen;
}

export default function GroupThread({ groupId }: { groupId: string }) {
  const myUserId = useAuthStore((s) => s.user?.id as string | undefined);
  const detail = useGroup(groupId);
  const thread = useGroupMessages(groupId);
  const { mutate: markRead } = useMarkGroupRead(groupId);
  const pageSeen = usePageSeen();
  const [membersOpen, setMembersOpen] = useState(false);

  const messages = useMemo(() => threadInOrder(thread.data?.pages ?? []), [thread.data]);
  const newestOther = newestFromOthers(messages, myUserId);
  const readable = detail.isSuccess && thread.isSuccess;

  // Read when the group opens with something unread, and when someone else's newer message arrives; never from a tab in
  // the background, and once per burst (readMarkKey and MARK_READ_DEBOUNCE_MS: each mark costs the member's group reads).
  // The clean-up cancels a waiting mark when a newer message comes first, so a burst ends in one mark. A mark that fails
  // is not the member's to put right: the next one tries again, so it is not reported.
  const marked = useRef<string | null>(null);
  const unread = detail.data?.unreadCount ?? 0;
  useEffect(() => {
    const mark = readMarkKey({ loaded: readable, seen: pageSeen, unread, groupId, newestOther, marked: marked.current });
    if (!mark) return;
    const timer = window.setTimeout(() => {
      marked.current = mark;
      markRead(undefined, { onError: () => { marked.current = null; } });
    }, MARK_READ_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [readable, pageSeen, unread, groupId, newestOther, markRead]);

  // A new message at the end (or the first page) comes into view while the member reads near the end, and always when it
  // is their own; an earlier page loaded above keeps the place they were reading. The list is drawn only once the group's
  // details and its messages have both arrived, in either order: "shown" runs the first scroll then.
  const scroller = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const keepPlace = useRef<{ height: number; top: number } | null>(null);
  const pagesSeen = useRef(0);
  const pagesLength = thread.data?.pages.length ?? 0;
  const newest = messages[messages.length - 1];
  const shown = !!detail.data && !!thread.data;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const earlierPage = pagesSeen.current > 0 && pagesLength > pagesSeen.current;
    pagesSeen.current = pagesLength;
    if (earlierPage && keepPlace.current) {
      el.scrollTop = el.scrollHeight - keepPlace.current.height + keepPlace.current.top;
      keepPlace.current = null;
      return;
    }
    if (nearBottom.current || newest?.fromUserId === myUserId) el.scrollTop = el.scrollHeight;
  }, [shown, newest?.id, newest?.fromUserId, pagesLength, myUserId]);

  // A change to the group landing while the earlier page is on its way (a message, the member's own read mark) starts
  // a refetch that drops the page fetch in flight, so the page is asked for again until it has come (untilEarlierPage);
  // the place is noted again before each ask, since the refetch may have added to the list meanwhile. The ask never
  // cancels a refetch in flight either (cancelRefetch: false): it yields to it, the pages do not grow, and the next ask
  // brings the page. With the default, the page fetch dropped the refetch carrying a new message, the thread kept the
  // old newest message, no read mark fired, and the message stayed hidden (seen on the preview, 26 Oct 2026).
  const showEarlier = () => {
    const el = scroller.current;
    void untilEarlierPage(
      () => thread.fetchNextPage({ cancelRefetch: false }),
      thread.data?.pages.length ?? 0,
      () => { if (el) keepPlace.current = { height: el.scrollHeight, top: el.scrollTop }; },
    );
  };

  if (!isGroupId(groupId)) return <ThreadProblem text={GROUP_GONE} />;
  const failure = detail.error ?? thread.error;
  const problem = failure ? groupLoadProblem(failure) : null;
  // A refusal (gone, not in it) stands even over what was read before; a failure to load only when nothing was.
  if (problem === 'gone') return <ThreadProblem text={GROUP_GONE} />;
  if (problem === 'not-member') return <ThreadProblem text={NOT_IN_GROUP} />;
  if (!detail.data || !thread.data) {
    // A first read refused for going too fast is tried again once the limit's window has passed; until then it is said,
    // with Try again, rather than left loading for a minute.
    const limited = isRateLimited(detail.failureReason) || isRateLimited(thread.failureReason);
    if (problem === 'failed' || limited) {
      return <ThreadProblem text={GROUP_FAILED} onRetry={() => { void detail.refetch(); void thread.refetch(); }} />;
    }
    return <ThreadLoading />;
  }
  const group = detail.data;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="group-thread">
      <ThreadHeader group={group} onMembers={() => setMembersOpen(true)} />
      <div
        ref={scroller}
        data-testid="group-thread-scroll"
        onScroll={(e) => {
          const el = e.currentTarget;
          nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4"
      >
        {thread.hasNextPage && (
          <button
            type="button"
            onClick={showEarlier}
            disabled={thread.isFetchingNextPage}
            className={`${TEXT_BUTTON} mb-2 w-full border border-gray-200 bg-gray-50 text-gray-700 hover:bg-gray-100`}
          >
            {thread.isFetchingNextPage && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {SHOW_EARLIER}
          </button>
        )}
        {thread.isFetchNextPageError && <p role="alert" className="mb-2 text-center text-sm text-red-600">{EARLIER_FAILED}</p>}
        {messages.length === 0
          ? <p data-testid="group-thread-empty" className="py-8 text-center text-sm text-gray-500">{GROUP_EMPTY}</p>
          : <MessageList messages={messages} myUserId={myUserId} />}
      </div>
      <GroupComposer groupId={groupId} />
      <GroupMembersSheet open={membersOpen} onClose={() => setMembersOpen(false)} group={group} myUserId={myUserId ?? ''} />
    </div>
  );
}

function ThreadHeader({ group, onMembers }: { group: DmGroupDetail; onMembers: () => void }) {
  return (
    <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-2 sm:px-4">
      <Link to="/messages" className={BACK} aria-label="Back to inbox">
        <ArrowLeft className="h-4 w-4 text-gray-500" />
      </Link>
      {/* The name and the count open the members, as a group chat's header does. */}
      <button
        type="button"
        onClick={onMembers}
        aria-haspopup="dialog"
        title="Members"
        data-testid="group-header"
        className="flex min-h-[44px] min-w-0 flex-1 items-center gap-3 rounded-lg px-1 text-left hover:bg-gray-50"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-600" aria-hidden="true">
          <Users className="h-5 w-5" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-bold text-[#1a1a2e]">{group.name}</span>
          <span data-testid="group-member-count" className="block text-xs text-gray-500">{ofMax(group.memberCount)}</span>
        </span>
      </button>
    </div>
  );
}

/** The messages oldest first, one person's within a minute under one name, a line between days. */
function MessageList({ messages, myUserId }: { messages: GroupChatMessage[]; myUserId: string | undefined }) {
  const rows: ReactNode[] = [];
  let previousDay: Date | null = null;
  clusterGroupMessages(messages).forEach((cluster, ci) => {
    const first = cluster.messages[0];
    const last = cluster.messages[cluster.messages.length - 1];
    const firstDate = new Date(first.createdAt);
    if (!previousDay || !sameLocalDay(firstDate, previousDay)) {
      rows.push(
        <li key={`day-${first.id}`} className="flex justify-center py-3">
          <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-[11px] font-medium text-gray-500">{dayHeaderLabel(firstDate)}</span>
        </li>,
      );
    }
    previousDay = new Date(last.createdAt);
    const mine = cluster.senderId === myUserId;
    rows.push(
      <li key={first.id} className={cn('flex items-end gap-2', mine ? 'justify-end' : 'justify-start', ci > 0 && 'mt-3')}>
        {!mine && <Avatar src={first.senderAvatarUrl} name={first.senderName} size="sm" className="shrink-0" />}
        <div className={cn('flex min-w-0 max-w-[75%] flex-col sm:max-w-[60%]', mine ? 'items-end' : 'items-start')}>
          {!mine && <p className="mb-0.5 max-w-full truncate px-1 text-[11px] font-semibold text-gray-500">{first.senderName}</p>}
          {cluster.messages.map((m, i) => (
            <div
              key={m.id}
              data-message-id={m.id}
              className={cn(
                'whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm [overflow-wrap:anywhere]',
                i > 0 && 'mt-0.5',
                mine ? 'bg-rsn-red text-white' : 'bg-gray-100 text-[#1a1a2e]',
                i === cluster.messages.length - 1 && (mine ? 'rounded-br-sm' : 'rounded-bl-sm'),
              )}
            >
              <Linkify text={m.content} className={mine ? 'break-all text-white underline hover:opacity-80' : undefined} />
            </div>
          ))}
          <p className="mt-1 px-1 text-[11px] text-gray-400">{timeOnly(new Date(last.createdAt))}</p>
        </div>
      </li>,
    );
  });
  return <ol data-testid="group-messages">{rows}</ol>;
}

/** The message box: the server's 1 to 4000 characters; a refusal keeps the words and says why. */
function GroupComposer({ groupId }: { groupId: string }) {
  const send = useSendGroupMessage(groupId);
  const addToast = useToastStore((s) => s.addToast);
  // 360px phones: the long prompt wraps under its own first word beside the send button.
  const narrowPhone = typeof window !== 'undefined' && window.matchMedia('(max-width: 379px)').matches;
  const { register, handleSubmit, reset, watch } = useForm<SendValues>({
    defaultValues: { content: '' },
    resolver: formResolver(sendSchema),
  });
  const typed = (watch('content') ?? '').trim().length > 0;

  const submit = handleSubmit((values) => {
    if (send.isPending) return;
    send.mutate(values, {
      onSuccess: () => reset({ content: '' }),
      onError: (err) => addToast(groupErrorSentence(err, SEND_FAILED), 'error'),
    });
  });

  return (
    <form
      onSubmit={submit}
      noValidate
      className="border-t border-gray-200 px-3 pt-2"
      style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 0.5rem)' }}
    >
      <div className="flex items-end gap-2">
        <label htmlFor={`group-message-${groupId}`} className="sr-only">Message</label>
        <textarea
          id={`group-message-${groupId}`}
          rows={1}
          maxLength={GROUP_MESSAGE_MAX}
          placeholder={narrowPhone ? MESSAGE_PLACEHOLDER_SHORT : MESSAGE_PLACEHOLDER}
          {...register('content')}
          onKeyDown={(e) => {
            // Not while a word is still being composed (Japanese, Chinese, Korean input): there Enter picks the word.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          // 16px on a phone, so iOS does not zoom in on the box; at least 44px tall on every width, like the Send beside it.
          className="max-h-32 min-h-[44px] min-w-0 flex-1 resize-none rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-base sm:text-sm focus:outline-none focus:ring-1 focus:ring-rsn-red"
        />
        <button
          type="submit"
          disabled={!typed || send.isPending}
          aria-label="Send message"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-rsn-red text-white transition-colors hover:bg-rsn-red-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {send.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}
        </button>
      </div>
    </form>
  );
}

function ThreadLoading() {
  return (
    <div data-testid="group-thread-loading" aria-busy="true" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-gray-200 px-3 py-2 sm:px-4">
        <Link to="/messages" className={BACK} aria-label="Back to inbox">
          <ArrowLeft className="h-4 w-4 text-gray-500" />
        </Link>
        <div className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-gray-100" />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="h-3 w-40 max-w-full animate-pulse rounded bg-gray-200" />
          <div className="h-3 w-16 animate-pulse rounded bg-gray-100" />
        </div>
      </div>
      <div className="flex flex-1 items-center justify-center"><Spinner /></div>
    </div>
  );
}

/** Why the group cannot be shown, and the way back (on a phone the inbox beside it is hidden). */
function ThreadProblem({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-gray-200 px-3 py-2 lg:hidden">
        <Link to="/messages" className={BACK} aria-label="Back to inbox">
          <ArrowLeft className="h-4 w-4 text-gray-500" />
        </Link>
      </div>
      <div data-testid="group-thread-problem" className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-gray-700">{text}</p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {onRetry && (
            <button type="button" onClick={onRetry} className={`${TEXT_BUTTON} border border-gray-300 bg-white text-gray-800 hover:bg-gray-50`}>
              {TRY_AGAIN}
            </button>
          )}
          <Link to="/messages" className={`${TEXT_BUTTON} text-rsn-red hover:bg-rsn-red/5`}>{BACK_TO_MESSAGES}</Link>
        </div>
      </div>
    </div>
  );
}
