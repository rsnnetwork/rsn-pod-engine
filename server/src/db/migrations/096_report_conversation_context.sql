-- Migration 096: report → conversation context (8 Sep 2026, Ali)
--
-- When a member reports someone from the message chat, admins should be able to
-- open the conversation to see what happened. Link the report to its DM
-- conversation so the moderation queue can offer "view the chat". Nullable:
-- a report filed from a profile page has no conversation.

ALTER TABLE user_reports
  ADD COLUMN IF NOT EXISTS conversation_id UUID
    REFERENCES dm_conversations(id) ON DELETE SET NULL;
