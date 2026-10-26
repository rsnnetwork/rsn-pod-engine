import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Loader2, Lock, MessageCircle, Play } from 'lucide-react';
import type { EventChatMessage, EventChatPage } from '@rsn/shared';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import ProfileLink from '@/components/ui/ProfileLink';
import Linkify from '@/components/ui/Linkify';
import {
  CHAT_EMPTY, CHAT_FAILED, CHAT_FORBIDDEN, CHAT_LIVE, CHAT_PAGE_SIZE, CHAT_TITLE, ENTER_LIVE, SHOW_EARLIER, TRY_AGAIN,
  chatInOrder, chatLoadProblem, chatTime, reactionSummary,
} from './event-chat-text';

// ─── The event's chat on its page (26 Oct 2026, C10, COM-02) ─────────────────
//
// 25 Oct walkthrough: "Here I can't see what we chatted about." The chat is now kept with the event (S5), and the
// completed event's page shows it: the newest 30 messages, "Show earlier messages" above them, to the people who
// took part (anyone else is told why not). While the event runs the chat lives inside it, and the card says so.
// It follows the event chat's tag, sent when the event ends and when a message is taken down.

const BUTTON = 'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60';
const CARD = 'rounded-2xl border border-gray-200 bg-white p-5 shadow-sm';

interface Props {
  sessionId: string;
  /** The event is running: its chat is inside the live event. */
  live: boolean;
  /** The reader can go into the live event (registered for it, or its host). */
  canEnterLive: boolean;
}

export default function EventChatHistory({ sessionId, live, canEnterLive }: Props) {
  if (live) return canEnterLive ? <ChatIsLive sessionId={sessionId} /> : null;
  return <KeptChat sessionId={sessionId} />;
}

function Heading() {
  return (
    <h2 id="event-chat-title" className="flex items-center gap-2 text-lg font-semibold text-[#1a1a2e]">
      <MessageCircle className="h-5 w-5 text-rsn-red" aria-hidden="true" /> {CHAT_TITLE}
    </h2>
  );
}

function ChatIsLive({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate();
  return (
    <section data-testid="event-chat-live" aria-labelledby="event-chat-title" className={CARD}>
      <Heading />
      <p className="mt-2 text-sm text-gray-600">{CHAT_LIVE}</p>
      <button
        type="button"
        onClick={() => navigate(`/session/${sessionId}/live`)}
        className={`${BUTTON} mt-3 w-full border border-gray-300 bg-white text-gray-800 hover:bg-gray-50 sm:w-auto`}
      >
        <Play className="h-4 w-4" aria-hidden="true" /> {ENTER_LIVE}
      </button>
    </section>
  );
}

function KeptChat({ sessionId }: { sessionId: string }) {
  const chat = useInfiniteQuery({
    queryKey: ['event-chat', sessionId],
    queryFn: ({ pageParam }): Promise<EventChatPage> =>
      api.get(`/sessions/${sessionId}/chat`, { params: { limit: CHAT_PAGE_SIZE, cursor: pageParam } }).then((r) => r.data.data),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: EventChatPage) => last.nextCursor ?? undefined,
    // A refusal is final (the reader did not take part); anything else may pass.
    retry: (failures, err) => chatLoadProblem(err) !== 'forbidden' && failures < 2,
    meta: { entities: [E.sessionChat(sessionId)] },
  });

  let body: JSX.Element;
  if (chat.isPending) {
    body = (
      <div data-testid="event-chat-loading" aria-busy="true" className="mt-4 space-y-4">
        {[0, 1, 2].map((i) => (
          <div key={i}>
            <div className="h-3 w-32 animate-pulse rounded bg-gray-200" />
            <div className="mt-2 h-3 w-full animate-pulse rounded bg-gray-100" />
          </div>
        ))}
      </div>
    );
  } else if (!chat.data) {
    body = chatLoadProblem(chat.error) === 'forbidden' ? (
      <p data-testid="event-chat-forbidden" className="mt-3 flex items-start gap-2 text-sm text-gray-600">
        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" /><span>{CHAT_FORBIDDEN}</span>
      </p>
    ) : (
      <div data-testid="event-chat-error" className="mt-3">
        <p className="text-sm text-gray-700">{CHAT_FAILED}</p>
        <button
          type="button"
          onClick={() => { void chat.refetch(); }}
          className={`${BUTTON} mt-3 w-full border border-gray-300 bg-white text-gray-800 hover:bg-gray-50 sm:w-auto`}
        >
          {TRY_AGAIN}
        </button>
      </div>
    );
  } else {
    const messages = chatInOrder(chat.data.pages);
    body = messages.length === 0 ? (
      <p data-testid="event-chat-empty" className="mt-3 text-sm text-gray-500">{CHAT_EMPTY}</p>
    ) : (
      <>
        {chat.hasNextPage && (
          <button
            type="button"
            onClick={() => { void chat.fetchNextPage(); }}
            disabled={chat.isFetchingNextPage}
            className={`${BUTTON} mt-3 w-full border border-gray-200 bg-gray-50 text-gray-700 hover:bg-gray-100`}
          >
            {chat.isFetchingNextPage && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {SHOW_EARLIER}
          </button>
        )}
        {chat.isFetchNextPageError && <p role="alert" className="mt-2 text-sm text-red-600">{CHAT_FAILED}</p>}
        <ol data-testid="event-chat-messages" className="mt-2 divide-y divide-gray-100">
          {messages.map((m) => <ChatLine key={m.id} m={m} />)}
        </ol>
      </>
    );
  }

  return (
    <section data-testid="event-chat" aria-labelledby="event-chat-title" className={CARD}>
      <Heading />
      {body}
    </section>
  );
}

/** One message as it was sent: who (their profile, unless the account is closed), when, the words, the reactions. */
function ChatLine({ m }: { m: EventChatMessage }) {
  const reactions = reactionSummary(m.reactions);
  return (
    <li data-testid="event-chat-message" className="py-3">
      <div className="flex min-w-0 items-center gap-2">
        {/* A 44px target grown into the row's own padding, so nothing moves. */}
        {m.senderId ? (
          <ProfileLink userId={m.senderId} from="Events" className="-my-3 min-w-0 truncate py-3 text-sm font-semibold text-[#1a1a2e] hover:underline">
            {m.senderName}
          </ProfileLink>
        ) : (
          <span className="min-w-0 truncate text-sm font-semibold text-gray-600">{m.senderName}</span>
        )}
        {m.senderIsHost && <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">Host</span>}
        {m.scope === 'room' && <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">Room</span>}
        <time dateTime={m.createdAt} className="ml-auto shrink-0 text-xs tabular-nums text-gray-400">{chatTime(m.createdAt)}</time>
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-gray-800 [overflow-wrap:anywhere]">
        <Linkify text={m.content} className="break-all text-blue-600 underline hover:text-blue-700" />
      </p>
      {reactions.length > 0 && (
        <p className="mt-1 flex flex-wrap gap-2 text-xs text-gray-500" aria-label="Reactions">
          {reactions.map((r) => <span key={r.emoji}>{r.emoji} {r.count}</span>)}
        </p>
      )}
    </li>
  );
}
