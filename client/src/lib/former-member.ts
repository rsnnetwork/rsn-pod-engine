// The name the server gives a closed account wherever their words or their part are still shown: old messages, group
// chats, replies, walls, meetings (server/src/services/users/active-member.ts FORMER_MEMBER_NAME, T2). One constant on
// the client too (X3, 2 Nov 2026): the person link, the group chat and the call chat all read this one.

export const FORMER_MEMBER = 'Former member';

/** Whether a name is a closed account's, as the server writes it. Prefer the server's own flag where a row has one. */
export const isFormerMemberName = (name: string | null | undefined): boolean => (name ?? '').trim() === FORMER_MEMBER;
