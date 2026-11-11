// client/src/features/sessions/EventZoneField.tsx
// The event's time zone on Schedule an Event and Edit Event (10 Nov 2026 spec, Part 3 item 1; plan K1), under the
// date: "Times are shown in Europe/Copenhagen (CET, GMT+1)." and the zone with [Change], the onboarding screen's own
// searchable list (TimeZoneField). The date field above holds the time on THIS zone's clock; changing the zone keeps
// the wall clock (14:00 stays 14:00, now Copenhagen's). The note names the zone as it is on the chosen date, so a
// summer date says CEST. It replaces "Shown in your local time … Each person sees the event in their own timezone",
// which the spec contradicts: an event has one zone, and everyone reads its times in it.
import type { UseFormReturn } from 'react-hook-form';
import TimeZoneField from '@/features/onboarding/TimeZoneField';
import { timeZoneLabel, zonedWallTimeToUtc } from '@/lib/event-time';
import { FIELD_SCROLL_MARGINS } from './EventFormatFields';
import type { EventFormValues } from './event-format-form';

export default function EventZoneField({ form }: { form: UseFormReturn<EventFormValues> }) {
  const { watch, setValue, clearErrors, formState: { errors } } = form;
  const zone = watch('timezone');
  const scheduledAt = watch('scheduledAt');
  const at = scheduledAt ? zonedWallTimeToUtc(scheduledAt, zone) : null;
  const choose = (next: string) => {
    setValue('timezone', next, { shouldDirty: true });
    clearErrors('timezone');
  };
  return (
    <div className={FIELD_SCROLL_MARGINS} data-testid="event-zone-field">
      <p className="mt-1 text-xs text-gray-500" data-testid="event-zone-note">
        Times are shown in {timeZoneLabel(zone, at ? new Date(at) : undefined)}.
      </p>
      <div className="mt-3">
        <TimeZoneField
          zone={zone}
          onChange={choose}
          error={errors.timezone?.message}
          sheetTitle="Choose the event's time zone"
          onlyYou={false}
          name="timezone"
        />
      </div>
    </div>
  );
}
