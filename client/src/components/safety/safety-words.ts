// client/src/components/safety/safety-words.ts
// What the safety actions say (11 Nov 2026, Shirley Palmer's item 16): "Flag" read as an Outlook follow-up marker, not
// a safety report. Every entry point now says, in words, what it does: "Report member", "Report message", "Report
// post", and "Block member" kept apart from them; and each explains what happens before it is sent. Pure on purpose
// (no React), so a test can read the exact sentences: server/src/__tests__/client/shirley-s5-safety-calls.test.ts.

export const REPORT_MEMBER = 'Report member';
export const REPORT_MESSAGE = 'Report message';
export const REPORT_POST = 'Report post';
export const BLOCK_MEMBER = 'Block member';
export const UNBLOCK = 'Unblock';

/** What a report names: the member, one of their messages, or one of their posts. */
export type ReportTarget = 'member' | 'message' | 'post';

/** "the member" when there is no name to say. */
const who = (name: string | null | undefined) => name?.trim() || 'this member';
const They = (name: string | null | undefined) => name?.trim() || 'They';

export function reportTitle(target: ReportTarget, name: string | null | undefined): string {
  if (target === 'message') return 'Report this message';
  if (target === 'post') return 'Report this post';
  return `Report ${who(name)}`;
}

/**
 * What happens once the report is sent, said before it is: who looks at it, what they can read, and that nothing
 * changes for the other person (who is not told) until the REASON team has looked.
 */
export function reportConsequence(target: ReportTarget, name: string | null | undefined, inChat: boolean): string {
  const what = target === 'message' ? 'this message' : target === 'post' ? 'this post' : 'your report';
  const reads = inChat ? ' and can read this conversation' : '';
  return `The REASON team will review ${what}${reads}. ${They(name)} won't be told about your report, and nothing changes for them until we have looked at it.`;
}

/** What blocking does, said before it is done (the confirmation and the report sheet's "Also block"). */
export function blockConsequence(name: string | null | undefined): string {
  return `${They(name)} won't be able to message or call you, you won't be matched together, and you won't see each other's posts or comments. They aren't told. Your conversation stays, read-only. You can unblock them from the conversation or their profile.`;
}

export const blockTitle = (name: string | null | undefined): string => `Block ${who(name)}?`;

export const CHOOSE_REASON = 'Choose a reason';
export const REASON_NEEDED = 'Choose a reason first.';
export const REPORT_SENT = 'Report sent';
export const ALREADY_REPORTED = 'You already reported this.';

/** The line once the report is sent: it stays in the sheet until the person closes it. */
export function reportSentLine(name: string | null | undefined, alsoBlocked: boolean): string {
  const blocked = alsoBlocked ? ` You also blocked ${who(name)}: they can no longer message or call you.` : '';
  return `Thanks. The REASON team will review it.${blocked}`;
}

/** The banner a blocked person's thread shows instead of the message box. */
export function blockedThreadLine(name: string | null | undefined): string {
  return `You blocked ${who(name)}. They can't message or call you. The conversation stays here, read-only.`;
}
