// ─── The live chat's send (fix round 2, 26 Oct 2026; chatSend.ts says what becomes of the words) ───
//
// chat:send goes with an acknowledgement callback and a clientId (S5's server answers every send there, a
// refusal included, and stores a clientId once). The box empties only when the message has gone out; a refusal
// keeps the words and says why. A server with no acknowledgement still sends our message back to us, which counts
// as the answer; with no answer at all the button frees up after CHAT_ACK_WAIT_MS and says so, and an answer
// that comes later still settles it.

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { getSocket } from '@/lib/socket';
import { useSessionStore } from '@/stores/sessionStore';
import { useAuthStore } from '@/stores/authStore';
import { CHAT_ACK_WAIT_MS, CHAT_NOT_SENT, CHAT_NOT_SENT_YET, isOwnEcho, textAfterSent } from './chatSend';

/** One message on its way: the words as typed and as sent, its clientId, and the copies of it the chat already had. */
interface OnItsWay {
  raw: string;
  text: string;
  clientId: string;
  seenIds: Set<string>;
  /** 'late': no answer in CHAT_ACK_WAIT_MS (the button is free again), though one can still come. */
  state: 'waiting' | 'late' | 'done';
  timer: ReturnType<typeof setTimeout> | null;
}

export interface ChatSend {
  send: () => void;
  /** A message is on its way, not yet answered: the send button waits. */
  sending: boolean;
  /** Why the last message did not go out (the server's own words, or no answer in time), or null. */
  notice: string | null;
  clearNotice: () => void;
}

export function useChatSend(
  sessionId: string,
  scope: 'lobby' | 'room',
  input: string,
  setInput: Dispatch<SetStateAction<string>>,
): ChatSend {
  const me = useAuthStore((s) => s.user?.id);
  const chatMessages = useSessionStore((s) => s.chatMessages);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const latest = useRef<OnItsWay | null>(null);
  // The same words sent again (after a refusal, or no answer) keep their clientId, so the server stores them once.
  const draft = useRef<{ text: string; clientId: string } | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (latest.current?.timer) clearTimeout(latest.current.timer);
    };
  }, []);

  /** The answer for one message: null when it went out, else the reason it did not. */
  const settle = useCallback((m: OnItsWay, refusal: string | null) => {
    if (m.state === 'done') return;
    m.state = 'done';
    if (m.timer) clearTimeout(m.timer);
    if (!mounted.current) return;
    if (refusal === null) {
      if (draft.current?.clientId === m.clientId) draft.current = null;
      setInput((cur) => textAfterSent(cur, m.raw));
    }
    if (latest.current === m) {
      setSending(false);
      setNotice(refusal);
    }
  }, [setInput]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || latest.current?.state === 'waiting') return;
    const socket = getSocket();
    if (!socket) return;
    const clientId = draft.current?.text === text ? draft.current.clientId : crypto.randomUUID();
    draft.current = { text, clientId };
    const seenIds = new Set(
      useSessionStore.getState().chatMessages.filter((c) => c.userId === me && c.message === text).map((c) => c.id),
    );
    const m: OnItsWay = { raw: input, text, clientId, seenIds, state: 'waiting', timer: null };
    latest.current = m;
    setSending(true);
    setNotice(null);
    m.timer = setTimeout(() => {
      if (m.state !== 'waiting') return;
      m.state = 'late';
      if (!mounted.current || latest.current !== m) return;
      setSending(false);
      setNotice(CHAT_NOT_SENT_YET);
    }, CHAT_ACK_WAIT_MS);
    socket.emit('chat:send', { sessionId, message: text, scope, clientId }, (res) => {
      settle(m, res.ok ? null : res.message || CHAT_NOT_SENT);
    });
  }, [input, sessionId, scope, me, settle]);

  // A server that sends no acknowledgement still sends our message back to us: that is its answer.
  useEffect(() => {
    const m = latest.current;
    if (!m || m.state === 'done') return;
    if (chatMessages.some((c) => isOwnEcho(c, me, m.text, m.seenIds))) settle(m, null);
  }, [chatMessages, me, settle]);

  const clearNotice = useCallback(() => setNotice(null), []);
  return { send, sending, notice, clearNotice };
}
