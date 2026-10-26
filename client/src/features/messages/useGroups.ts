// client/src/features/messages/useGroups.ts
// Everything the group chat screens read and write (26 Oct 2026, C12, COM-04): the list (the inbox's group rows and the
// Messages badge), one group with its members, its thread a page at a time, and the writes (a message, the read mark,
// leave, add, remove, and starting one from a completed event). The routes are server/src/routes/groups.ts (S9).
//
// Each read declares the tags the server sends. Every change to a group sends each of its members, in an emit of their
// own, dm-group:<id> with their own user:<id>:dms; whoever just left or was removed gets the same, and a read mark goes
// only to the reader's own tabs. A block or unblock sends both people user:<id>:blocks, and the group reads leave out
// messages between people who block each other, so they redraw on it too. Nothing here writes the cache by hand: a write
// has the writer's own reads asked again at once, and the socket does the same for everyone else.
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DmGroupDetail, DmGroupSummary, GroupChatMessage, GroupChatMessagePage } from '@rsn/shared';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import { useAuthStore } from '@/stores/authStore';
import { groupReadRetry, groupReadRetryDelay, groupUnreadTotal, type EventPerson } from './group-chat-text';

export const groupKeys = {
  list: ['dm-groups'] as const,
  detail: (groupId: string) => ['dm-group', groupId] as const,
  messages: (groupId: string) => ['dm-group-messages', groupId] as const,
};

/** One page of a thread (the server takes 1 to 100). */
const GROUP_PAGE_SIZE = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A group id, in either case. Anything else (a typo, a crafted address) is no group, and needs no request. */
export const isGroupId = (id: string | undefined): id is string => !!id && UUID.test(id);

/** What starting a group answers (POST /groups/from-event/:sessionId). */
export interface StartedGroup { id: string; name: string; sessionId: string | null; memberCount: number }

const useMe = () => useAuthStore((s) => s.user?.id as string | undefined);

const fetchGroups = () => api.get('/groups').then((r) => r.data.data as DmGroupSummary[]);
const fetchGroup = (groupId: string) => api.get(`/groups/${encodeURIComponent(groupId)}`).then((r) => r.data.data as DmGroupDetail);
const fetchMessages = (groupId: string, before: string | undefined) =>
  api.get(`/groups/${encodeURIComponent(groupId)}/messages`, { params: { limit: GROUP_PAGE_SIZE, ...(before ? { before } : {}) } })
    .then((r) => r.data.data as GroupChatMessagePage);

/** The groups the member is in, the latest activity first: the inbox's group rows. */
export function useMyGroups() {
  const me = useMe();
  return useQuery({
    queryKey: groupKeys.list,
    queryFn: fetchGroups,
    enabled: !!me,
    // A 429 waits the limit's window out (twice at most) while what was read stays shown; any other 4xx is an answer.
    retry: groupReadRetry,
    retryDelay: groupReadRetryDelay,
    meta: { entities: me ? [E.userDms(me), E.userBlocks(me)] : [] },
  });
}

/** The groups' part of the Messages badge: the same list as the inbox (one request for both), summed. */
export function useGroupUnreadTotal(): number {
  const me = useMe();
  const { data } = useQuery({
    queryKey: groupKeys.list,
    queryFn: fetchGroups,
    enabled: !!me,
    retry: groupReadRetry,
    retryDelay: groupReadRetryDelay,
    select: groupUnreadTotal,
    meta: { entities: me ? [E.userDms(me), E.userBlocks(me)] : [] },
  });
  return data ?? 0;
}

/**
 * One group as its member sees it, with its members and the cap. A 4xx is an answer (gone, not in it) and is not asked
 * again, except a 429, which waits the limit out. Every change that moves it sends dm-group:<id> (with user:<id>:dms),
 * so it follows the group's own tag and blocks, as ENTITIES.md lists it; user:<id>:dms alone is news of any conversation
 * or group, and would only read it again for nothing (the server allows 120 group reads a minute per member).
 */
export function useGroup(groupId: string | undefined) {
  const me = useMe();
  return useQuery({
    queryKey: groupKeys.detail(groupId ?? ''),
    queryFn: () => fetchGroup(groupId ?? ''),
    enabled: !!me && isGroupId(groupId),
    retry: groupReadRetry,
    retryDelay: groupReadRetryDelay,
    meta: { entities: groupId && me ? [E.dmGroup(groupId), E.userBlocks(me)] : [] },
  });
}

/** The thread, a page at a time: the newest page first, each next one older (its cursor goes back as ?before=). */
export function useGroupMessages(groupId: string | undefined) {
  const me = useMe();
  return useInfiniteQuery({
    queryKey: groupKeys.messages(groupId ?? ''),
    queryFn: ({ pageParam }) => fetchMessages(groupId ?? '', pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: GroupChatMessagePage) => last.nextCursor ?? undefined,
    enabled: !!me && isGroupId(groupId),
    retry: groupReadRetry,
    retryDelay: groupReadRetryDelay,
    meta: { entities: groupId && me ? [E.dmGroup(groupId), E.userBlocks(me)] : [] },
  });
}

/** Who signed up for an event and who came. The event's page reads the same list under the same key. */
export function useEventPeople(sessionId: string | null | undefined) {
  return useQuery({
    queryKey: ['session-participants', sessionId],
    queryFn: () => api.get(`/sessions/${sessionId}/participants`).then((r) => (r.data.data ?? []) as EventPerson[]),
    enabled: !!sessionId,
    meta: { entities: sessionId ? [E.session(sessionId), E.sessionParticipants(sessionId)] : [] },
  });
}

/** Write in the group: the writer's thread and list are read again at once. */
export function useSendGroupMessage(groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ content }: { content: string }) =>
      api.post(`/groups/${encodeURIComponent(groupId)}/messages`, { content })
        .then((r) => r.data.data as { messageId: string; createdAt: string; message: GroupChatMessage }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: groupKeys.messages(groupId) });
      qc.invalidateQueries({ queryKey: groupKeys.list });
    },
  });
}

/** The member has read the group up to now. The server tells the reader's own tabs, whose counts redraw. */
export function useMarkGroupRead(groupId: string) {
  return useMutation({
    mutationFn: () => api.post(`/groups/${encodeURIComponent(groupId)}/read`).then((r) => r.data.data as { lastReadAt: string }),
  });
}

/** Leave the group. A second press is no error: the server answers left: false. */
export function useLeaveGroup(groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post(`/groups/${encodeURIComponent(groupId)}/leave`).then((r) => r.data.data as { left: boolean; newAdminId: string | null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: groupKeys.list });
    },
  });
}

/** The group's admin adds people who took part in its event. */
export function useAddGroupMembers(groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userIds: string[]) =>
      api.post(`/groups/${encodeURIComponent(groupId)}/members`, { userIds }).then((r) => r.data.data as { added: string[]; memberCount: number }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: groupKeys.detail(groupId) });
      qc.invalidateQueries({ queryKey: groupKeys.list });
    },
  });
}

/** The group's admin removes someone. */
export function useRemoveGroupMember(groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      api.delete(`/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`).then((r) => r.data.data as { removedUserId: string }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: groupKeys.detail(groupId) });
      qc.invalidateQueries({ queryKey: groupKeys.list });
    },
  });
}

/** One of the people who ran a completed event starts a group with the people who took part. */
export function useStartGroupChat(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { memberIds?: string[] }) =>
      api.post(`/groups/from-event/${encodeURIComponent(sessionId)}`, body).then((r) => r.data.data as StartedGroup),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: groupKeys.list });
    },
  });
}
