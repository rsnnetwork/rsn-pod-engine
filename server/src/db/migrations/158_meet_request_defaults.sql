-- server/src/db/migrations/158_meet_request_defaults.sql
-- Stefan (21 Nov 2026): "I should be able in my profile to state my 'standard message' and preferred format". A member
-- keeps the note a meeting request starts with and the format it proposes, and the Meet sheet opens on them (the member
-- can still change both for each request).
--
-- users.meet_note_default: the note, at most 300 characters (MEET_NOTE_MAX in shared/src/types/reason.ts, which the
-- route and the form count against). It may hold {first}, which the Meet sheet turns into the person's first name.
-- NULL: the member keeps REASON's own default note.
-- users.meet_format_default: one of the keys of MEETING_FORMATS, the same list as user_pokes.preferred_format's CHECK
-- (migration 101). NULL: the sheet proposes the 20 minute video conversation.
--
-- Each CHECK is dropped by name before it is added, so the file is safe to run twice. Nothing reads these columns in a
-- WHERE or a JOIN (only the member's own row by id), so no index. No BEGIN/COMMIT: the runner wraps this file in its
-- own transaction.

ALTER TABLE users ADD COLUMN IF NOT EXISTS meet_note_default TEXT NULL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_meet_note_default_length;
ALTER TABLE users ADD CONSTRAINT users_meet_note_default_length CHECK (char_length(meet_note_default) <= 300);

ALTER TABLE users ADD COLUMN IF NOT EXISTS meet_format_default TEXT NULL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_meet_format_default_check;
ALTER TABLE users ADD CONSTRAINT users_meet_format_default_check
  CHECK (meet_format_default IN ('video_20', 'coffee', 'message_first'));
