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
// the nights the clocks change have each time once (scheduler-flow.ts). A save
// never moves a meeting that stands: it opens the Move card on the new time,
// and the member presses Move.
//
// The card, the timeline, the day strip and the Save bar are their own
// components (SchedulerConfirmCard, SchedulerSlotGrid, SchedulerDayStrip,
// SchedulerSaveBar); this file holds the state and what each action does.

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { E } from '@/realtime/entities';
import { Spinner } from '@/components/ui/Spinner';
import api from '@/lib/api';
import { useToastStore } from '@/stores/toastStore';
import { useAuthStore } from '@/stores/authStore';
import {
  NOT_SHARED, SLOT_MINUTES,
  cardSeed, cellLabels, confirmFailure, confirmable, confirmedMessage, dayKeyOf, daySlots, hasStarted, isMeetingOver,
  isSlotKey, knownZone, meetingLength, meetingStands, saveMessage, saveOutcome, schedulerError, typedSlot,
  upcomingDays, viewerZone, whenWithZone, zoneLine, zoneName,
  type CellState,
} from './scheduler-flow';
import { schedulingKey, type Scheduling } from './scheduling-types';
import SchedulerConfirmCard from './SchedulerConfirmCard';
import SchedulerDayStrip from './SchedulerDayStrip';
import SchedulerMeetingSummary from './SchedulerMeetingSummary';
import SchedulerOverlapList from './SchedulerOverlapList';
import SchedulerSaveBar from './SchedulerSaveBar';
import SchedulerSlotGrid from './SchedulerSlotGrid';
import SchedulerTypedTime from './SchedulerTypedTime';
import { useSchedulerScroll } from './useSchedulerScroll';

