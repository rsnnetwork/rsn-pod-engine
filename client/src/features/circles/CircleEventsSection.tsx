// ─── A circle's upcoming events (T13, 1 Nov 2026; 30 Oct review 6.5) ─────────────────────────────────────────────
//
// The circle's own events (made for everyone in it) and its pods' events, as the server lists them: each one only to
// someone who may open it (T2's D3, T11's access, T13's circle audience, T14's closed circle). The circle's own are
// marked. With none, the section says so, and its managers have "Schedule an event" in the header.
import { Link } from 'react-router-dom';
import { Calendar } from 'lucide-react';
import Card from '@/components/ui/Card';
import type { CircleDetail } from './circle-logic';

export default function CircleEventsSection({ circle }: { circle: Pick<CircleDetail, 'upcomingEvents'> }) {
  return (
    <div className="space-y-2 animate-fade-in-up" data-testid="circle-events">
      <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
        <Calendar className="h-4 w-4 text-rsn-red" /> Upcoming events
      </h2>
      {circle.upcomingEvents.length === 0 ? (
        <Card className="!p-4">
          <p className="text-sm text-gray-500" data-testid="circle-events-empty">No upcoming events yet.</p>
        </Card>
      ) : (
        /* grid-cols-1, not an auto track: an auto track grows to the longest truncated title
           in it, and the row (and with it the page) then scrolls sideways on a phone. */
        <div className="grid grid-cols-1 gap-2">
          {circle.upcomingEvents.map(e => (
            <Card key={e.id} className="card-hover !p-4">
              <Link to={`/sessions/${e.id}`} data-testid="circle-event" className="flex min-h-[44px] items-center justify-between gap-2">
                <span className="min-w-0">
                  <span className="block font-medium text-gray-900 truncate">{e.title}</span>
                  {e.forCircle && (
                    <span className="mt-1 inline-block rounded-full bg-rsn-red/10 px-2 py-0.5 text-[11px] font-medium text-rsn-red" data-testid="circle-event-for-circle">
                      For this circle
                    </span>
                  )}
                </span>
                <span className="text-xs text-gray-400 whitespace-nowrap">
                  {new Date(e.scheduledAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </span>
              </Link>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
