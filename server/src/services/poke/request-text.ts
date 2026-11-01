// ─── A meeting request's two texts: the member's note and REASON's line ──────
//
// Stefan, 30 Oct 2026: "It looks like the sender wrote it." A request had one text,
// user_pokes.message, into which the server wrote REASON's sentence on why it suggested the two,
// the member's own note, or both run together, and every screen drew that one text in the
// sender's voice. Since migration 120 the two are stored apart: `message` holds only what the
// member wrote and `reason_line` holds REASON's line.
//
// Rows written before 120 keep their one text, in one of four shapes:
//   (a) REASON's sentence alone, addressed to the recipient and closed with "We think you two should meet.";
//   (b) the note, a blank line, "Why REASON suggested this: " and REASON's sentence;
//   (c) the note alone;
//   (d) nothing.
// splitLegacyRequestMessage takes them apart, and requestText is the one reader every path goes
// through, so a legacy row and a new one read the same everywhere.
//
// A module of its own rather than part of poke.service.ts, for the reason request-message.ts gives:
// the tests that stand in for poke.service replace that whole module, and a helper read from there
// would be undefined in them.

import type { MeetingRequestText } from '@rsn/shared';
import { clipAtWord } from '../people/text';

/** What came between the note and REASON's sentence in the one text a request used to have. */
export const REASON_LEAD = '\n\nWhy REASON suggested this: ';

/** The heading REASON's line goes under wherever it is shown on its own. */
export const REASON_HEADING = 'Why REASON suggested this';

/** How a request with no note used to close REASON's sentence. */
const SYSTEM_CLOSE = 'We think you two should meet.';

/**
 * Take a legacy request's one text apart. A text that ends with REASON's closing sentence and has
 * no line break is REASON's alone: no note path ever wrote one (a note is followed by the lead, or
 * stands alone). A text with the lead is a note and a line, split at the last lead, because REASON
 * appended its line after whatever the member wrote. Anything else is the member's note.
 */
export function splitLegacyRequestMessage(message: string): MeetingRequestText {
  const text = (message ?? '').trim();
  if (!text) return { note: null, reasonLine: null };

  const at = text.lastIndexOf(REASON_LEAD);
  if (at >= 0) {
    return {
      note: text.slice(0, at).trim() || null,
      reasonLine: text.slice(at + REASON_LEAD.length).trim() || null,
    };
  }
  if (text.endsWith(SYSTEM_CLOSE) && !text.includes('\n')) {
    return { note: null, reasonLine: text.slice(0, -SYSTEM_CLOSE.length).trim() || null };
  }
  return { note: text, reasonLine: null };
}

/**
 * A legacy line spoke to the recipient ("— you're a Founder", "Your profile matches what Shradha is
 * looking for"). Shown to both people (the card in the conversation) it would tell the SENDER they
 * are a Founder, so it is put in the third person, as new lines are written: "…, and Stefan is a
 * Founder." The shapes are the ones formatForRecipient wrote before 30 Oct; a line in no known shape
 * is left as it is.
 */
export function thirdPersonLegacyLine(line: string, recipientName: string): string {
  const name = recipientName.trim();
  if (!name) return line;
  return line
    .replace(/ — you're (an?) /, `, and ${name} is $1 `)
    .replace(/ — you fit\b/, `, and ${name} fits`)
    .replace(/ is looking for matches your profile: /, ` is looking for matches ${name}'s profile: `)
    .replace(/^Your profile matches what /, `${name}'s profile matches what `)
    .replace(/ thinks you fit what they're looking for/, ` thinks ${name} fits what they're looking for`)
    .replace(/they don't state their years of experience/, `${name} does not state their years of experience`);
}

/**
 * Text cut to at most `max` UTF-16 units (what the stored caps and zod's `max` count), between words
 * and ending in an ellipsis. clipAtWord counts characters, so an emoji can leave a cut a unit or two
 * over: the excess comes off the budget and it is cut again. Null when nothing fits.
 */
export function fitToUnits(text: string, max: number): string | null {
  if (text.length <= max) return text;
  let room = max;
  for (let cut = clipAtWord(text, room); cut; cut = clipAtWord(text, room)) {
    const excess = cut.length - max;
    if (excess <= 0) return cut;
    room -= excess;
  }
  return null;
}

/** A request row as the readers have it: its two text columns. */
export interface RequestTextRow {
  message: string | null;
  reason_line?: string | null;
}

/**
 * The note and REASON's line of one request. A row written since migration 120 carries its line in
 * reason_line and only the note in message. A row with no line is read as a legacy text, which is
 * also right for a new request that has only a note or nothing (shapes c and d). With the
 * recipient's name a legacy line is put in the third person, as new lines are written.
 */
export function requestText(row: RequestTextRow, recipientName?: string | null): MeetingRequestText {
  const line = row.reason_line?.trim();
  if (line) return { note: row.message?.trim() || null, reasonLine: line };
  const split = splitLegacyRequestMessage(row.message ?? '');
  return {
    note: split.note,
    reasonLine: split.reasonLine && recipientName != null ? thirdPersonLegacyLine(split.reasonLine, recipientName) : split.reasonLine,
  };
}

/**
 * The one text the older clients read (production's request cards, the admin inspector, a
 * meeting's context): the note, then "Why REASON suggested this: " and the line, within `max`
 * characters. A legacy row keeps the text it was stored with, so those screens show exactly what
 * they showed before. When the two would not fit, the line gives way, cut between words; the note
 * is never cut.
 */
export function combinedRequestMessage(row: RequestTextRow, max: number): string | null {
  if (!row.reason_line?.trim()) return row.message?.trim() || null;
  const { note, reasonLine } = requestText(row);
  const line = reasonLine as string;
  const lead = note ? `${note}${REASON_LEAD}` : `${REASON_HEADING}: `;
  const fitted = fitToUnits(line, max - lead.length);
  return fitted ? `${lead}${fitted}` : note;
}

/** The body of the bell that announces a request: the note, else REASON's line under its heading, else what to do. */
export function requestBellBody(text: MeetingRequestText): string {
  if (text.note) return text.note;
  if (text.reasonLine) return `${REASON_HEADING}: ${text.reasonLine}`;
  return 'Accept to start chatting.';
}
