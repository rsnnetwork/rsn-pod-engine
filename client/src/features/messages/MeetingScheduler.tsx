// ─── Meeting Scheduler ───────────────────────────────────────────────────────
//
// Lives inside a 1:1 conversation (REASON v1 Phase 2, 19 Jul 2026). Each side
// taps the 30-minute times that suit them on their own clock; a time is stored
// as a UTC instant, so two zones meet on the same moment. Times both saved turn
// green, and either side confirms one: the meeting (time, length, audio or
// video) lands in the thread and the partner is told.
//
// This file draws the panel. What it shows is useSchedulerData (the server's
// answer and the days on offer), what the member has not sent is
// useSchedulerDraft, and what each action does is useSchedulerActions; the
// scheduling rules themselves are in scheduler-flow.ts.

import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useToastStore } from '@/stores/toastStore';
import { useAuthStore } from '@/stores/authStore';
import { cellLabels, dayKeyOf, isMeetingOver, knownZone, viewerZone, zoneLine, zoneName } from './scheduler-flow';
import SchedulerConfirmCard from './SchedulerConfirmCard';
import SchedulerDayStrip from './SchedulerDayStrip';
import SchedulerLoadState from './SchedulerLoadState';
import SchedulerMeetingSummary from './SchedulerMeetingSummary';
import SchedulerOverlapList from './SchedulerOverlapList';
import SchedulerSaveBar from './SchedulerSaveBar';
import SchedulerSlotGrid from './SchedulerSlotGrid';
import SchedulerTypedTime from './SchedulerTypedTime';
import { useSchedulerActions } from './useSchedulerActions';
import { useSchedulerData } from './useSchedulerData';
import { useSchedulerDraft } from './useSchedulerDraft';
import { useReveal, useSchedulerScroll } from './useSchedulerScroll';

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

const MeetingScheduler = forwardRef<SchedulerHandle, SchedulerProps>(function MeetingScheduler(
  { conversationId, onClose, confirmRequest, focusFirstPick },
  ref,
) {
  const { addToast } = useToastStore();
  const zone = useMemo(viewerZone, []);
  const me = useAuthStore(s => s.user?.id) as string | undefined;
  const profileZone: unknown = useAuthStore(s => s.user?.timezone);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  // The panel scrolls inside the thread column, the timeline inside the panel.
  const panelRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const saveBarRef = useRef<HTMLDivElement>(null);
  const confirmCardRef = useRef<HTMLDivElement>(null);

  const model = useSchedulerData(conversationId, zone, selectedDay);
  const { data, query, now, current, visible, savedMine, theirSet, bookedKey, confirmables, standing } = model;
  const { flashKey, reveal } = useReveal({ panelRef, gridRef, saveBarRef });
  const draft = useSchedulerDraft({ conversationId, data, savedMine, dayKey: current.dayKey, zone, now, reveal });
  const { mine, unsaved, asking, addTypedTime } = draft;
  const act = useSchedulerActions({
    conversationId, zone, me, onClose, model, draft, selectDay: setSelectedDay, reveal, panelRef, confirmRequest,
  });
  const { finalizing, confirming, pressCell, requestClose } = act;
  const headline = !data ? 'none' : data.confirmed ? 'confirmed' : confirmables.length > 0 ? 'overlap' : 'none';
  useSchedulerScroll({
    panelRef, gridRef, saveBarRef, confirmCardRef, reveal, dayKey: current.dayKey, daySlots: current.slots,
    loaded: !!data, saved: savedMine, theirs: theirSet, bookedKey, zone, focusFirstPick, finalizing, headline,
  });
  useImperativeHandle(ref, () => ({ requestClose }));
  const [showAllOverlap, setShowAllOverlap] = useState(false);

  if (!data) return <SchedulerLoadState failed={query.isError} onRetry={() => void query.refetch()} />;

  // Emails and bells show times in the zone saved on the profile: say so when it is not this one.
  const ownZone = zoneName(zone, now);
  const savedZone = typeof profileZone === 'string' && knownZone(profileZone) ? zoneName(profileZone, now) : null;
  const hint = unsaved
    ? 'Sending tells them when you are free.'
    : confirmables.length > 0 ? 'Tap a green time to confirm it.' : 'Tap the times that suit you, then send.';

  return (
    <div
      ref={panelRef}
      className={`min-h-0 overflow-y-auto overscroll-contain border-b border-gray-200 bg-gray-50/60 px-3 py-3 space-y-3 ${unsaved ? 'scroll-pb-24' : ''}`}
      data-testid="meeting-scheduler"
    >
      {data.confirmed && (
        <SchedulerMeetingSummary
          conversationId={conversationId}
          meeting={data.confirmed}
          over={isMeetingOver(data.confirmed.startAt, data.confirmed.durationMin, now)}
          zone={zone}
          onAddToCalendar={act.downloadIcs}
        />
      )}

      {(confirmables.length > 0 || finalizing) && (
        <SchedulerOverlapList
          standing={standing}
          times={confirmables}
          open={finalizing}
          showAll={showAllOverlap}
          onShowAll={() => setShowAllOverlap(true)}
          onPick={act.openConfirm}
          busy={confirming !== null}
          zone={zone}
          card={finalizing && (
            <SchedulerConfirmCard
              cardRef={confirmCardRef}
              slot={finalizing}
              zone={zone}
              zoneText={ownZone}
              moving={standing}
              reason={act.cardReason}
              durationText={draft.durationText}
              onDuration={draft.setDurationText}
              kind={draft.meetingKind}
              onKind={draft.setMeetingKind}
              busy={confirming !== null}
              sendingThis={confirming === finalizing}
              canRemove={savedMine.has(finalizing)}
              onConfirm={() => act.confirm(finalizing)}
              onCancel={() => act.setFinalizing(null)}
              onRemove={() => act.removeTime(finalizing)}
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
          days={model.days.map(d => d.dayKey)}
          current={current.dayKey}
          mine={mine}
          theirs={theirSet}
          dayOf={new Map([...mine, ...theirSet].map(k => [k, dayKeyOf(k, zone)] as const))}
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
          value={draft.customTime}
          onChange={draft.setCustomTime}
          onAdd={addTypedTime}
          onEmpty={() => addToast('Enter a time like 21:30.', 'error')}
        />
      </div>

      <SchedulerSaveBar
        barRef={saveBarRef}
        unsaved={unsaved}
        asking={asking}
        saving={act.saving}
        hint={hint}
        closable={!!onClose}
        onRequestClose={requestClose}
        onSave={act.save}
        onDiscard={act.discard}
      />
    </div>
  );
});

export default MeetingScheduler;
