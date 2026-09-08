-- Migration 098: concrete time slots for meeting availability (Stefan, 9 Sep 2026)
--
-- "Morning / afternoon / evening is too vague; show specific available times
-- directly." Availability is now picked as 30-minute slots stored as UTC
-- instants ('2026-09-10T13:30:00Z'), so two people in different timezones
-- overlap on the same instant and each sees it in their own local time.
-- Legacy day-part keys stay valid so existing rows remain readable until they
-- age out of the 30-day horizon.

ALTER TABLE meeting_availability
  DROP CONSTRAINT IF EXISTS meeting_availability_window_key_check;

ALTER TABLE meeting_availability
  ADD CONSTRAINT meeting_availability_window_key_check
  CHECK (
    window_key ~ '^\d{4}-\d{2}-\d{2}:(morning|afternoon|evening)$'
    OR window_key ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$'
  );
