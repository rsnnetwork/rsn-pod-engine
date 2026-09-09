// ─── Meeting Scheduler ───────────────────────────────────────────────────────
//
// REASON v1 Phase 2 (19 Jul 2026) — "setup availability to be introduced".
// Lives inside a 1:1 conversation. Each side taps the concrete 30-minute times
// that suit them (next 7 days, 08:00–20:00 in THEIR OWN local time); a slot is
// stored as a UTC instant, so two people in different timezones overlap on the
// same moment. Times you BOTH picked light up green, and either side confirms
// one — that pins the meeting (exact time + custom length + audio/video),
// drops a message in the thread, and notifies the partner. No calendars, no
// OAuth. 9 Sep 2026 (Stefan): replaced the vague morning/afternoon/evening grid.

import { useEffect, useMemo, useRef, useState } from 'react';
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
  /** Calls unlock once this pair's first scheduled meeting has happened. */
  callsUnlocked?: boolean;
}

// ── Slots ────────────────────────────────────────────────────────────────────

const SLOT_MINUTES = 30;
const WORK_START_HOUR = 8; // where the day's timeline opens by default (local)
const DAYS_AHEAD = 7;
const MIN_DURATION = 5;
const MAX_DURATION = 240;
const SLOT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/;
const ISO_INSTANT_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g;

function isSlotKey(key: string): boolean {
  return SLOT_RE.test(key);
}

/** A local Date → the slot key the server stores (a UTC instant). */
function slotKey(d: Date): string {
  return d.toISOString().replace('.000Z', 'Z');
}

/** The viewer's own local rendering of an absolute instant. */
function localWhen(startAtIso: string): string {
  return new Date(startAtIso).toLocaleString([], {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

function localTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function localDay(d: Date): string {
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}

/**
 * A thread line like "📅 Meeting confirmed: 2026-09-10T13:30:00Z · 20 min video
 * call" is one shared text for both people; render the instant in THIS
 * reader's local time. Used by the thread bubble and the inbox preview.
 */
export function localizeMeetingText(text: string): string {
  return text.replace(ISO_INSTANT_RE, (iso) => localWhen(iso));
}

/** Human label for any key: a slot in local time, or a legacy day-part. */
function labelFor(windowKey: string): string {
  if (isSlotKey(windowKey)) {
    const d = new Date(windowKey);
    return `${localDay(d)}, ${localTime(windowKey)}`;
  }
  const [date, part] = windowKey.split(':');
  const d = new Date(`${date}T12:00:00`);
  return `${localDay(d)}, ${part}`;
}

/** The next N local calendar days, each at local midnight. */
function nextDays(n: number): Date[] {
  const out: Date[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + i);
    out.push(d);
  }
  return out;
}

/** Every half hour of one local day, 00:00–23:30, as UTC-instant keys. The
 *  whole day lives in one scrollable timeline (Ali, 9 Sep): a typed time is
 *  just one of these, scrolled into view. */
function daySlots(day: Date): string[] {
  const out: string[] = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += SLOT_MINUTES) {
      out.push(slotKey(new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m)));
    }
  }
  return out;
}

/** Local calendar day of a Date / slot key: 'YYYY-MM-DD' in the viewer's zone. */
function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dayOfKey(iso: string): string {
  return localDayKey(new Date(iso));
}

/** 'HH:MM' typed into the custom field → a half-hour slot on that local day, or null. */
function customSlot(day: Date, hhmm: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  const rounded = Math.round(min / SLOT_MINUTES) * SLOT_MINUTES; // 60 rolls into the next hour
  return slotKey(new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, rounded));
}

/** A slot is in the past once its own half hour has gone by. */
function isPastSlot(key: string): boolean {
  return new Date(key).getTime() < Date.now() - SLOT_MINUTES * 60_000;
}

// A meeting stays joinable until 30 min after its end (overruns/reconnects);
// after that it's "ended" and the card offers a fresh call instead (Ali, 8 Sep).
const MEETING_GRACE_MS = 30 * 60 * 1000;
export function isMeetingOver(startAtIso: string | null | undefined, durationMin: number | null | undefined): boolean {
  if (!startAtIso) return false;
  const end = new Date(startAtIso).getTime() + ((durationMin ?? 30) * 60_000) + MEETING_GRACE_MS;
  return Date.now() > end;
}