const DAYS_AHEAD = 7;
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
  const queryClient = useQueryClient();
  const zone = useMemo(viewerZone, []);
  const me = useAuthStore(s => s.user?.id) as string | undefined;
  const profileZone: unknown = useAuthStore(s => s.user?.timezone);
  const [staged, setStaged] = useState<Set<string> | null>(() => drafts.get(conversationId)?.staged ?? null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  // The shared time being confirmed (or the standing meeting being moved to).
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
  // The panel scrolls inside the thread column, the timeline inside the panel
  // (useSchedulerScroll keeps what matters in sight).
  const gridRef = useRef<HTMLDivElement>(null);
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
    queryKey: schedulingKey(conversationId),
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

  // The step that finishes the job sits at the top of the panel; what each day opens on, a typed or pointed-at
  // time and the confirm card are kept in sight (and Reschedule's first pick takes the focus).
  const headline = !data ? 'none' : data.confirmed ? 'confirmed' : confirmables.length > 0 ? 'overlap' : 'none';
  const { flashKey, reveal } = useSchedulerScroll({
    panelRef, gridRef, saveBarRef, confirmCardRef, dayKey: current.dayKey, daySlots: current.slots, loaded: !!data,
    saved: savedMine, theirs: theirSet, bookedKey, zone, focusFirstPick, finalizing, headline,
  });

  // The card opens on a time. Moving a meeting that stands keeps its own length
  // and kind (a 45-minute audio meeting stays so) unless the member changes them.
  const showCard = (slot: string, meeting: Scheduling['confirmed'] | undefined) => {
    const seed = cardSeed(meeting, Date.now());
    if (seed) { setDurationText(seed.duration); setMeetingKind(seed.kind); }
    setAsking(false);
    setFinalizing(slot);
    setSelectedDay(dayKeyOf(slot, zone));
    reveal(slot, false);
  };

  // The confirm card for a time both have saved: from a green cell, a chip, or
  // the thread card's time. A time that is no longer shared is said so, not opened.
  const openConfirm = (slot: string) => {
    if (!confirmable(data?.overlap ?? [], Date.now()).includes(slot) || slot === bookedKey) {
      addToast(NOT_SHARED, 'info');
      return;
    }
    showCard(slot, data?.confirmed);
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
  // on the timeline, scrolled into view. A question already on screen ("Send
  // your times?") stays: the blur that adds the time is not an answer to it.
  const addTypedTime = () => {
    if (!customTime) return;
    const key = typedSlot(current.dayKey, customTime, zone);
    if (!key) { addToast('Enter a time like 21:30.', 'error'); return; }
    if (hasStarted(key, Date.now())) { addToast('That time has already passed.', 'error'); return; }
    if (!mine.has(key)) setStaged(new Set([...mine, key]));
    setCustomTime('');
    reveal(key, true);
  };

  const durationMin = meetingLength(durationText);
  const durationOk = durationMin !== null;

  const refreshThread = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: schedulingKey(conversationId) }),
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

  // Saving SENDS: the thread gets a line either way (19 Sep: "we both have
  // saved our availability?" / "I have no clue!!!"), and since 25 Oct the save
  // that leaves one shared time books it. The server's answer says which.
  const save = async () => {
    if (saving) return;
    setSaving(true);
    const known = data.confirmed;
    const windows = typed && !mine.has(typed) ? [...mine, typed] : [...mine];
    const added = windows.filter(w => !savedMine.has(w));
    try {
      const res = await api.put(`/dm/conversations/${conversationId}/scheduling/availability`, {
        windows,
        ...(durationOk ? { durationMin } : {}),
        type: meetingKind,
      });
      const after = res.data.data as Scheduling;
      const outcome = saveOutcome(after, { me, known, added }, Date.now());
      await refreshThread();
      forgetDraft();
      const asks = outcome.kind === 'move' || outcome.kind === 'move-choice';
      addToast(saveMessage(outcome, zone), asks ? 'info' : 'success');
      if (outcome.kind === 'move') {
        // A save never moves a meeting: the Move card opens on the new time, and the member decides.
        showCard(outcome.to, after.confirmed);
        return;
      }
      if (outcome.kind === 'overlap' || outcome.kind === 'move-choice') {
        // Times you both can, and nothing booked or moved: picking one is the
        // next step, so it stays in front of you (the top of the panel).
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

  // One request books the time, or moves the meeting there. If it fails nothing
  // changed on the server: the card stays open to try again (it says so itself
  // if the time is no longer shared), and the toast says where the meeting is.
  const confirm = async (key: string) => {
    if (confirming || durationMin === null) return;
    setConfirming(key);
    const moving = standing;
    const stays = data.confirmed?.startAt ?? null;
    try {
      // The slot IS the instant — the server stores it and every client
      // renders it in its own timezone.
      await api.post(`/dm/conversations/${conversationId}/scheduling/confirm`, { window: key, durationMin, type: meetingKind });
      setFinalizing(null);
      await refreshThread();
      addToast(confirmedMessage(key, zone, moving), 'success');
    } catch (err) {
      await queryClient.invalidateQueries({ queryKey: schedulingKey(conversationId) });
      addToast(confirmFailure(err, { moving, stays, zone }), 'error');
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
  const dayOf = new Map([...mine, ...theirSet].map(k => [k, dayKeyOf(k, zone)] as const));
  // Emails and bells show times in the zone saved on the profile: say so when it is not this one.
  const ownZone = zoneName(zone, now);
  const savedZone = typeof profileZone === 'string' && knownZone(profileZone) ? zoneName(profileZone, now) : null;
  const hint = unsaved
    ? 'Sending tells them when you are free.'
    : confirmables.length > 0
      ? 'Tap a green time to confirm it.'
      : 'Tap the times that suit you, then send.';

  return (
    <div
      ref={panelRef}
      className={`min-h-0 overflow-y-auto overscroll-contain border-b border-gray-200 bg-gray-50/60 px-3 py-3 space-y-3 ${
        unsaved ? 'scroll-pb-24' : ''
      }`}
      data-testid="meeting-scheduler"
    >
      {data.confirmed && (
        <SchedulerMeetingSummary
          conversationId={conversationId}
          meeting={data.confirmed}
          over={confirmedOver}
          zone={zone}
          onAddToCalendar={downloadIcs}
        />
      )}

      {(confirmables.length > 0 || finalizing) && (
        <SchedulerOverlapList
          standing={standing}
          times={confirmables}
          open={finalizing}
          showAll={showAllOverlap}
          onShowAll={() => setShowAllOverlap(true)}
          onPick={openConfirm}
          busy={confirming !== null}
          zone={zone}
          card={finalizing && (
            <SchedulerConfirmCard
              cardRef={confirmCardRef}
              slot={finalizing}
              zone={zone}
              zoneText={ownZone}
              moving={standing}
              stillShared={confirmables.includes(finalizing)}
              durationText={durationText}
              onDuration={setDurationText}
              kind={meetingKind}
              onKind={setMeetingKind}
              busy={confirming !== null}
              sendingThis={confirming === finalizing}
              canRemove={savedMine.has(finalizing)}
              onConfirm={() => confirm(finalizing)}
              onCancel={() => setFinalizing(null)}
              onRemove={() => removeTime(finalizing)}
            />
          )}
        />
      )}

      <div className="space-y-2">
        <p className="text-[11px] text-gray-600">Tap the times you are free. Green means you both can.</p>
        <p className="text-[11px] font-medium text-gray-700" data-testid="scheduler-zone">{zoneLine(zone, now)}</p>
        {savedZone && savedZone !== ownZone && (
          <p className="text-[11px] text-gray-600">Emails show times in {savedZone}, the time zone in your profile.</p>
        )}

        <SchedulerDayStrip
          days={days.map(d => d.dayKey)}
          current={current.dayKey}
          mine={mine}
          theirs={theirSet}
          dayOf={dayOf}
          onSelect={setSelectedDay}
        />

        <SchedulerSlotGrid
          gridRef={gridRef}
          dayKey={current.dayKey}
          slots={visible}
          labels={cellLabels(visible, zone)}
          mine={mine}
          saved={savedMine}
          theirs={theirSet}
          booked={bookedKey}
          flashKey={flashKey}
          onPress={pressCell}
        />
        <p className="text-[11px] text-gray-500">Scroll the times for earlier or later in the day.</p>

        <SchedulerTypedTime
          dayKey={current.dayKey}
          value={customTime}
          onChange={setCustomTime}
          onAdd={addTypedTime}
          onEmpty={() => addToast('Enter a time like 21:30.', 'error')}
        />
      </div>

      <SchedulerSaveBar
        barRef={saveBarRef}
        unsaved={unsaved}
        asking={asking}
        saving={saving}
        hint={hint}
        closable={!!onClose}
        onRequestClose={requestClose}
        onSave={save}
        onDiscard={discard}
      />
    </div>
  );
});

export default MeetingScheduler;
