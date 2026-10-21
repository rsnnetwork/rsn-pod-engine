// ─── Screen 7: "Time zone: Asia/Kathmandu [Change]" ────────────────────────
//
// Detected by the browser, shown as the zone's own name, and changed from a
// searchable list of every zone the browser knows: a bottom sheet on a phone,
// a dialog from 768px. Only the member sees it; meeting times are shown in it.

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import Sheet from '@/features/reason/ui/Sheet';
import OnlyYou from './OnlyYou';
import { PROFILE, searchZones, zoneLabel, zoneList } from './flow';

interface Props {
  zone: string | null;
  onChange: (zone: string) => void;
  /** The server's refusal of this zone, said under it. */
  error?: string | null;
}

export default function TimeZoneField({ zone, onChange, error = null }: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const zones = useMemo(() => zoneList(zone), [zone]);
  const shown = useMemo(() => searchZones(zones, query), [zones, query]);
  const list = useRef<HTMLUListElement>(null);

  // The list opens on their own zone, not on "Africa/Abidjan" four hundred names away.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      list.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'center' });
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">Time zone</p>
        <p className="mt-0.5 break-words text-[15px]" data-testid="time-zone">{zone ? zoneLabel(zone) : 'Not set yet'}</p>
        <OnlyYou className="mt-1.5" />
        {error && <p className="mt-1.5 text-sm text-rsn-red" role="alert">{error}</p>}
      </div>
      <Button
        variant="outline"
        onClick={() => { setQuery(''); setOpen(true); }}
        className="min-h-[44px] shrink-0 bg-white px-4"
        aria-label={`${PROFILE.change} time zone`}
      >
        {PROFILE.change}
      </Button>

      <Sheet open={open} onClose={() => setOpen(false)} title="Choose your time zone">
        <div className="sticky top-0 z-10 bg-white pb-2 pt-3">
          <label htmlFor={`${id}-search`} className="sr-only">Search time zones</label>
          <input
            id={`${id}-search`}
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search, for example Kathmandu"
            autoComplete="off"
            enterKeyHint="search"
            className="h-12 w-full rounded-xl border border-gray-300 bg-white px-3 text-base text-[#1a1a2e] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-rsn-red sm:text-sm"
          />
        </div>
        {shown.length ? (
          <ul ref={list} className="pb-2" aria-label="Time zones">
            {shown.map(z => (
              <li key={z}>
                <button
                  type="button"
                  onClick={() => { onChange(z); setOpen(false); }}
                  aria-current={z === zone ? 'true' : undefined}
                  className={`flex min-h-[44px] w-full items-center justify-between gap-3 rounded-lg px-3 text-left text-[15px] hover:bg-gray-50 ${
                    z === zone ? 'font-semibold text-rsn-red' : ''
                  }`}
                >
                  <span className="min-w-0 break-words">{zoneLabel(z)}</span>
                  {z === zone && <Check className="h-4 w-4 shrink-0" aria-hidden />}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-6 text-center text-sm text-gray-600" role="status">No time zone matches “{query.trim()}”. Try a city or a region.</p>
        )}
      </Sheet>
    </div>
  );
}