/**
 * A pinned banner at the top of the thread showing the confirmed meeting to
 * BOTH people — real local time, duration, audio/video, and a Join button —
 * so the meeting is visible in the chat, not buried in the scheduler (Ali,
 * 8 Sep 2026). Shares the scheduling query cache with the scheduler panel.
 */
export function ThreadMeetingBanner({ conversationId, onCallNow }: { conversationId: string; onCallNow?: (kind: 'audio' | 'video') => void }) {
  const navigate = useNavigate();
  const { data } = useQuery<Scheduling>({
    queryKey: ['meetingScheduling', conversationId],
    queryFn: () => api.get(`/dm/conversations/${conversationId}/scheduling`).then(r => r.data.data),
    meta: { entities: [E.dmConversation(conversationId)] },
  });
  const c = data?.confirmed;
  if (!c || !c.startAt) return null;
  const kind = c.type ?? 'video';
  const over = isMeetingOver(c.startAt, c.durationMin);
  // "Call now" after an ended meeting only makes sense once calls are unlocked
  // (both attended). If it ended without that, they pick a new time instead.
  const unlocked = !!data?.callsUnlocked;
  return (
    <div
      className={`border-b px-4 py-2.5 ${over ? 'border-gray-200 bg-gray-50' : 'border-emerald-200 bg-emerald-50'}`}
      data-testid="thread-meeting-banner"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <CalendarCheck className={`h-4 w-4 shrink-0 ${over ? 'text-gray-400' : 'text-emerald-600'}`} />
          <div className="min-w-0">
            <p className={`truncate text-sm font-semibold ${over ? 'text-gray-600' : 'text-emerald-800'}`}>
              {over ? 'Meeting ended' : localWhen(c.startAt)}
            </p>
            <p className={`text-[11px] ${over ? 'text-gray-400' : 'text-emerald-700'}`}>
              {over
                ? `${kind === 'audio' ? 'Audio call' : 'Video call'} · ${localWhen(c.startAt)}`
                : `${kind === 'audio' ? 'Audio call' : 'Video call'} · ${c.durationMin} min · your local time`}
            </p>
          </div>
        </div>
        {over ? (
          unlocked ? (
            <button
              onClick={() => onCallNow?.(kind)}
              className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-lg bg-rsn-red px-3 text-sm font-medium text-white hover:opacity-90"
            >
              {kind === 'audio' ? <Phone className="h-4 w-4" /> : <Video className="h-4 w-4" />} Call now
            </button>
          ) : (
            <span className="text-xs text-gray-500">Pick a new time to meet.</span>
          )
        ) : (
          <button
            onClick={() => navigate(`/meet/${conversationId}?kind=${kind}&scheduled=1`)}
            className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-sm font-medium text-white hover:bg-emerald-700"
          >
            {kind === 'audio' ? <Phone className="h-4 w-4" /> : <Video className="h-4 w-4" />} Join
          </button>
        )}
      </div>
    </div>
  );
}

const OVERLAP_PREVIEW = 8;

// Unsaved picks and the typed length survive the panel closing (it closes
// on any outside click) — kept per conversation until saved or the page goes.
const drafts = new Map<string, { staged: Set<string> | null; duration: string }>();

