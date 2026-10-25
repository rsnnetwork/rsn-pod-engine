-- 109 — every onboarding question is "select all that apply" (25 Oct 2026).
--
-- Stefan and Claus, 25 Oct (ONB-01): no question has answers that rule each other out. A founder can
-- invest, and a student can freelance. 100 held looking_to_meet to 3 and self_kinds to 2, and 106 held
-- hoping_to_find to 3, as CHECK constraints under the screens, so lifting the limits in Zod or on a screen
-- alone would end in a database error. Version 1 and version 2 keys share these columns, so the caps go for
-- both. Production's version 1 screens still stop themselves at three and two, so nothing a member sees
-- changes until a screen sends more.
--
-- In their place, a ceiling of 20 for each list: a guard against a runaway request, never a limit a member
-- meets, since no question has 20 answers. The server holds each list to the same 20
-- (ONBOARDING_V2_LIMITS.ceiling in @rsn/shared).
--
-- Idempotent: each cap is dropped only if it is there, and each ceiling added only if it is not. No row is
-- touched (every stored list is within its old cap, far below 20), and nothing else is dropped. No
-- BEGIN/COMMIT (the runner wraps each file).

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_looking_to_meet_max,
  DROP CONSTRAINT IF EXISTS users_self_kinds_max,
  DROP CONSTRAINT IF EXISTS users_hoping_to_find_max;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_looking_to_meet_ceiling') THEN
    ALTER TABLE users ADD CONSTRAINT users_looking_to_meet_ceiling
      CHECK (cardinality(looking_to_meet) <= 20);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_self_kinds_ceiling') THEN
    ALTER TABLE users ADD CONSTRAINT users_self_kinds_ceiling
      CHECK (cardinality(self_kinds) <= 20);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_hoping_to_find_ceiling') THEN
    ALTER TABLE users ADD CONSTRAINT users_hoping_to_find_ceiling
      CHECK (cardinality(hoping_to_find) <= 20);
  END IF;
END $$;
