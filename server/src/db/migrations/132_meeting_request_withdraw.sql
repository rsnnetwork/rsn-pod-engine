-- 132 — a meeting request can be withdrawn (10 Nov 2026)
--
-- Stefan: "if I have ALREADY asked them, why is that not shown?" Every place a member can ask to meet someone now
-- shows "Request sent", with "Withdraw request" beside it. Withdrawing marks the request 'cancelled' (cancelled_at
-- says when). A withdrawn request is as if it had never been sent: it is not "asked", not "connected", not a "no",
-- and the member may ask again. The partial unique index from 047 (one PENDING request per direction per pair)
-- already lets a new request follow a cancelled one.
--
-- 047's status CHECK is an unnamed column CHECK, so Postgres named it user_pokes_status_check. It is dropped and
-- added again under the same name with the new value. Every row already in the table is pending, accepted or
-- declined, so the new CHECK holds for all of them. Idempotent (IF EXISTS / IF NOT EXISTS).
-- No BEGIN/COMMIT: the runner wraps this file in its own transaction.

ALTER TABLE user_pokes DROP CONSTRAINT IF EXISTS user_pokes_status_check;
ALTER TABLE user_pokes
  ADD CONSTRAINT user_pokes_status_check CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled'));

ALTER TABLE user_pokes ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ NULL;
