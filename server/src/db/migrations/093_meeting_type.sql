-- 093 — a confirmed meeting is audio or video (W-meet, 8 Sep 2026).
-- A 1:1 meeting is a real call the two people join on RSN; the type decides
-- whether the join opens with camera on. Null = a legacy day-part-only confirm.
ALTER TABLE dm_conversations
  ADD COLUMN IF NOT EXISTS meeting_type TEXT
    CHECK (meeting_type IN ('audio', 'video'));
