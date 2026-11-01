// The other person in a 1:1 conversation, for screens that have only the conversation's id: the call room's chat
// panel and the scheduler's Add to calendar (1 Nov 2026, T7). Their id comes from the conversation's scheduling
// (every participant can read it) and their name from the inbox. A removed, suspended or banned account reads
// "Former member" (T2: the inbox says so with otherIsFormerMember, and already gives that name).

import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import { useAuthStore } from '@/stores/authStore';
import { FORMER_MEMBER } from '../group-chat-text';
import { schedulingKey, type Scheduling } from '../scheduling-types';

/** The inbox row's fields this reads; the inbox query (MessagesPage, ChatQuickAccess) has the same key and request. */
interface InboxRow {
  conversationId: string;
  otherUserId: string;
  otherDisplayName: string | null;
  otherIsFormerMember?: boolean;
}

export interface ConversationPartner {
  userId: string;
  /** Null while the inbox does not list the conversation (it reads one page of it). */
  name: string | null;
  isFormerMember: boolean;
}

export function useConversationPartner(conversationId: string | undefined): ConversationPartner | null {
  const myUserId = useAuthStore((s) => s.user?.id);
  const inbox = useQuery({
    queryKey: ['dm-conversations'],
    queryFn: () => api.get('/dm/conversations').then((r) => r.data.data as InboxRow[]),
    enabled: !!conversationId,
    meta: { entities: myUserId ? [E.userDms(myUserId)] : [] },
  });
  const scheduling = useQuery<Scheduling>({
    queryKey: schedulingKey(conversationId ?? ''),
    queryFn: () => api.get(`/dm/conversations/${conversationId}/scheduling`).then((r) => r.data.data),
    enabled: !!conversationId,
    meta: { entities: conversationId ? [E.dmConversation(conversationId)] : [] },
  });

  const row = inbox.data?.find((c) => c.conversationId === conversationId);
  const userId = row?.otherUserId ?? scheduling.data?.partnerId;
  if (!userId) return null;
  const isFormerMember = !!row?.otherIsFormerMember;
  return {
    userId,
    name: row ? (row.otherIsFormerMember ? FORMER_MEMBER : row.otherDisplayName || 'Member') : null,
    isFormerMember,
  };
}
