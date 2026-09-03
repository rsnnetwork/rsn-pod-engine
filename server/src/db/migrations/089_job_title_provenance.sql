-- 089_job_title_provenance.sql — where a job title came from (13 Aug 2026, B1).
--
-- Stefan: "Bot pulls role/title from LinkedIn even when not explicitly set on
-- the profile — needs a prompt fix so it doesn't misattribute roles."
--
-- users.job_title is a MATCHING INPUT: the taxonomy buckets it exactly like a
-- role the member stated, so a guessed title changes who someone matches,
-- invisibly. Record where the title came from so the matcher can prefer a
-- stated role when naming an introduction, and so the guess can be told apart
-- from something the member typed.
--
--   stated   = the member typed it, said it in the onboarding chat, or edited
--              it on the confirm card
--   inferred = enrichment proposed it and the member accepted it unchanged
--   NULL     = written before 089; provenance unknown, treated as stated
ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title_source TEXT
  CHECK (job_title_source IN ('stated', 'inferred'));

COMMENT ON COLUMN users.job_title_source IS
  'stated = member typed/said/edited it; inferred = enrichment proposed it and it was accepted unchanged; NULL = pre-089, unknown';
