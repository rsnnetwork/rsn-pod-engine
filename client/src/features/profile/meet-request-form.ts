// The "Your meeting request" form on Edit profile (Stefan, 21 Nov 2026: "I should be able in my profile to state my
// 'standard message' and preferred format"): its rules, its words, and what a save sends. Pure (zod and shared only),
// so a test can run it. The server holds the same rules (routes/users.ts) and migration 158 the same limits.
import { z } from 'zod';
import { MEET_NOTE_MAX, MEETING_FORMATS, type MeetingFormat } from '@rsn/shared';

export const MEET_NOTE_TOO_LONG = `Keep the message to ${MEET_NOTE_MAX} characters or fewer.`;
export const MEET_FORMAT_REFUSAL = 'Choose one of the offered formats.';
export const MEET_REQUEST_SAVE_FAILED = 'Your meeting request could not be saved. Try again.';
/** Where a request starts when the member has saved no format: the Meet sheet's own first choice. */
export const STANDARD_FORMAT: MeetingFormat = 'video_20';

const FORMAT_KEYS = MEETING_FORMATS.map((f) => f.key) as [MeetingFormat, ...MeetingFormat[]];

export interface MeetRequestValues {
  note: string;
  format: MeetingFormat;
}

// Counted as the server counts it: the note without the spaces round it.
export const meetRequestSchema = z.object({
  note: z.string().refine((v) => v.trim().length <= MEET_NOTE_MAX, MEET_NOTE_TOO_LONG),
  format: z.enum(FORMAT_KEYS, { message: MEET_FORMAT_REFUSAL }),
});

/** The form's values from what is saved: an empty box for REASON's own note, the standard format for none. */
export function meetRequestValues(saved: { note: string | null; format: MeetingFormat | null } | undefined): MeetRequestValues {
  return { note: saved?.note ?? '', format: saved?.format ?? STANDARD_FORMAT };
}

/** What a save sends to PUT /users/me: an emptied box clears the note, so requests go back to REASON's own. */
export function meetRequestBody(values: MeetRequestValues): { meetNoteDefault: string | null; meetFormatDefault: MeetingFormat } {
  const note = values.note.trim();
  return { meetNoteDefault: note || null, meetFormatDefault: values.format };
}

/** The server's refusal of one field ({ meetNoteDefault: [...] }), mapped to the form's field, or null. */
export function meetRequestFieldError(err: unknown): { field: keyof MeetRequestValues; message: string } | null {
  const details = (err as { response?: { status?: number; data?: { error?: { details?: Record<string, unknown> } } } })
    ?.response?.data?.error?.details;
  if (!details || typeof details !== 'object') return null;
  for (const [key, field] of [['meetNoteDefault', 'note'], ['meetFormatDefault', 'format']] as const) {
    const messages = details[key];
    if (Array.isArray(messages) && typeof messages[0] === 'string') return { field, message: messages[0] };
  }
  return null;
}