export default function MeetingScheduler({ conversationId }: { conversationId: string }) {
  const { addToast } = useToastStore();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [staged, setStaged] = useState<Set<string> | null>(() => drafts.get(conversationId)?.staged ?? null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  // The overlap slot being confirmed. The length and kind are typed up front
  // (Ali, 9 Sep: "what if the user only has 10 minutes") and used on confirm.
  const [finalizing, setFinalizing] = useState<string | null>(null);
  const [durationText, setDurationText] = useState(() => drafts.get(conversationId)?.duration ?? '30');
  const [meetingKind, setMeetingKind] = useState<'audio' | 'video'>('video');
  const draftRef = useRef({ staged, duration: durationText });
  draftRef.current = { staged, duration: durationText };
  useEffect(() => () => { drafts.set(conversationId, draftRef.current); }, [conversationId]);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [showAllOverlap, setShowAllOverlap] = useState(false);
  const [customTime, setCustomTime] = useState('');
  // The day's timeline scrolls inside one frame; these bring a slot into view.
  const gridRef = useRef<HTMLDivElement>(null);
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  const [flashKey, setFlashKey] = useState<string | null>(null);

  const { data, isLoading } = useQuery<Scheduling>({
    queryKey: ['meetingScheduling', conversationId],
    queryFn: () => api.get(`/dm/conversations/${conversationId}/scheduling`).then(r => r.data.data),
    refetchInterval: 15_000, // partner's picks appear without a refresh
    // The confirmed window lives on dm_conversations, so a confirm on either
    // side (which emits the dm-conversation entity) refreshes this panel live.
    meta: { entities: [E.dmConversation(conversationId)] },
  });

  // Stage my saved selection once loaded (and re-sync after saves). Legacy
  // day-part picks are not shown or re-saved — they age out.
  useEffect(() => {
    if (data && staged === null) setStaged(new Set(data.mine.filter(isSlotKey)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const days = useMemo(() => nextDays(DAYS_AHEAD), []);
  const slotsByDay = useMemo(
    () => days.map(d => ({ day: d, key: slotKey(d), dayKey: localDayKey(d), defaults: daySlots(d) })),
    [days],
  );

  const mine = staged ?? new Set((data?.mine ?? []).filter(isSlotKey));
  const theirSet = useMemo(() => new Set((data?.theirs ?? []).filter(isSlotKey)), [data]);

  // Until the member picks a day, open on the first day where you both can,
  // else where they can, else the first day that still has a free slot — so
  // what matters is visible at once. Derived (not an effect) so the strip
  // never paints today first and then jumps. Custom (off-grid) times count.
  const autoDay = useMemo(() => {
    const savedMine = (data?.mine ?? []).filter(isSlotKey);
    const bothDays = new Set(savedMine.filter(k => theirSet.has(k)).map(dayOfKey));
    const theirDays = new Set([...theirSet].map(dayOfKey));
    const both = slotsByDay.find(d => bothDays.has(d.dayKey));
    const theirs = slotsByDay.find(d => theirDays.has(d.dayKey));
    const open = slotsByDay.find(d => d.defaults.some(k => !isPastSlot(k)));
    return (both ?? theirs ?? open ?? slotsByDay[0]).key;
  }, [data, slotsByDay, theirSet]);

  const currentKey = slotsByDay.find(d => d.key === (selectedDay ?? autoDay))?.key ?? slotsByDay[0].key;

  // Opening a day: scroll its timeline to what matters — a time you both
  // can, else yours, else theirs, else the first time still ahead (from the
  // working day on). Runs per day, not per tap, so toggling never jumps.
  useEffect(() => {
    const box = gridRef.current;
    const day = slotsByDay.find(d => d.key === currentKey);
    if (!box || !day || !data) return;
    const savedMine = new Set(data.mine.filter(isSlotKey));
    const theirs = new Set(data.theirs.filter(isSlotKey));
    const target =
      day.defaults.find(k => savedMine.has(k) && theirs.has(k)) ??
      day.defaults.find(k => savedMine.has(k)) ??
      day.defaults.find(k => theirs.has(k)) ??
      day.defaults.find(k => !isPastSlot(k) && new Date(k).getHours() >= WORK_START_HOUR) ??
      day.defaults.find(k => !isPastSlot(k)) ??
      day.defaults[0];
    const el = box.querySelector<HTMLElement>(`[data-slot="${target}"]`);
    if (el) box.scrollTop = Math.max(0, el.offsetTop - 4);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey, !!data]);

  // A typed time: bring it into view and flash it so the eye lands on it.
  useEffect(() => {
    if (!scrollTo) return;
    const box = gridRef.current;
    const el = box?.querySelector<HTMLElement>(`[data-slot="${scrollTo}"]`);
    if (box && el) {
      const top = el.offsetTop - 4;
      const bottom = el.offsetTop + el.offsetHeight + 4;
      if (top < box.scrollTop || bottom > box.scrollTop + box.clientHeight) {
        box.scrollTop = Math.max(0, top - Math.round((box.clientHeight - el.offsetHeight) / 2));
      }
    }
    setFlashKey(scrollTo);
    setScrollTo(null);
    const t = setTimeout(() => setFlashKey(null), 1600);
    return () => clearTimeout(t);
  }, [scrollTo]);

  if (isLoading || !data) {
    return <div className="p-4 flex justify-center"><Spinner /></div>;
  }

  const savedMine = data.mine.filter(isSlotKey);
  const dirty = staged !== null &&
    (staged.size !== savedMine.length || savedMine.some(w => !staged.has(w)));
  // Overlap against the SAVED server state — you can only confirm what both
  // sides have actually saved, not an unsaved local tap.
  const savedOverlap = data.overlap.filter(isSlotKey).filter(k => !isPastSlot(k)).sort();
  const current = slotsByDay.find(d => d.key === (selectedDay ?? autoDay)) ?? slotsByDay[0];
  const slots = current.defaults;

  const toggle = (key: string) => {
    const next = new Set(mine);
    if (next.has(key)) next.delete(key); else next.add(key);
    setStaged(next);
  };

  // Any time of day (Ali, 9 Sep): type it, it becomes a selected chip in its
  // place on the timeline and scrolls into view. Half-hour steps so two
  // people can land on the same instant.
  const addCustomTime = () => {
    const key = customSlot(current.day, customTime);
    if (!key) { addToast('Enter a time like 21:30.', 'error'); return; }
    if (isPastSlot(key)) { addToast('That time has already passed.', 'error'); return; }
    if (!mine.has(key)) setStaged(new Set([...mine, key]));
    setCustomTime('');
    setScrollTo(key);
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
      drafts.delete(conversationId);
      addToast('Availability saved — they\'ll see when you both can.', 'success');
    } catch {
      addToast('Could not save availability — try again.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const openFinalize = (key: string) => {
    setFinalizing(key);
  };

  const durationMin = Number(durationText);
  const durationOk = Number.isInteger(durationMin) && durationMin >= MIN_DURATION && durationMin <= MAX_DURATION;

  const confirm = async (key: string) => {
    if (confirming || !durationOk) return;
    setConfirming(key);
    try {
      // The slot IS the instant — the server stores it and every client
      // renders it in its own timezone.
      await api.post(`/dm/conversations/${conversationId}/scheduling/confirm`, { window: key, durationMin, type: meetingKind });
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

  // "Add to calendar" — a universal .ics download (Google, Outlook, Apple…),
  // not a Google-only link (Stefan, 9 Sep 2026).
  const downloadIcs = async () => {
    try {
      const res = await api.get(`/dm/conversations/${conversationId}/meeting.ics`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data], { type: 'text/calendar' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'rsn-meeting.ics';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      addToast('Could not build the calendar file — try again.', 'error');
    }
  };

  const confirmedOver = isMeetingOver(data.confirmed?.startAt, data.confirmed?.durationMin);
  const overlapShown = showAllOverlap ? savedOverlap : savedOverlap.slice(0, OVERLAP_PREVIEW);

  return (
    <div className="border-b border-gray-200 bg-gray-50/60 px-3 py-3 space-y-3" data-testid="meeting-scheduler">
      {data.confirmed && (
        <div className={`rounded-lg border px-3 py-2.5 ${confirmedOver ? 'bg-gray-50 border-gray-200' : 'bg-emerald-50 border-emerald-200'}`}>
          <div className="flex items-center gap-2">
            <CalendarCheck className={`h-4 w-4 shrink-0 ${confirmedOver ? 'text-gray-400' : 'text-emerald-600'}`} />
            <p className={`text-sm font-semibold ${confirmedOver ? 'text-gray-600' : 'text-emerald-800'}`}>
              {confirmedOver
                ? 'Meeting ended'
                : data.confirmed.startAt
                  ? `Meeting confirmed — ${localWhen(data.confirmed.startAt)}`
                  : `Meeting confirmed: ${labelFor(data.confirmed.window)}`}
            </p>
          </div>
          {data.confirmed.startAt && !confirmedOver && (
            <div className="mt-1 pl-6 space-y-1.5">
              <p className="text-xs text-emerald-700">
                {(data.confirmed.type === 'audio' ? 'Audio call' : 'Video call')} · {data.confirmed.durationMin} minutes · shown in your local time
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => navigate(`/meet/${conversationId}?kind=${data.confirmed?.type ?? 'video'}&scheduled=1`)}
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-sm font-medium text-white hover:bg-emerald-700"
                >
                  {data.confirmed.type === 'audio' ? <Phone className="h-4 w-4" /> : <Video className="h-4 w-4" />} Join
                </button>
                <button
                  type="button"
                  onClick={downloadIcs}
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-emerald-300 bg-white px-3 text-sm font-medium text-emerald-700 hover:bg-emerald-100"
                >
                  <CalendarCheck className="h-4 w-4" /> Add to calendar
                </button>
              </div>
              <p className="text-[11px] text-emerald-600">A calendar invite was emailed to you both.</p>
            </div>
          )}
          {data.confirmed.startAt && confirmedOver && (
            <div className="mt-1 pl-6 space-y-1.5">
              <p className="text-xs text-gray-500">
                {(data.confirmed.type === 'audio' ? 'Audio call' : 'Video call')} · {localWhen(data.confirmed.startAt)}
              </p>
              {/* The scheduler is only shown while calls are still locked, so an
                  ended meeting here means they didn't both attend — pick again. */}
              <p className="text-xs text-gray-600">That meeting has passed — pick a new time below.</p>
            </div>
          )}
        </div>
      )}

      <div className="space-y-2">
        {/* The meeting's length is typed up front — any number of minutes. */}
        <div className="flex flex-wrap items-center gap-2" data-testid="meeting-length">
          <label htmlFor="meeting-minutes" className="text-xs font-medium text-gray-700">Meeting length</label>
          <input
            id="meeting-minutes"
            type="number"
            inputMode="numeric"
            min={MIN_DURATION}
            max={MAX_DURATION}
            step={5}
            value={durationText}
            onChange={e => setDurationText(e.target.value)}
            aria-invalid={!durationOk}
            className={`h-11 w-20 rounded-lg border bg-white px-2 text-sm text-gray-800 ${durationOk ? 'border-gray-200' : 'border-rsn-red'}`}
          />
          <span className="text-xs text-gray-600">min</span>
          <span className="text-[11px] text-gray-400">{durationOk ? 'Type any length — 10, 15, 45…' : `Between ${MIN_DURATION} and ${MAX_DURATION} minutes.`}</span>
        </div>
        <p className="text-[11px] text-gray-500">
          Tap the times you're free — <span className="font-medium text-gray-700">your local time</span>. Green = you both can.
        </p>

        {/* Day strip: the next 7 days; a dot shows where picks already are. */}
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Day">
          {slotsByDay.map(({ day, key, dayKey }) => {
            const onDay = (k: string) => dayOfKey(k) === dayKey;
            const both = [...mine].some(k => onDay(k) && theirSet.has(k));
            const iHave = [...mine].some(onDay);
            const theyHave = [...theirSet].some(onDay);
            const active = key === current.key;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={active}
                data-day={key}
                onClick={() => setSelectedDay(key)}
                className={`flex min-h-[44px] min-w-[64px] shrink-0 flex-col items-center justify-center rounded-lg border px-2 text-xs font-medium transition-colors ${
                  active ? 'border-[#1a1a2e] bg-[#1a1a2e] text-white' : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                }`}
              >
                <span>{day.toLocaleDateString([], { weekday: 'short' })}</span>
                <span className={`text-[11px] ${active ? 'text-gray-200' : 'text-gray-400'}`}>
                  {day.toLocaleDateString([], { day: 'numeric', month: 'short' })}
                </span>
                {(both || iHave || theyHave) && (
                  <span
                    aria-hidden
                    className={`mt-0.5 h-1.5 w-1.5 rounded-full ${both ? 'bg-emerald-400' : iHave ? 'bg-rsn-red' : 'bg-gray-400'}`}
                  />
                )}
              </button>
            );
          })}
        </div>

        {/* The selected day's whole timeline, 00:00–23:30, in one scrollable
            frame. A typed time is one of these chips, scrolled into view. */}
        <div
          ref={gridRef}
          className="relative max-h-[300px] overflow-y-auto overscroll-contain rounded-lg border border-gray-100 bg-white/60 p-1.5"
          data-testid="slot-grid"
          aria-label={`Times on ${localDay(current.day)} — scroll for earlier or later`}
        >
          <div className="grid grid-cols-3 gap-1.5 min-[420px]:grid-cols-4 md:grid-cols-6">
            {slots.map(key => {
              const past = isPastSlot(key);
              const iPicked = mine.has(key);
              const theyPicked = theirSet.has(key);
              const both = iPicked && theyPicked;
              const state = both ? 'Both can' : iPicked ? 'You' : theyPicked ? 'They can' : '';
              return (
                <button
                  key={key}
                  type="button"
                  data-slot={key}
                  disabled={past}
                  onClick={() => toggle(key)}
                  aria-pressed={iPicked}
                  aria-label={`${labelFor(key)}${both ? ' — you both can' : theyPicked ? ' — they can' : iPicked ? ' — you can' : ''}`}
                  className={`flex min-h-[44px] flex-col items-center justify-center rounded-lg border px-1 leading-tight transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    both
                      ? 'border-emerald-400 bg-emerald-100 text-emerald-700'
                      : iPicked
                        ? 'border-rsn-red bg-rsn-red-light text-rsn-red'
                        : theyPicked
                          ? 'border-gray-300 bg-white text-gray-600'
                          : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'
                  } ${flashKey === key ? 'ring-2 ring-rsn-red ring-offset-1' : ''}`}
                >
                  <span className="text-xs font-semibold">{localTime(key)}</span>
                  {state && <span className="text-[10px]">{state}</span>}
                </button>
              );
            })}
          </div>
        </div>
        <p className="text-[11px] text-gray-400">Scroll the times for earlier or later in the day.</p>

        {/* Any other time of day — early, late, whatever suits you (Ali, 9 Sep). */}
        <div className="flex flex-wrap items-center gap-2" data-testid="custom-time">
          <label htmlFor="custom-time" className="text-[11px] font-medium text-gray-600">Another time on {localDay(current.day)}</label>
          <input
            id="custom-time"
            type="time"
            step={SLOT_MINUTES * 60}
            value={customTime}
            onChange={e => setCustomTime(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCustomTime(); } }}
            aria-label="Another time, 24-hour"
            className="h-11 rounded-lg border border-gray-200 bg-white px-2 text-sm text-gray-800"
          />
          <button
            type="button"
            onClick={addCustomTime}
            disabled={!customTime}
            className="min-h-[44px] rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            Add time
          </button>
          <span className="text-[11px] text-gray-400">Type any time — it's selected and shown in the timeline above.</span>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-[11px] text-gray-400">
          Save, then confirm a green time.
        </p>
        {dirty && (
          <Button size="sm" onClick={save} disabled={saving} className="min-h-[44px]">
            {saving ? 'Saving…' : 'Save availability'}
          </Button>
        )}
      </div>

      {savedOverlap.length > 0 && !data.confirmed && (
        <div className="space-y-1.5" data-testid="overlap-list">
          <p className="text-[11px] font-medium text-emerald-700">You both can — pick one to confirm:</p>
          {finalizing && (
            <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 space-y-2" data-testid="confirm-card">
              <p className="text-sm font-semibold text-emerald-800">{localWhen(finalizing)}</p>
              <p className="text-[11px] text-emerald-600">Your local time. They'll see it in theirs. Length is the number above.</p>
              <div className="flex items-center gap-2 flex-wrap">
                <div className="inline-flex overflow-hidden rounded-lg border border-emerald-300">
                  {(['video', 'audio'] as const).map(k => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setMeetingKind(k)}
                      aria-pressed={meetingKind === k}
                      className={`inline-flex min-h-[44px] items-center gap-1 px-3 text-xs font-medium ${meetingKind === k ? 'bg-emerald-600 text-white' : 'bg-white text-emerald-700'}`}
                    >
                      {k === 'video' ? <Video className="h-3.5 w-3.5" /> : <Phone className="h-3.5 w-3.5" />}
                      {k === 'video' ? 'Video' : 'Audio'}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-xs text-emerald-800" data-testid="confirm-summary">
                {durationOk
                  ? `${labelFor(finalizing)} · ${durationMin} min · ${meetingKind === 'audio' ? 'Audio' : 'Video'} call`
                  : `Length must be ${MIN_DURATION}–${MAX_DURATION} minutes.`}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => confirm(finalizing)}
                  disabled={confirming !== null || !durationOk}
                  className="flex-1 min-h-[44px] flex items-center justify-center gap-2 rounded-lg bg-emerald-600 text-sm font-medium text-white hover:bg-emerald-700 transition-colors disabled:opacity-50"
                >
                  <Check className="h-4 w-4" />
                  {confirming === finalizing ? 'Confirming…' : 'Confirm meeting'}
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
          )}
          <div className="flex flex-wrap gap-1.5">
            {overlapShown.filter(w => w !== finalizing).map(w => (
              <button
                key={w}
                type="button"
                onClick={() => openFinalize(w)}
                disabled={confirming !== null}
                aria-label={`Confirm ${labelFor(w)}`}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-3 text-sm font-medium text-emerald-700 hover:bg-emerald-100 transition-colors"
              >
                <Check className="h-4 w-4" />
                {labelFor(w)}
              </button>
            ))}
            {!showAllOverlap && savedOverlap.length > OVERLAP_PREVIEW && (
              <button
                type="button"
                onClick={() => setShowAllOverlap(true)}
                className="inline-flex min-h-[44px] items-center rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-600 hover:bg-gray-50"
              >
                +{savedOverlap.length - OVERLAP_PREVIEW} more
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
