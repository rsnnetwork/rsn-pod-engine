// ─── Meeting Scheduler ───────────────────────────────────────────────────────
//
// REASON v1 Phase 2 (19 Jul 2026) — "setup availability to be introduced".
// Lives inside a 1:1 conversation. Each side taps the concrete 30-minute times
// that suit them (the next 7 days, on their own clock); a slot is stored as a
// UTC instant, so two people in different time zones overlap on the same
// moment. Times you have BOTH saved light up green, and either side confirms
// one — that pins the meeting (exact time + custom length + audio/video),
// drops a message in the thread, and notifies the partner. No calendars, no
// OAuth. 9 Sep 2026 (Stefan): replaced the vague morning/afternoon/evening grid.
//
// 26 Oct 2026, after the 25 Oct walkthrough on production: both people picked
// 13:00, the second Save closed the panel, "the green" did nothing they could
// see, and no meeting existed. Now the same time saved by both is booked by the
// save itself (server), and this panel says what each Save did; the green cell
// and the thread card's time open the confirm card for that very time; nothing
// typed or picked is dropped without a word; started times are hidden, not
// greyed out; the time zone is named; and every day is built from instants, so
// the nights the clocks change have each time once (scheduler-flow.ts).

import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CalendarCheck, ChevronRight, Video, Phone } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { E } from '@/realtime/entities';
import { Spinner } from '@/components/ui/Spinner';
import api from '@/lib/api';
import { useToastStore } from '@/stores/toastStore';
import { useAuthStore } from '@/stores/authStore';
import {
  ASK_SEND, NOT_SHARED, SLOT_MINUTES,
  cellAriaLabel, cellLabels, cellState, cellText, confirmable, confirmedMessage, dayKeyOf, dayLabel, dayParts,
  daySlots, hasStarted, isMeetingOver, isSlotKey, isTimeNotShared, knownZone, meetingStands, saveMessage, saveOutcome,
  schedulerError, slotLabel, slotTime, typedSlot, upcomingDays, viewerZone, whenWithZone, zoneLine, zoneName,
  type CellState,
} from './scheduler-flow';

interface Scheduling {
  conversationId: string;
  partnerId: string;
  mine: string[];
  theirs: string[];
  overlap: string[];
  confirmed: {
    window: string; byUserId: string; at: string; startAt: string | null; durationMin: number | null;
    type: 'audio' | 'video' | null;
    /** The meeting's own record (26 Oct 2026), for a link to its page. Null for a legacy day part. */
    meetingId?: string | null;
  } | null;
  /** The partner changed availability since I last opened the scheduler. */
  schedulingUpdated?: boolean;
  /** Calls unlock once this pair's first scheduled meeting has happened. */
  callsUnlocked?: boolean;
}

const WORK_START_HOUR = 8; // where the day's timeline opens by default (local)
const DAYS_AHEAD = 7;
const MIN_DURATION = 5;
const MAX_DURATION = 240;
const OVERLAP_PREVIEW = 8;
// A slot as the server writes it, with or without milliseconds.
const ISO_INSTANT_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/g;

/**
 * A thread line like "📅 Meeting confirmed: 2026-09-10T13:30:00Z · 20 min video
 * call" is one shared text for both people; render the instant in THIS
 * reader's own time, with the zone. Used by the thread bubble and the inbox preview.
 */
export function localizeMeetingText(text: string): string {
  const zone = viewerZone();
  return text.replace(ISO_INSTANT_RE, (iso) => whenWithZone(iso, zone));
}

/** Any key in words: a slot on the reader's clock, or a legacy day part ("Wed 22 Jul, evening"). */
function labelFor(windowKey: string, zone: string): string {
  if (isSlotKey(windowKey)) return slotLabel(windowKey, zone);
  const [date, part] = windowKey.split(':');
  return `${dayLabel(date)}, ${part}`;
}

