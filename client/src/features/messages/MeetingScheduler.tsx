// ─── Meeting Scheduler ───────────────────────────────────────────────────────
//
// REASON v1 Phase 2 (19 Jul 2026) — "setup availability to be introduced".
// Lives inside a 1:1 conversation. Each side taps the time windows that suit
// them (next 7 days × morning/afternoon/evening); windows you BOTH picked
// light up, and either side confirms one — that pins the meeting, drops a
// message in the thread, and notifies the partner. No calendars, no OAuth.

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CalendarCheck } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import api from '@/lib/api';
import { useToastStore } from '@/stores/toastStore';

interface Scheduling {
  conversationId: string;
  partnerId: string;
  mine: string[];
  theirs: string[];
  overlap: string[];
  confirmed: { window: string; byUserId: string; at: string } | null;
}

const DAYPARTS = [
  { key: 'morning', label: 'Morning' },
  { key: 'afternoon', label: 'Afternoon' },
  { key: 'evening', label: 'Evening' },
] as const;

/** Local-date key: what the user sees is what gets stored. */
function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function nextDays(n: number): Date[] {
  const out: Date[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    out.push(d);
  }
  return out;
}

function labelFor(windowKey: string): string {
  const [date, part] = windowKey.split(':');
  const d = new Date(`${date}T12:00:00`);
  const day = d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  return `${day}, ${part}`;
}

export default function MeetingScheduler({ conversationId }: { conversationId: string }) {
  const { addToast } = useToastStore();
  const queryClient = useQueryClient();
  const [staged, setStaged] = useState<Set<string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  const { data, isLoading } = useQuery<Scheduling>({
    queryKey: ['meetingScheduling', conversationId],
    queryFn: () => api.get(`/dm/conversations/${conversationId}/scheduling`).then(r => r.data.data),
    refetchInterval: 15_000, // partner's picks appear without a refresh
  });

  // Stage my saved selection once loaded (and re-sync after saves).
  useEffect(() => {
    if (data && staged === null) setStaged(new Set(data.mine));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  if (isLoading || !data) {
    return <div className="p-4 flex justify-center"><Spinner /></div>;
  }

  const days = nextDays(7);
  const mine = staged ?? new Set(data.mine);
  const theirSet = new Set(data.theirs);
  const dirty = staged !== null &&
    (staged.size !== data.mine.length || data.mine.some(w => !staged.has(w)));
  // Overlap against the SAVED server state — you can only confirm what both
  // sides have actually saved, not an unsaved local tap.
  const savedOverlap = data.overlap;

  const toggle = (key: string) => {
    const next = new Set(mine);
    if (next.has(key)) next.delete(key); else next.add(key);
    setStaged(next);
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await api.put(`/dm/conversations/${conversationId}/scheduling/availability`, {
        windows: [...mine],
      });
      await queryClient.invalidateQueries({ queryKey: ['meetingScheduling', conversationId] });
      setStaged(null); // re-sync from server
      addToast('Availability saved — they\'ll see when you both can.', 'success');
    } catch {
      addToast('Could not save availability — try again.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const confirm = async (windowKey: string) => {
    if (confirming) return;
    setConfirming(windowKey);
    try {
      await api.post(`/dm/conversations/${conversationId}/scheduling/confirm`, { window: windowKey });
      await queryClient.invalidateQueries({ queryKey: ['meetingScheduling', conversationId] });
      await queryClient.invalidateQueries({ queryKey: ['dmMessages'] });
      addToast('Meeting confirmed!', 'success');
    } catch (err: any) {
      addToast(err?.response?.data?.error?.message || 'Could not confirm that time.', 'error');
    } finally {
      setConfirming(null);
    }
  };

  return (
    <div className="border-b border-gray-200 bg-gray-50/60 px-3 py-3 space-y-3" data-testid="meeting-scheduler">
      {data.confirmed && (
        <div className="flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2">
          <CalendarCheck className="h-4 w-4 text-emerald-600 shrink-0" />
          <p className="text-sm text-emerald-700 font-medium">
            Meeting confirmed: {labelFor(data.confirmed.window)}
          </p>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full border-separate" style={{ borderSpacing: '3px' }}>
          <thead>
            <tr>
              <th className="text-left text-[11px] font-medium text-gray-400 px-1">Tap when you can</th>
              {DAYPARTS.map(p => (
                <th key={p.key} className="text-[11px] font-medium text-gray-500 pb-1">{p.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {days.map(d => {
              const dk = dateKey(d);
              return (
                <tr key={dk}>
                  <td className="text-xs text-gray-600 pr-2 whitespace-nowrap">
                    {d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}
                  </td>
                  {DAYPARTS.map(p => {
                    const key = `${dk}:${p.key}`;
                    const iPicked = mine.has(key);
                    const theyPicked = theirSet.has(key);
                    const both = iPicked && theyPicked;
                    return (
                      <td key={key} className="w-[30%]">
                        <button
                          onClick={() => toggle(key)}
                          aria-label={`${dk} ${p.key}${both ? ' — you both can' : theyPicked ? ' — they can' : iPicked ? ' — you can' : ''}`}
                          className={`w-full min-h-[44px] rounded-lg border text-[11px] font-medium transition-colors ${
                            both
                              ? 'bg-emerald-100 border-emerald-400 text-emerald-700'
                              : iPicked
                                ? 'bg-rsn-red-light border-rsn-red text-rsn-red'
                                : theyPicked
                                  ? 'bg-white border-gray-300 text-gray-500'
                                  : 'bg-white border-gray-200 text-gray-300 hover:border-gray-300'
                          }`}
                        >
                          {both ? 'Both can' : iPicked ? 'You' : theyPicked ? 'They can' : '—'}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-[11px] text-gray-400">
          Green = you both can. Save, then confirm a green time.
        </p>
        {dirty && (
          <Button size="sm" onClick={save} disabled={saving} className="min-h-[44px]">
            {saving ? 'Saving…' : 'Save availability'}
          </Button>
        )}
      </div>

      {savedOverlap.length > 0 && !data.confirmed && (
        <div className="space-y-1.5">
          {savedOverlap.map(w => (
            <button
              key={w}
              onClick={() => confirm(w)}
              disabled={confirming !== null}
              className="w-full min-h-[44px] flex items-center justify-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 text-sm font-medium text-emerald-700 hover:bg-emerald-100 transition-colors"
            >
              <Check className="h-4 w-4" />
              {confirming === w ? 'Confirming…' : `Confirm ${labelFor(w)}`}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
