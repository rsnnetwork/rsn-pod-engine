// Chat in the call room (1 Nov 2026, T7, 30 Oct review 5a): the pair's own conversation, beside the stage from
// 640px and under it on a phone, while the video keeps running. What is typed here is an ordinary message: it is
// stored, it reaches the other person live (the conversation's entity tag), a block or a closed account refuses it in
// the server's words, and it is in both people's Messages afterwards. Text only: pictures and voice stay in Messages.

import { useEffect, useRef, useState } from 'react';
import { Send, X } from 'lucide-react';
import Linkify from '@/components/ui/Linkify';
import { Spinner } from '@/components/ui/Spinner';
import { cn } from '@/lib/utils';
import { errorMessage } from '@/features/reason/errors';
import { FORMER_MEMBER } from '@/features/messages/group-chat-text';
import { localizeMeetingText } from '@/features/messages/scheduler-flow';
import { localWhen } from '@/features/messages/SystemMessageCard';
import type { DmMessage } from '@/features/messages/thread/dm-message';
import { markThreadRead, useThreadMessages } from '@/features/messages/thread/useThreadMessages';
import { useSendMessage } from '@/features/messages/thread/useSendMessage';
import type { ConversationPartner } from '@/features/messages/thread/useConversationPartner';
import { panelOrder, sendable, sendsOnKey } from './call-chat';

interface Props {
  conversationId: string;
  open: boolean;
  onClose: () => void;
  partner: ConversationPartner | null;
  myUserId: string | undefined;
}

const refusalText = (err: unknown) => errorMessage(err, 'Your message was not sent. Try again in a moment.');

/** A line the product wrote (a meeting booked, a call started), in a few words. */
function systemLine(m: DmMessage): string {
  if (m.systemMeta?.type === 'meeting_confirmed') return `Meeting confirmed: ${localWhen(m.systemMeta.startAt)}`;
  return localizeMeetingText(m.content);
}

export default function CallChatPanel({ conversationId, open, onClose, partner, myUserId }: Props) {
  const { data, isError, refetch } = useThreadMessages(conversationId, { markRead: open });
  const [draft, setDraft] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const send = useSendMessage<{ content: string }>(conversationId, partner?.userId, {
    onSent: () => { setDraft(''); setRefusal(null); },
    onFailed: (err) => setRefusal(refusalText(err)),
    toastOnError: false,
  });

  const shown = data ? panelOrder(data) : [];
  const newest = shown[shown.length - 1];
  const partnerName = partner?.isFormerMember ? FORMER_MEMBER : partner?.name || 'Them';

  // Newest at the bottom: the list follows each new message while the panel is open.
  useEffect(() => {
    if (!open || !listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [open, newest?.id]);

  // A message the other person writes while the panel is open is read on arrival.
  useEffect(() => {
    if (open && newest && newest.fromUserId !== myUserId) markThreadRead(conversationId);
  }, [open, newest?.id, newest?.fromUserId, myUserId, conversationId]); // eslint-disable-line react-hooks/exhaustive-deps -- the newest message's id stands for it

  // From 640px the box is ready to type in; on a phone a tap on it opens the keyboard when the person wants it.
  useEffect(() => {
    if (open && window.matchMedia('(min-width: 640px)').matches) boxRef.current?.focus();
  }, [open]);

  const submit = () => {
    const content = sendable(draft);
    if (!content || send.isPending || !partner) return;
    send.mutate({ content });
  };

  return (
    <section
      aria-label="Chat"
      data-testid="call-chat-panel"
      className={cn(
        'flex h-full min-h-0 flex-col rounded-t-2xl bg-white text-gray-900 sm:rounded-none sm:border-l sm:border-white/10',
        !open && 'hidden',
      )}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-gray-200 py-1 pl-4 pr-1">
        <h2 className="text-sm font-semibold text-gray-800">Chat</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the chat"
          className="flex h-11 w-11 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-800"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3" aria-live="polite">
        {isError && !data ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <p className="text-sm text-gray-600">We could not load the chat just now.</p>
            <button
              type="button"
              onClick={() => void refetch()}
              className="min-h-[44px] rounded-lg border border-gray-300 px-4 text-sm font-medium text-gray-800 hover:bg-gray-50"
            >
              Try again
            </button>
          </div>
        ) : !data ? (
          <div className="flex justify-center py-6"><Spinner /></div>
        ) : shown.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-500">No messages yet. Say hello.</p>
        ) : (
          shown.map((m, i) => {
            if (m.kind === 'system') {
              return (
                <p key={m.id} data-testid="call-chat-system-line" className="px-2 text-center text-[11px] leading-snug text-gray-500">
                  {systemLine(m)}
                </p>
              );
            }
            const mine = m.fromUserId === myUserId;
            const prev = shown[i - 1];
            const firstOfRun = !prev || prev.fromUserId !== m.fromUserId || prev.kind === 'system';
            return (
              <div key={m.id} data-testid="call-chat-message" className={cn('flex flex-col', mine ? 'items-end' : 'items-start')}>
                {!mine && firstOfRun && <p className="mb-0.5 px-1 text-[11px] font-medium text-gray-500">{partnerName}</p>}
                <div
                  className={cn(
                    'max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm [overflow-wrap:anywhere]',
                    mine ? 'bg-gray-100 text-gray-900' : 'border border-gray-200 bg-white text-gray-900',
                  )}
                >
                  {m.content ? <Linkify text={m.content} /> : null}
                  {m.attachmentUrl && (
                    <span className="block text-xs italic text-gray-500">
                      {m.attachmentType === 'audio' ? 'A voice message. Listen to it in Messages.' : 'A picture. See it in Messages.'}
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      <form
        className="shrink-0 border-t border-gray-200 px-3 pt-2 pb-[max(8px,env(safe-area-inset-bottom))] sm:pb-2"
        onSubmit={(e) => { e.preventDefault(); submit(); }}
      >
        {refusal && (
          <p role="alert" className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{refusal}</p>
        )}
        <div className="flex items-end gap-2">
          <label htmlFor="call-chat-box" className="sr-only">Message</label>
          <textarea
            id="call-chat-box"
            ref={boxRef}
            value={draft}
            onChange={(e) => { setDraft(e.target.value); if (refusal) setRefusal(null); }}
            onKeyDown={(e) => {
              if (!sendsOnKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing })) return;
              e.preventDefault();
              submit();
            }}
            rows={1}
            maxLength={4000}
            placeholder="Message"
            className="max-h-28 min-h-[44px] flex-1 resize-none rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-base text-gray-900 placeholder:text-gray-400 focus:border-gray-500 focus:outline-none sm:text-sm"
          />
          <button
            type="submit"
            disabled={!sendable(draft) || send.isPending || !partner}
            aria-label="Send"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-rsn-red text-white hover:opacity-90 disabled:opacity-40"
          >
            {send.isPending ? <Spinner className="h-4 w-4 text-white" /> : <Send className="h-4 w-4" />}
          </button>
        </div>
        <p className="mt-1.5 text-[11px] text-gray-500">Messages stay in your conversation.</p>
      </form>
    </section>
  );
}