/**
 * A pinned banner at the top of the thread showing the confirmed meeting to
 * BOTH people — real local time, duration, audio/video, and a Join button —
 * so the meeting is visible in the chat, not buried in the scheduler (Ali,
 * 8 Sep 2026). Shares the scheduling query cache with the scheduler panel.
 * Since 26 Oct 2026 a meeting has its own page, and the banner opens it.
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
  const zone = viewerZone();
  const kind = c.type ?? 'video';
  const callWord = kind === 'audio' ? 'Audio call' : 'Video call';
  const over = isMeetingOver(c.startAt, c.durationMin);
  // "Call now" after an ended meeting only makes sense once calls are unlocked
  // (both attended). If it ended without that, they pick a new time instead.
  const unlocked = !!data?.callsUnlocked;
  const summary = (
    <>
      <CalendarCheck className={`h-4 w-4 shrink-0 ${over ? 'text-gray-400' : 'text-emerald-600'}`} />
      <span className="min-w-0">
        <span className={`block truncate text-sm font-semibold ${over ? 'text-gray-600' : 'text-emerald-800'}`}>
          {over ? 'Meeting ended' : whenWithZone(c.startAt, zone)}
        </span>
        <span className={`block truncate text-[11px] ${over ? 'text-gray-500' : 'text-emerald-700'}`}>
          {over ? `${callWord} · ${whenWithZone(c.startAt, zone)}` : `${callWord} · ${c.durationMin} min`}
        </span>
      </span>
    </>
  );
  // One row at every width: the words give way (truncate), never Join. On a
  // short phone a second row would take the thread's last lines with it.
  return (
    <div
      className={`border-b px-4 py-2.5 ${over ? 'border-gray-200 bg-gray-50' : 'border-emerald-200 bg-emerald-50'}`}
      data-testid="thread-meeting-banner"
    >
      <div className="flex items-center justify-between gap-3">
        {c.meetingId ? (
          <Link
            to={`/meetings/${c.meetingId}`}
            className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 rounded-lg hover:opacity-80"
            title="See the meeting's details"
          >
            {summary}
            <ChevronRight className={`h-4 w-4 shrink-0 ${over ? 'text-gray-400' : 'text-emerald-700'}`} aria-hidden="true" />
            <span className="sr-only">See the meeting's details</span>
          </Link>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2">{summary}</div>
        )}
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

const CELL_CLASS: Record<CellState, string> = {
  agreed: 'border-emerald-400 bg-emerald-100 text-emerald-800 hover:bg-emerald-200',
  booked: 'border-emerald-600 bg-emerald-600 text-white',
  'unsent-both': 'border-rsn-red bg-rsn-red-light text-rsn-red',
  mine: 'border-rsn-red bg-rsn-red-light text-rsn-red',
  theirs: 'border-gray-300 bg-white text-gray-700 hover:border-gray-400',
  free: 'border-gray-200 bg-white text-gray-600 hover:border-gray-300',
};

/** What the page can ask of the panel. */
export interface SchedulerHandle {
  /** A tap outside the panel, Escape or the header button: with unsaved times the panel asks first. */
  requestClose: () => void;
}

interface SchedulerProps {
  conversationId: string;
  onClose?: () => void;
  /** Open the confirm card on this time (the thread card's time). `at` lets the same time be asked for twice. */
  confirmRequest?: { slot: string; at: number } | null;
  /** Opened by Reschedule: bring the times into view and put the focus on the one it opens on, for the first pick. */
  focusFirstPick?: boolean;
}

// Unsaved picks, the typed length and the kind survive the panel unmounting
// (another conversation, another page) — kept per conversation until they are
// sent, discarded or the page goes.
const drafts = new Map<string, { staged: Set<string> | null; duration: string; kind: 'audio' | 'video' }>();

