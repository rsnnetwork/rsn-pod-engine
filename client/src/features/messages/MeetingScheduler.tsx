// ─── Meeting Scheduler ───────────────────────────────────────────────────────
//
// REASON v1 Phase 2 (19 Jul 2026) — "setup availability to be introduced".
// Lives inside a 1:1 conversation. Each side taps the time windows that suit
// them (next 7 days × morning/afternoon/evening); windows you BOTH picked
// light up, and either side confirms one — that pins the meeting, drops a
// message in the thread, and notifies the partner. No calendars, no OAuth.

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CalendarCheck, Video, Phone } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { E } from '@/realtime/entities';
import { Spinner } from '@/components/ui/Spinner';
import api from '@/lib/api';
import { useToastStore } from '@/stores/toastStore';

interface Scheduling {
  conversationId: string;
  partnerId: string;
  mine: string[];
  theirs: string[];
  overlap: string[];
  confirmed: { window: string; byUserId: string; at: string; startAt: string | null; durationMin: number | null; type: 'audio' | 'video' | null } | null;
  /** The partner changed availability since I last opened the scheduler. */
  schedulingUpdated?: boolean;
}

// Sensible default start hour for each daypart when finalising an exact time.
const DAYPART_DEFAULT_TIME: Record<string, string> = { morning: '09:00', afternoon: '14:00', evening: '18:00' };

