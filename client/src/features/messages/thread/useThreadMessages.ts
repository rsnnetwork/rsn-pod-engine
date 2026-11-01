// A 1:1 conversation's messages, and marking them read (moved out of MessagesPage on 1 Nov 2026, T7, so the chat
// panel in the call room reads the same thread). The query is kept live by the conversation's entity tag: a new
// message, a read receipt or a reaction refetches it on every screen that shows it, without a reload.

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { E } from '@/realtime/entities';
import type { DmMessage } from './dm-message';

/** Mark everything the other person wrote in this conversation as read: over the socket, or by REST when it is down. */
export function markThreadRead(conversationId: string): void {
  const socket = getSocket();
  if (socket?.connected) {
    socket.emit('dm:read', { conversationId });
  } else {
    api.post(`/dm/conversations/${conversationId}/read`).catch(err => console.warn('mark-read failed', err));
  }
}

/**
 * The thread's messages, newest first, as the server answers them. `markRead` (on unless switched off) marks the
 * conversation read when it opens; the call room's panel switches it off while it is closed.
 */
export function useThreadMessages(conversationId: string | undefined, { markRead = true }: { markRead?: boolean } = {}) {
  const thread = useQuery({
    queryKey: ['dm-messages', conversationId],
    queryFn: () => api.get(`/dm/conversations/${conversationId}/messages`).then(r => r.data.data as DmMessage[]),
    enabled: !!conversationId,
    meta: { entities: conversationId ? [E.dmConversation(conversationId)] : [] },
  });

  // Mark-as-read: fire on opening a conversation.
  useEffect(() => {
    if (!conversationId || !markRead) return;
    markThreadRead(conversationId);
  }, [conversationId, markRead]);

  return thread;
}