const MeetingScheduler = forwardRef<SchedulerHandle, SchedulerProps>(function MeetingScheduler(
  { conversationId, onClose, confirmRequest, focusFirstPick },
  ref,
) {
  const { addToast } = useToastStore();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const zone = useMemo(viewerZone, []);
  const profileZone: unknown = useAuthStore(s => s.user?.timezone);
  const [staged, setStaged] = useState<Set<string> | null>(() => drafts.get(conversationId)?.staged ?? null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  // The shared time being confirmed. Its length and kind are chosen on the card.
  const [finalizing, setFinalizing] = useState<string | null>(null);
  const [durationText, setDurationText] = useState(() => drafts.get(conversationId)?.duration ?? '30');
  const [meetingKind, setMeetingKind] = useState<'audio' | 'video'>(() => drafts.get(conversationId)?.kind ?? 'video');
  // "Send your times?" is showing: someone tried to close the panel with times not sent.
  const [asking, setAsking] = useState(false);
  const draftRef = useRef({ staged, duration: durationText, kind: meetingKind });
  draftRef.current = { staged, duration: durationText, kind: meetingKind };
  useEffect(() => () => { drafts.set(conversationId, draftRef.current); }, [conversationId]);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [showAllOverlap, setShowAllOverlap] = useState(false);
  const [customTime, setCustomTime] = useState('');
  // The day's timeline scrolls inside one frame; these bring a slot into view.
  // `panel`: bring it into the panel's frame too, clear of the Save bar (a
  // typed time); not for a confirm card, which keeps the top of the panel.
  const gridRef = useRef<HTMLDivElement>(null);
  const [scrollTo, setScrollTo] = useState<{ key: string; panel: boolean } | null>(null);
  const [flashKey, setFlashKey] = useState<string | null>(null);
  // The panel scrolls inside the thread column (it cannot grow past it). The
  // two things that finish the job must never sit out of sight: the confirm
  // step and, while there are unsaved picks, Save.
  const panelRef = useRef<HTMLDivElement>(null);
  const confirmCardRef = useRef<HTMLDivElement>(null);
  const saveBarRef = useRef<HTMLDivElement>(null);
  // The clock the panel reads (which times have started). It moves on each
  // minute, so a time that starts while the panel is open drops out.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const { data, isLoading, isError, refetch } = useQuery<Scheduling>({
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new answer from the server re-stages; staged is what this sets
  }, [data]);

  // The days on offer, each with every half hour it has in this zone. Built
  // again every half hour, so late at night today gives way to tomorrow.
  const halfHour = Math.floor(now / (SLOT_MINUTES * 60_000));
  const days = useMemo(
    () => upcomingDays(Date.now(), zone, DAYS_AHEAD).map(dayKey => ({ dayKey, slots: daySlots(dayKey, zone) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- halfHour is the clock this list follows
    [zone, halfHour],
  );

  const savedMine = useMemo(() => new Set((data?.mine ?? []).filter(isSlotKey)), [data]);
  const theirSet = useMemo(() => new Set((data?.theirs ?? []).filter(isSlotKey)), [data]);
  const mine = staged ?? savedMine;
  const standing = meetingStands(data?.confirmed, now);
  const bookedKey = standing && data?.confirmed && isSlotKey(data.confirmed.window) ? data.confirmed.window : null;
  // What can still be confirmed: times BOTH have saved, still ahead. With a
  // meeting standing, the others are where it can be moved to.
  const confirmables = confirmable(data?.overlap ?? [], now).filter(k => k !== bookedKey);

  // Until the member picks a day, open on the first day where you both can,
  // else where they can, else the first day on offer — so what matters is
  // visible at once. Derived (not an effect) so the strip never paints today
  // first and then jumps.
  const autoDay = useMemo(() => {
    const ahead = (k: string) => !hasStarted(k, now);
    const bothDays = new Set([...savedMine].filter(k => theirSet.has(k) && ahead(k)).map(k => dayKeyOf(k, zone)));
    const theirDays = new Set([...theirSet].filter(ahead).map(k => dayKeyOf(k, zone)));
    return (days.find(d => bothDays.has(d.dayKey)) ?? days.find(d => theirDays.has(d.dayKey)) ?? days[0]).dayKey;
  }, [days, savedMine, theirSet, zone, now]);
  const current = days.find(d => d.dayKey === (selectedDay ?? autoDay)) ?? days[0];
  // Times that have started are not offered: nobody can meet in the past.
  const visible = current.slots.filter(k => !hasStarted(k, now));

  // A time typed into "Another time" counts as picked as soon as it is a time:
  // it is added on blur and on Enter, and Save carries it if neither came.
  const typedKey = customTime ? typedSlot(current.dayKey, customTime, zone) : null;
  const typed = typedKey && !hasStarted(typedKey, now) && !mine.has(typedKey) ? typedKey : null;
  const stagedChanged = staged !== null &&
    (staged.size !== savedMine.size || [...savedMine].some(w => !staged.has(w)));
  const unsaved = stagedChanged || typed !== null;

  // Opening a day: scroll its timeline to what matters — a time you both
  // can, else yours, else theirs, else the first time from the working day on.
  // Runs per day, not per tap, so toggling never jumps.
  const pickFocused = useRef(false);
  useEffect(() => {
    const box = gridRef.current;
    if (!box || !data) return;
    const shown = current.slots.filter(k => !hasStarted(k, Date.now()));
    const target =
      shown.find(k => savedMine.has(k) && theirSet.has(k)) ??
      shown.find(k => savedMine.has(k)) ??
      shown.find(k => theirSet.has(k)) ??
      shown.find(k => Number(slotTime(k, zone).slice(0, 2)) >= WORK_START_HOUR) ??
      shown[0];
    const el = target ? box.querySelector<HTMLElement>(`[data-slot="${target}"]`) : null;
    if (el) box.scrollTop = Math.max(0, el.offsetTop - 4);
    // Reschedule opened the panel for a new pick: a time that can be picked
    // (not the booked one it opened on, the time just after it) comes into the
    // panel's frame (the panel scrolls, never an ancestor) and takes the focus.
    const pick = target === bookedKey ? shown[shown.indexOf(target) + 1] ?? shown.find(k => k !== bookedKey) : target;
    const pickEl = pick ? box.querySelector<HTMLElement>(`[data-slot="${pick}"]`) : null;
    if (focusFirstPick && !pickFocused.current && pickEl && pick) {
      pickFocused.current = true;
      setScrollTo({ key: pick, panel: true });
      pickEl.focus({ preventScroll: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per day opened (and once the times load), not per tap
  }, [current.dayKey, !!data]);

  // A typed or pointed-at time: bring it into view and flash it so the eye lands on it.
  useEffect(() => {
    if (!scrollTo) return;
    const box = gridRef.current;
    const el = box?.querySelector<HTMLElement>(`[data-slot="${scrollTo.key}"]`);
    if (box && el) {
      const top = el.offsetTop - 4;
      const bottom = el.offsetTop + el.offsetHeight + 4;
      if (top < box.scrollTop || bottom > box.scrollTop + box.clientHeight) {
        box.scrollTop = Math.max(0, top - Math.round((box.clientHeight - el.offsetHeight) / 2));
      }
      // On a small phone the timeline is taller than the panel's frame: scroll
      // the panel (never an ancestor) so the time is above the pinned Save bar.
      const panel = panelRef.current;
      if (scrollTo.panel && panel) {
        const frame = panel.getBoundingClientRect();
        const bar = saveBarRef.current;
        const floor = bar && bar.dataset.pinned === 'true' ? bar.getBoundingClientRect().top : frame.bottom;
        const cell = el.getBoundingClientRect();
        if (cell.bottom > floor) panel.scrollTop += cell.bottom - floor + 8;
        else if (cell.top < frame.top) panel.scrollTop -= frame.top - cell.top + 8;
      }
    }
    setFlashKey(scrollTo.key);
    setScrollTo(null);
    const t = setTimeout(() => setFlashKey(null), 1600);
    return () => clearTimeout(t);
  }, [scrollTo]);

  // The confirm card opens at the top of the panel. Bring the whole card —
  // "Confirm meeting" above all — inside the panel's own frame, clear of the
  // pinned Save bar. Scrolls the panel only, never an ancestor.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const card = confirmCardRef.current;
    if (!finalizing || !panel || !card) return;
    const frame = panel.getBoundingClientRect();
    const bar = saveBarRef.current;
    const floor = bar && bar.dataset.pinned === 'true' ? bar.getBoundingClientRect().top : frame.bottom;
    const box = card.getBoundingClientRect();
    const room = floor - frame.top;
    // A card taller than the frame is aligned to its BOTTOM: "Confirm meeting"
    // and "Remove this time" are its last rows, and they have to be in reach.
    if (box.bottom > floor || box.height + 16 > room) panel.scrollTop += box.bottom - floor + 8;
    else if (box.top < frame.top) panel.scrollTop -= frame.top - box.top + 8;
  }, [finalizing]);

  // The step that finishes the job mounts at the TOP of the panel: the shared
  // times when they appear, then the confirmed meeting. For the second person
  // to save, their own Save can be what creates it — and they are usually
  // scrolled down in the timeline at that moment. Bring the panel back to it.
  const headline = !data ? 'none' : data.confirmed ? 'confirmed' : confirmables.length > 0 ? 'overlap' : 'none';
  useLayoutEffect(() => {
    if (headline !== 'none' && panelRef.current) panelRef.current.scrollTop = 0;
  }, [headline]);

  // The confirm card for a time both have saved: from a green cell, a chip, or
  // the thread card's time. A time that is no longer shared is said so, not opened.
  const openConfirm = (slot: string) => {
    if (!confirmable(data?.overlap ?? [], Date.now()).includes(slot) || slot === bookedKey) {
      addToast(NOT_SHARED, 'info');
      return;
    }
    setAsking(false);
    setFinalizing(slot);
    setSelectedDay(dayKeyOf(slot, zone));
    setScrollTo({ key: slot, panel: false });
  };

  // The thread card's time asks for its own confirm card, once per press.
  const handledRequest = useRef<number | null>(null);
  useEffect(() => {
    if (!confirmRequest || !data || handledRequest.current === confirmRequest.at) return;
    handledRequest.current = confirmRequest.at;
    openConfirm(confirmRequest.slot);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new press, or the times arriving for one already made
  }, [confirmRequest, data]);

  const requestClose = () => {
    if (saving) return;
    if (unsaved) { setAsking(true); return; }
    onClose?.();
  };
  useImperativeHandle(ref, () => ({ requestClose }));

  if (isError && !data) {
    return (
      <div className="flex flex-wrap items-center gap-2 px-3 py-3 text-sm text-gray-600" data-testid="meeting-scheduler">
        <span>We could not load the times.</span>
        <button
          type="button"
          onClick={() => void refetch()}
          className="min-h-[44px] rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Try again
        </button>
      </div>
    );
  }
  if (isLoading || !data) {
    return <div className="p-4 flex justify-center"><Spinner /></div>;
  }

  const toggle = (key: string) => {
    const next = new Set(mine);
    if (next.has(key)) next.delete(key); else next.add(key);
    setStaged(next);
    setAsking(false);
  };

  // The booked time itself: show the meeting at the top of the panel, with Join.
  const pressCell = (state: CellState, key: string) => {
    if (state === 'booked') {
      if (panelRef.current) panelRef.current.scrollTop = 0;
      return;
    }
    return state === 'agreed' ? openConfirm(key) : toggle(key);
  };

  const removeTime = (key: string) => {
    const next = new Set(mine);
    next.delete(key);
    setStaged(next);
    setFinalizing(null);
  };

  // Any time of day (Ali, 9 Sep): type it and it becomes a pick in its place
  // on the timeline, scrolled into view.
  const addTypedTime = () => {
    if (!customTime) return;
    const key = typedSlot(current.dayKey, customTime, zone);
    if (!key) { addToast('Enter a time like 21:30.', 'error'); return; }
    if (hasStarted(key, Date.now())) { addToast('That time has already passed.', 'error'); return; }
    if (!mine.has(key)) setStaged(new Set([...mine, key]));
    setCustomTime('');
    setAsking(false);
    setScrollTo({ key, panel: true });
  };

  const durationMin = Number(durationText);
  const durationOk = Number.isInteger(durationMin) && durationMin >= MIN_DURATION && durationMin <= MAX_DURATION;

  const refreshThread = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['meetingScheduling', conversationId] }),
    // The card the server wrote lands in the thread: the REAL thread key.
    queryClient.invalidateQueries({ queryKey: ['dm-messages', conversationId] }),
    queryClient.invalidateQueries({ queryKey: ['dm-conversations'] }),
  ]);

  // Forget what was not sent: this panel's state and the draft kept for it.
  const forgetDraft = () => {
    setStaged(null);
    setCustomTime('');
    setAsking(false);
    drafts.delete(conversationId);
    draftRef.current = { staged: null, duration: durationText, kind: meetingKind };
  };

  // Both picked one new time while a meeting stood (Reschedule): move it there,
  // keeping its length and kind. Their times are already sent either way.
  const moveAfterSave = async (key: string, meeting: Scheduling['confirmed']) => {
    try {
      await api.post(`/dm/conversations/${conversationId}/scheduling/confirm`, {
        window: key, durationMin: meeting?.durationMin ?? 30, type: meeting?.type ?? 'video',
      });
      await refreshThread();
      addToast(saveMessage({ kind: 'move', to: key }, zone), 'success');
      onClose?.();
    } catch (err) {
      // Stay open: the new time is shared, so the move step is right here to try again.
      await queryClient.invalidateQueries({ queryKey: ['meetingScheduling', conversationId] });
      addToast(schedulerError(err, 'Your times are sent, but the meeting did not move. Pick the new time above to move it.'), 'error');
    }
  };

  // Saving SENDS: the thread gets a line either way (19 Sep: "we both have
  // saved our availability?" / "I have no clue!!!"), and since 25 Oct the save
  // that leaves one shared time books it. The answer says which happened.
  const save = async () => {
    if (saving) return;
    setSaving(true);
    const before = data;
    const windows = typed && !mine.has(typed) ? [...mine, typed] : [...mine];
    try {
      const res = await api.put(`/dm/conversations/${conversationId}/scheduling/availability`, {
        windows,
        ...(durationOk ? { durationMin } : {}),
        type: meetingKind,
      });
      const after = res.data.data as Scheduling;
      const outcome = saveOutcome(before, after, Date.now());
      await refreshThread();
      forgetDraft();
      if (outcome.kind === 'move') {
        await moveAfterSave(outcome.to, after.confirmed);
        return;
      }
      addToast(saveMessage(outcome, zone), 'success');
      if (outcome.kind === 'overlap') {
        // Two or more times you both can, and nothing booked: picking one is
        // the next step, so it stays in front of you (the top of the panel).
        if (panelRef.current) panelRef.current.scrollTop = 0;
        return;
      }
      // Booked, or only sent: the job is done, hand the thread back (Shradha's
      // deck: a terminal action, "right now it traps you").
      onClose?.();
    } catch (err) {
      addToast(schedulerError(err, 'Could not save your times. Try again.'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    forgetDraft();
    setFinalizing(null);
    onClose?.();
  };

  const confirm = async (key: string) => {
    if (confirming || !durationOk) return;
    setConfirming(key);
    const moving = standing;
    try {
      // The slot IS the instant — the server stores it and every client
      // renders it in its own timezone.
      await api.post(`/dm/conversations/${conversationId}/scheduling/confirm`, { window: key, durationMin, type: meetingKind });
      setFinalizing(null);
      await refreshThread();
      addToast(confirmedMessage(key, zone, moving), 'success');
    } catch (err) {
      // The time stopped being free for both while the card was open: redraw
      // from the server instead of leaving a card that cannot work.
      if (isTimeNotShared(err)) {
        setFinalizing(null);
        await queryClient.invalidateQueries({ queryKey: ['meetingScheduling', conversationId] });
      }
      addToast(schedulerError(err, 'Could not confirm that time.'), 'error');
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
      a.download = 'reason-meeting.ics';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      addToast('Could not build the calendar file. Try again.', 'error');
    }
  };

  const confirmedOver = isMeetingOver(data.confirmed?.startAt, data.confirmed?.durationMin, now);
  const overlapShown = showAllOverlap ? confirmables : confirmables.slice(0, OVERLAP_PREVIEW);
  const labels = cellLabels(visible, zone);
  const dayOf = new Map([...mine, ...theirSet].map(k => [k, dayKeyOf(k, zone)] as const));
  // Emails and bells show times in the zone saved on the profile: say so when it is not this one.
  const ownZone = zoneName(zone, now);
  const savedZone = typeof profileZone === 'string' && knownZone(profileZone) ? zoneName(profileZone, now) : null;

  return (
    <div
      ref={panelRef}
      className={`min-h-0 overflow-y-auto overscroll-contain border-b border-gray-200 bg-gray-50/60 px-3 py-3 space-y-3 ${
        unsaved ? 'scroll-pb-24' : ''
      }`}
      data-testid="meeting-scheduler"
    >
      {data.confirmed && (
        <div className={`rounded-lg border px-3 py-2.5 ${confirmedOver ? 'bg-gray-50 border-gray-200' : 'bg-emerald-50 border-emerald-200'}`}>
          <div className="flex items-center gap-2">
            <CalendarCheck className={`h-4 w-4 shrink-0 ${confirmedOver ? 'text-gray-400' : 'text-emerald-600'}`} />
            <p className={`text-sm font-semibold ${confirmedOver ? 'text-gray-600' : 'text-emerald-800'}`}>
              {confirmedOver
                ? 'Meeting ended'
                : data.confirmed.startAt
                  ? `Meeting confirmed — ${whenWithZone(data.confirmed.startAt, zone)}`
                  : `Meeting confirmed: ${labelFor(data.confirmed.window, zone)}`}
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
              <p className="text-[11px] text-emerald-700">A calendar invite was emailed to you both.</p>
            </div>
          )}
          {data.confirmed.startAt && confirmedOver && (
            <div className="mt-1 pl-6 space-y-1.5">
              <p className="text-xs text-gray-500">
                {(data.confirmed.type === 'audio' ? 'Audio call' : 'Video call')} · {whenWithZone(data.confirmed.startAt, zone)}
              </p>
              {/* The scheduler is only shown while calls are still locked, so an
                  ended meeting here means they didn't both attend — pick again. */}
              <p className="text-xs text-gray-600">That meeting has passed. Pick a new time below.</p>
            </div>
          )}
        </div>
      )}

      {/* The confirm step sits here at the top of the panel, where a
          laptop-height window always shows it: the times you have BOTH saved,
          and the card for the one you picked. */}
      {(confirmables.length > 0 || finalizing) && (
        <div className="space-y-1.5" data-testid="overlap-list">
          <p className="text-[11px] font-medium text-emerald-700">
            {standing ? 'Move it to another time you both can:' : 'You both can — pick one to confirm:'}
          </p>
          {finalizing && (
            <div ref={confirmCardRef} className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 space-y-2.5" data-testid="confirm-card">
              <div>
                <p className="text-sm font-semibold text-emerald-900">{slotLabel(finalizing, zone)}</p>
                <p className="text-[11px] text-emerald-800">{ownZone}. They see it in their own time.</p>
              </div>
              {/* Length and kind live here, the one place they are used (since
                  26 Oct; a bare number box at the top of the panel read as
                  "choose the hour" on 25 Oct). */}
              <div className="flex flex-wrap items-center gap-2" data-testid="meeting-length">
                <label htmlFor="meeting-minutes" className="text-xs font-medium text-emerald-900">Length</label>
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
                  aria-describedby="confirm-summary"
                  className={`h-11 w-20 rounded-lg border bg-white px-2 text-sm text-gray-800 ${durationOk ? 'border-emerald-300' : 'border-rsn-red'}`}
                />
                <span className="text-xs text-emerald-900">min</span>
                <div className="inline-flex overflow-hidden rounded-lg border border-emerald-300" role="group" aria-label="Kind of call">
                  {(['video', 'audio'] as const).map(k => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setMeetingKind(k)}
                      aria-pressed={meetingKind === k}
                      className={`inline-flex min-h-[44px] items-center gap-1 px-3 text-xs font-medium ${meetingKind === k ? 'bg-emerald-600 text-white' : 'bg-white text-emerald-800'}`}
                    >
                      {k === 'video' ? <Video className="h-3.5 w-3.5" /> : <Phone className="h-3.5 w-3.5" />}
                      {k === 'video' ? 'Video' : 'Audio'}
                    </button>
                  ))}
                </div>
              </div>
              <p id="confirm-summary" className="text-xs text-emerald-900" data-testid="confirm-summary">
                {durationOk
                  ? `${slotLabel(finalizing, zone)} · ${durationMin} min · ${meetingKind === 'audio' ? 'Audio' : 'Video'} call`
                  : `Length must be ${MIN_DURATION}–${MAX_DURATION} minutes.`}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => confirm(finalizing)}
                  disabled={confirming !== null || !durationOk}
                  className="flex-1 min-h-[44px] flex items-center justify-center gap-2 rounded-lg bg-emerald-600 text-sm font-medium text-white hover:bg-emerald-700 transition-colors disabled:opacity-50"
                >
                  <Check className="h-4 w-4" />
                  {confirming === finalizing
                    ? (standing ? 'Moving…' : 'Confirming…')
                    : (standing ? 'Move meeting' : 'Confirm meeting')}
                </button>
                <button
                  onClick={() => setFinalizing(null)}
                  disabled={confirming !== null}
                  className="min-h-[44px] rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
              {savedMine.has(finalizing) && (
                <button
                  type="button"
                  onClick={() => removeTime(finalizing)}
                  disabled={confirming !== null}
                  className="min-h-[44px] text-sm font-medium text-emerald-900 underline underline-offset-2 hover:text-emerald-700"
                >
                  Remove this time
                </button>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            {overlapShown.filter(w => w !== finalizing).map(w => (
              <button
                key={w}
                type="button"
                onClick={() => openConfirm(w)}
                disabled={confirming !== null}
                aria-label={`Confirm ${slotLabel(w, zone)}`}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-3 text-sm font-medium text-emerald-800 hover:bg-emerald-100 transition-colors"
              >
                <Check className="h-4 w-4" />
                {slotLabel(w, zone)}
              </button>
            ))}
            {!showAllOverlap && confirmables.length > OVERLAP_PREVIEW && (
              <button
                type="button"
                onClick={() => setShowAllOverlap(true)}
                className="inline-flex min-h-[44px] items-center rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-700 hover:bg-gray-50"
              >
                +{confirmables.length - OVERLAP_PREVIEW} more
              </button>
            )}
          </div>
        </div>
      )}

      <div className="space-y-2">
        <p className="text-[11px] text-gray-600">Tap the times you are free. Green means you both can.</p>
        <p className="text-[11px] font-medium text-gray-700" data-testid="scheduler-zone">{zoneLine(zone, now)}</p>
        {savedZone && savedZone !== ownZone && (
          <p className="text-[11px] text-gray-600">Emails show times in {savedZone}, the time zone in your profile.</p>
        )}

        {/* Day strip: the next 7 days; a dot shows where picks already are. */}
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Day">
          {days.map(({ dayKey }) => {
            const onDay = (k: string) => dayOf.get(k) === dayKey;
            const both = [...mine].some(k => onDay(k) && theirSet.has(k));
            const iHave = [...mine].some(onDay);
            const theyHave = [...theirSet].some(onDay);
            const active = dayKey === current.dayKey;
            const { weekday, date } = dayParts(dayKey);
            return (
              <button
                key={dayKey}
                type="button"
                role="tab"
                aria-selected={active}
                data-day={dayKey}
                onClick={() => setSelectedDay(dayKey)}
                className={`flex min-h-[44px] min-w-[64px] shrink-0 flex-col items-center justify-center rounded-lg border px-2 text-xs font-medium transition-colors ${
                  active ? 'border-[#1a1a2e] bg-[#1a1a2e] text-white' : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                }`}
              >
                <span>{weekday}</span>
                <span className={`text-[11px] ${active ? 'text-gray-200' : 'text-gray-500'}`}>{date}</span>
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

        {/* The selected day's times still ahead, in one scrollable frame. A
            typed time is one of these cells, scrolled into view.
            No overscroll-contain here: on a small phone this timeline is
            taller than the whole panel frame, so a lock would mean a drag that
            starts on it never carries on into the panel, stranding the person
            away from the confirm step. The panel's own lock still keeps the
            gesture off the page behind it. */}
        <div
          ref={gridRef}
          className="relative max-h-[300px] overflow-y-auto rounded-lg border border-gray-100 bg-white/60 p-1.5"
          data-testid="slot-grid"
          aria-label={`Times on ${dayLabel(current.dayKey)}, scroll for earlier or later`}
        >
          {visible.length === 0 ? (
            <p className="px-2 py-3 text-sm text-gray-600">No times are left on this day. Pick another day.</p>
          ) : (
            <div className="grid grid-cols-3 gap-1.5 min-[420px]:grid-cols-4 md:grid-cols-6">
              {visible.map((key, i) => {
                const state = cellState({ key, mine, saved: savedMine, theirs: theirSet, booked: bookedKey });
                const text = cellText(state);
                return (
                  <button
                    key={key}
                    type="button"
                    data-slot={key}
                    onClick={() => pressCell(state, key)}
                    aria-pressed={state === 'agreed' || state === 'booked' ? undefined : mine.has(key)}
                    aria-label={cellAriaLabel(state, labels[i])}
                    className={`flex min-h-[44px] flex-col items-center justify-center rounded-lg border px-1 leading-tight transition-colors ${
                      CELL_CLASS[state]
                    } ${flashKey === key ? 'ring-2 ring-rsn-red ring-offset-1' : ''}`}
                  >
                    <span className="text-xs font-semibold">{labels[i]}</span>
                    {text && <span className="text-[10px]">{text}</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <p className="text-[11px] text-gray-500">Scroll the times for earlier or later in the day.</p>

        {/* Any other time of day — early, late, whatever suits you (Ali, 9 Sep).
            Kept on blur and on Enter: a time typed and left used to vanish. */}
        <div className="flex flex-wrap items-center gap-2" data-testid="custom-time">
          <label htmlFor="custom-time" className="text-[11px] font-medium text-gray-700">Another time on {dayLabel(current.dayKey)}</label>
          <input
            id="custom-time"
            type="time"
            step={SLOT_MINUTES * 60}
            value={customTime}
            onChange={e => setCustomTime(e.target.value)}
            onBlur={addTypedTime}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTypedTime(); } }}
            aria-label="Another time, 24-hour"
            className="h-11 rounded-lg border border-gray-200 bg-white px-2 text-sm text-gray-800"
          />
          <button
            type="button"
            // Keep the focus in the box: this press adds the time. Letting the box
            // blur first added it there and left the press an empty box to complain about.
            onMouseDown={e => e.preventDefault()}
            onClick={() => (customTime ? addTypedTime() : addToast('Enter a time like 21:30.', 'error'))}
            className="min-h-[44px] rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Add time
          </button>
          <span className="text-[11px] text-gray-500">Type any time. It joins your times above.</span>
        </div>
      </div>

      {/* While there are unsaved picks, Save stays pinned to the bottom of the
          panel's frame, so it is in reach however far the timeline scrolls.
          -bottom-3 offsets the panel's own py-3, so the bar sits flush on the
          frame with no strip of content showing under it. Closing with times
          not sent turns it into "Send your times?". */}
      <div
        ref={saveBarRef}
        data-pinned={unsaved}
        data-testid="save-bar"
        className={`flex items-center justify-between gap-2 flex-wrap ${
          unsaved
            ? `sticky -bottom-3 z-10 -mx-3 !-mb-3 border-t px-3 py-2 ${asking ? 'border-amber-300 bg-amber-50' : 'border-gray-200 bg-gray-50'}`
            : ''
        }`}
      >
        {asking && unsaved ? (
          <>
            <p className="text-sm font-semibold text-[#1a1a2e]" role="status">{ASK_SEND}</p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={discard}
                disabled={saving}
                className="min-h-[44px] rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Discard
              </button>
              <Button size="sm" onClick={save} disabled={saving} className="min-h-[44px]">
                {saving ? 'Sending…' : 'Send'}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-[11px] text-gray-500">
              {unsaved
                ? 'Sending tells them when you are free.'
                : confirmables.length > 0
                  ? 'Tap a green time to confirm it.'
                  : 'Tap the times that suit you, then send.'}
            </p>
            <div className="flex items-center gap-2">
              {/* An explicit way out. Before this the only exits were a tap outside
                  or Escape, so the panel read as a trap (19 Sep). */}
              {onClose && (
                <button
                  type="button"
                  onClick={requestClose}
                  className="min-h-[44px] rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  {unsaved ? 'Close' : 'Done'}
                </button>
              )}
              {unsaved && (
                <Button size="sm" onClick={save} disabled={saving} className="min-h-[44px]">
                  {saving ? 'Sending…' : 'Save and send availability'}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
});

export default MeetingScheduler;