/** Build an "Add to Google Calendar" link (opens a prefilled event, no OAuth). */
function googleCalUrl(startAtIso: string, durationMin: number): string {
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const start = new Date(startAtIso);
  const end = new Date(start.getTime() + durationMin * 60_000);
  const p = new URLSearchParams({ action: 'TEMPLATE', text: 'RSN meeting', dates: `${fmt(start)}/${fmt(end)}` });
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

/** The viewer's own local rendering of an absolute instant. */
function localWhen(startAtIso: string): string {
  return new Date(startAtIso).toLocaleString([], {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
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

/**
 * A pinned banner at the top of the thread showing the confirmed meeting to
 * BOTH people — real local time, duration, audio/video, and a Join button —
 * so the meeting is visible in the chat, not buried in the scheduler (Ali,
 * 8 Sep 2026). Shares the scheduling query cache with the scheduler panel.
 */
export function ThreadMeetingBanner({ conversationId }: { conversationId: string }) {
  const navigate = useNavigate();
  const { data } = useQuery<Scheduling>({
    queryKey: ['meetingScheduling', conversationId],
    queryFn: () => api.get(`/dm/conversations/${conversationId}/scheduling`).then(r => r.data.data),
    meta: { entities: [E.dmConversation(conversationId)] },
  });
  const c = data?.confirmed;
  if (!c || !c.startAt) return null;
  return (
    <div className="border-b border-emerald-200 bg-emerald-50 px-4 py-2.5" data-testid="thread-meeting-banner">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <CalendarCheck className="h-4 w-4 shrink-0 text-emerald-600" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-emerald-800">{localWhen(c.startAt)}</p>
            <p className="text-[11px] text-emerald-700">
              {c.type === 'audio' ? 'Audio call' : 'Video call'} · {c.durationMin} min · your local time
            </p>
          </div>
        </div>
        <button
          onClick={() => navigate(`/meet/${conversationId}?kind=${c.type ?? 'video'}&scheduled=1`)}
          className="inline-flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-sm font-medium text-white hover:bg-emerald-700"
        >
          {c.type === 'audio' ? <Phone className="h-4 w-4" /> : <Video className="h-4 w-4" />} Join
        </button>
      </div>
    </div>
  );
}

export default function MeetingScheduler({ conversationId }: { conversationId: string }) {
  const { addToast } = useToastStore();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [staged, setStaged] = useState<Set<string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  // The daypart the user is finalising into an exact time, plus their picks.
  const [finalizing, setFinalizing] = useState<string | null>(null);
  const [startTime, setStartTime] = useState('14:00');
  const [durationMin, setDurationMin] = useState(30);
  const [meetingKind, setMeetingKind] = useState<'audio' | 'video'>('video');

  const { data, isLoading } = useQuery<Scheduling>({
    queryKey: ['meetingScheduling', conversationId],
    queryFn: () => api.get(`/dm/conversations/${conversationId}/scheduling`).then(r => r.data.data),
    refetchInterval: 15_000, // partner's picks appear without a refresh
    // The confirmed window lives on dm_conversations, so a confirm on either
    // side (which emits the dm-conversation entity) refreshes this panel live.
    meta: { entities: [E.dmConversation(conversationId)] },
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

  // Open the exact-time step for a green overlap window.
  const openFinalize = (windowKey: string) => {
    const part = windowKey.split(':')[1];
    setStartTime(DAYPART_DEFAULT_TIME[part] ?? '14:00');
    setDurationMin(30);
    setFinalizing(windowKey);
  };

  const confirm = async (windowKey: string) => {
    if (confirming) return;
    setConfirming(windowKey);
    try {
      // Combine the confirmed day with the chosen local time into an absolute
      // instant (toISOString), so the server stores one instant and every
      // client renders it in its own timezone.
      const day = windowKey.split(':')[0];
      const startAt = new Date(`${day}T${startTime}:00`).toISOString();
      await api.post(`/dm/conversations/${conversationId}/scheduling/confirm`, { window: windowKey, startAt, durationMin, type: meetingKind });
      setFinalizing(null);
      await queryClient.invalidateQueries({ queryKey: ['meetingScheduling', conversationId] });
      // The confirmation message lands in the thread — invalidate the REAL
      // thread key (['dm-messages', id]); the old ['dmMessages'] key matched
      // nothing, so the confirmer never saw their own confirmation appear.
      await queryClient.invalidateQueries({ queryKey: ['dm-messages', conversationId] });
      await queryClient.invalidateQueries({ queryKey: ['dm-conversations'] });
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
        <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <CalendarCheck className="h-4 w-4 text-emerald-600 shrink-0" />
            <p className="text-sm text-emerald-800 font-semibold">
              {data.confirmed.startAt
                ? `Meeting confirmed — ${localWhen(data.confirmed.startAt)}`
                : `Meeting confirmed: ${labelFor(data.confirmed.window)}`}
            </p>
          </div>
          {data.confirmed.startAt && (
            <div className="mt-1 pl-6 space-y-1.5">
              <p className="text-xs text-emerald-700">
                {(data.confirmed.type === 'audio' ? 'Audio call' : 'Video call')} · {data.confirmed.durationMin} minutes · shown in your local time
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => navigate(`/meet/${conversationId}?kind=${data.confirmed?.type ?? 'video'}&scheduled=1`)}
                  className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-sm font-medium text-white hover:bg-emerald-700"
                >
                  {data.confirmed.type === 'audio' ? <Phone className="h-4 w-4" /> : <Video className="h-4 w-4" />} Join
                </button>
                <a
                  href={googleCalUrl(data.confirmed.startAt, data.confirmed.durationMin ?? 30)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-medium text-emerald-700 underline hover:text-emerald-900"
                >
                  Add to Google Calendar
                </a>
              </div>
              <p className="text-[11px] text-emerald-600">A calendar invite was emailed to you both.</p>
            </div>
          )}
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
            finalizing === w ? (
              <div key={w} className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 space-y-2">
                <p className="text-xs font-medium text-emerald-800">Pick a start time for {labelFor(w)}</p>
                <div className="flex items-center gap-2 flex-wrap">
                  <label className="text-[11px] text-emerald-700">Start
                    <input
                      type="time"
                      value={startTime}
                      onChange={e => setStartTime(e.target.value)}
                      className="ml-1 rounded border border-emerald-300 bg-white px-2 py-1 text-sm text-gray-800"
                    />
                  </label>
                  <label className="text-[11px] text-emerald-700">For
                    <select
                      value={durationMin}
                      onChange={e => setDurationMin(Number(e.target.value))}
                      className="ml-1 rounded border border-emerald-300 bg-white px-2 py-1 text-sm text-gray-800"
                    >
                      <option value={30}>30 min</option>
                      <option value={45}>45 min</option>
                      <option value={60}>60 min</option>
                    </select>
                  </label>
                  <div className="inline-flex overflow-hidden rounded-lg border border-emerald-300">
                    {(['video', 'audio'] as const).map(k => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setMeetingKind(k)}
                        className={`inline-flex min-h-[36px] items-center gap-1 px-2.5 text-xs font-medium ${meetingKind === k ? 'bg-emerald-600 text-white' : 'bg-white text-emerald-700'}`}
                      >
                        {k === 'video' ? <Video className="h-3.5 w-3.5" /> : <Phone className="h-3.5 w-3.5" />}
                        {k === 'video' ? 'Video' : 'Audio'}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="text-[11px] text-emerald-600">
                  {(() => { try { return `That is ${localWhen(new Date(`${w.split(':')[0]}T${startTime}:00`).toISOString())} your time.`; } catch { return ''; } })()}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => confirm(w)}
                    disabled={confirming !== null}
                    className="flex-1 min-h-[44px] flex items-center justify-center gap-2 rounded-lg bg-emerald-600 text-sm font-medium text-white hover:bg-emerald-700 transition-colors disabled:opacity-50"
                  >
                    <Check className="h-4 w-4" />
                    {confirming === w ? 'Confirming…' : 'Confirm meeting'}
                  </button>
                  <button
                    onClick={() => setFinalizing(null)}
                    disabled={confirming !== null}
                    className="min-h-[44px] rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-600 hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                key={w}
                onClick={() => openFinalize(w)}
                disabled={confirming !== null}
                className="w-full min-h-[44px] flex items-center justify-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 text-sm font-medium text-emerald-700 hover:bg-emerald-100 transition-colors"
              >
                <Check className="h-4 w-4" />
                {`Confirm ${labelFor(w)}`}
              </button>
            )
          ))}
        </div>
      )}
    </div>
  );
}
