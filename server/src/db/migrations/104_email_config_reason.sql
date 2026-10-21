-- Migration 104: the subjects the admin dashboard lists for each email say REASON, not RSN (21 Oct 2026)
--
-- The client's 19 Oct feedback: "Call it REASON everywhere". Every email now goes out as REASON
-- (email.service.ts), and email_config.subject is the text the admin's email list shows for each
-- type. Migrations 020 and 082 seeded five of those with the word RSN in them:
--   magic_link              Your RSN login link
--   invite_platform         You're invited to RSN
--   join_request_approved   Your request to join RSN has been approved
--   join_request_declined   Update on your RSN join request
--   poke_request            {name} wants to meet you on RSN
--
-- This replaces the word RSN, as a whole word and in capitals, and nothing else: no other word,
-- no other column (enabled, updated_by and updated_at stay as an admin left them), no other row.
-- Migrations 020 and 082 are applied and are never edited.
--
-- [[:<:]] and [[:>:]] are Postgres's start and end of a word, written without a backslash so the
-- statement reads the same whatever standard_conforming_strings is set to.
--
-- Idempotent: once a subject no longer has the word RSN in it, the WHERE finds nothing to change.

UPDATE email_config
   SET subject = regexp_replace(subject, '[[:<:]]RSN[[:>:]]', 'REASON', 'g')
 WHERE subject ~ '[[:<:]]RSN[[:>:]]';
