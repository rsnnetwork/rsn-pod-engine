// client/src/features/sessions/EventPlace.tsx
// Where an in-person event happens (30 Oct 2026, L18), on its page: the place as typed, wrapping on a phone, and an
// "Open in maps" link (a Google Maps search, so it opens the maps app on a phone). There is no video room, so the
// page says so instead of offering Go Live or Enter Event.
import { ExternalLink, MapPin } from 'lucide-react';
import { mapsUrl } from './event-format-form';

export default function EventPlace({ place, over }: { place: string; over: boolean }) {
  return (
    <div data-testid="event-place" className="mt-3 rounded-xl border border-gray-200 bg-gray-50 p-3">
      <p className="flex items-start gap-2 text-sm font-medium text-[#1a1a2e]">
        <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-rsn-red" />
        <span className="min-w-0 [overflow-wrap:anywhere]">{place}</span>
      </p>
      <a
        href={mapsUrl(place)}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-1 inline-flex min-h-[44px] items-center gap-1.5 text-sm font-semibold text-rsn-red hover:underline"
      >
        Open in maps <ExternalLink className="h-3.5 w-3.5" />
      </a>
      <p className="text-xs text-gray-500">
        {over ? 'This event happened in person.' : 'This event happens in person, so there is no video room. It ends itself at its end time.'}
      </p>
    </div>
  );
}
