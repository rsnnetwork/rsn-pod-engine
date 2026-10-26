// ─── 1:1 meeting call (W-meet, 8 Sep 2026) ──────────────────────────────────
//
// A full-page call on REASON for a scheduled meeting or a "Meet now". Reached from
// the chat meeting card, the Join button, the bell "X is calling", or the email
// link. Uses the same LiveKit stack the events use. Leaving returns to the chat.
//
// 26 Oct 2026: one person leaving no longer ends the call for the other (they
// are told, and can wait for them to come back in), and the room's token is
// minted as the person goes in, not when the page loads. The meeting's time
// is read from the same query the scheduler and the thread read, so a move
// made while this page waits on its countdown moves the countdown too.

import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { LiveKitRoom, RoomAudioRenderer, ParticipantTile, ControlBar, useTracks, useRoomContext, type TrackReference } from '@livekit/components-react';
import '@livekit/components-styles';
import { Track } from 'livekit-client';
import { ArrowLeft, CalendarClock, Maximize2, Minimize2, PhoneOff } from 'lucide-react';
import { MEETING_JOIN_EARLY_MIN } from '@rsn/shared';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import { PageLoader } from '@/components/ui/Spinner';
import { errorMessage } from '@/features/reason/errors';
import { leftCallText, watchPartner } from './call-presence';
import { isMeetingOver, viewerZone, whenWithZone } from './scheduler-flow';
import { schedulingKey, type Scheduling } from './scheduling-types';

/** A stable key for a track reference (participant + source + track sid). */
function trackId(t: TrackReference | { participant?: { identity?: string }; source?: string; publication?: { trackSid?: string } }): string {
  return `${t.participant?.identity ?? '?'}:${t.source ?? '?'}:${t.publication?.trackSid ?? 'ph'}`;
}

// A scheduled meeting can be entered from MEETING_JOIN_EARLY_MIN minutes before
// its start (the shared rule the meetings list and the meeting's page use);
// earlier than that, you land on a countdown (but can still force your way in).
// Its room stays open until isMeetingOver says the meeting has ended.
const EARLY_JOIN_MS = MEETING_JOIN_EARLY_MIN * 60_000;

/** "2h 15m", "14m 30s", "less than a minute". */
function untilLabel(ms: number): string {
  if (ms <= 0) return 'now';
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (totalMin > 0) {
    const s = Math.floor((ms % 60000) / 1000);
    return `${m}m ${String(s).padStart(2, '0')}s`;
  }
  return 'less than a minute';
}

// The call stage. Any tile can be maximized (focused) — and a screen share is
// focused automatically — so a viewer can make what they're watching bigger or
// smaller as they like (Ali, 8 Sep 2026).
function CallStage() {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // Auto-focus a screen share the moment one starts (the usual thing to watch).
  const screen = tracks.find((t) => t.source === Track.Source.ScreenShare);
  const screenKey = screen ? trackId(screen) : null;
  useEffect(() => {
    if (screenKey) setFocusedId(screenKey);
  }, [screenKey]);

  const focused = tracks.find((t) => trackId(t) === focusedId) ?? null;

  if (focused) {
    const others = tracks.filter((t) => trackId(t) !== focusedId);
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg">
          <ParticipantTile trackRef={focused} className="h-full w-full" />
          <button
            onClick={() => setFocusedId(null)}
            className="absolute right-3 top-3 z-10 flex h-11 w-11 items-center justify-center rounded-lg bg-black/50 text-white hover:bg-black/70"
            title="Shrink to grid"
            aria-label="Shrink this view back to the grid"
          >
            <Minimize2 className="h-4.5 w-4.5" />
          </button>
        </div>
        {others.length > 0 && (
          <div className="flex shrink-0 gap-2 overflow-x-auto">
            {others.map((t) => (
              <button
                key={trackId(t)}
                onClick={() => setFocusedId(trackId(t))}
                className="relative h-24 w-36 shrink-0 overflow-hidden rounded-lg ring-1 ring-white/10 hover:ring-white/40"
                title="Make this the big view"
                aria-label="Maximize this view"
              >
                <ParticipantTile trackRef={t} className="h-full w-full" />
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 p-2">
      <div className={`grid h-full gap-2 ${tracks.length <= 1 ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2'}`}>
        {tracks.map((t) => (
          <div key={trackId(t)} className="relative min-h-0 overflow-hidden rounded-lg">
            <ParticipantTile trackRef={t} className="h-full w-full" />
            <button
              onClick={() => setFocusedId(trackId(t))}
              className="absolute right-2 top-2 z-10 flex h-11 w-11 items-center justify-center rounded-lg bg-black/50 text-white hover:bg-black/70"
              title="Make this bigger"
              aria-label="Maximize this view"
            >
              <Maximize2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// When the other person leaves, the call goes on for whoever is still in it
// (26 Oct 2026). It used to end for both: this swapped the room for a "Call
// ended" screen and went back to the chat 3.5 s later, so Script B's "leave
// and rejoin without ending the other person's meeting" could not be done.
// Now the one still here is told who left, and chooses: Wait (stay in the
// room; the notice clears by itself when they come back in) or Leave.
function CallEndWatcher({ onLeave }: { onLeave: () => void }) {
  const room = useRoomContext();
  // Who left ('' when the room has no name for them); null while nobody has, or once they are back.
  const [leftName, setLeftName] = useState<string | null>(null);
  useEffect(() => watchPartner(room, setLeftName), [room]);
  if (leftName === null) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-3">
      <div
        role="status"
        aria-live="polite"
        data-testid="partner-left"
        className="pointer-events-auto w-full max-w-sm rounded-xl border border-white/15 bg-[#14141f]/95 p-4 text-center shadow-lg"
      >
        <PhoneOff className="mx-auto h-5 w-5 text-white/70" aria-hidden="true" />
        <p className="mt-2 text-base font-semibold">{leftCallText(leftName)}</p>
        <p className="mt-1 text-sm text-white/70">Wait for them to come back, or leave too.</p>
        <div className="mt-3 flex justify-center gap-2">
          <button
            type="button"
            onClick={() => setLeftName(null)}
            className="inline-flex min-h-[44px] min-w-[88px] items-center justify-center rounded-lg bg-white/10 px-4 text-sm font-medium text-white hover:bg-white/20"
          >
            Wait
          </button>
          <button
            type="button"
            onClick={onLeave}
            className="inline-flex min-h-[44px] min-w-[88px] items-center justify-center rounded-lg bg-rsn-red px-4 text-sm font-medium text-white hover:opacity-90"
          >
            Leave
          </button>
        </div>
      </div>
    </div>
  );
}

export default function MeetPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const [params] = useSearchParams();
  const kind = params.get('kind') === 'audio' ? 'audio' : 'video';
  // Only a scheduled meeting is time-gated; an instant "Meet now" is never
  // gated (it's happening right now).
  const isScheduled = params.get('scheduled') === '1';
  const navigate = useNavigate();
  // The token belongs to one room and kind: `room` keeps it from being reused if the page moves to another call.
  const [conn, setConn] = useState<{ token: string; url: string; room: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<number>(Date.now());
  const [forceJoin, setForceJoin] = useState(false);

  const leave = useCallback(() => navigate(`/messages/${conversationId}`), [navigate, conversationId]);

  // A scheduled meeting's start and length: the scheduler's own query, kept live
  // by the dm-conversation entity, so a move (or a cancel) reaches a page that is
  // already open. The page decides on a fresh read (never on what an earlier
  // page left in the cache); with no schedule to read (none, or the request
  // failed) it does not gate, and the server says whether there is a meeting.
  const schedule = useQuery<Scheduling>({
    queryKey: schedulingKey(conversationId ?? ''),
    queryFn: () => api.get(`/dm/conversations/${conversationId}/scheduling`).then(r => r.data.data),
    enabled: isScheduled && !!conversationId,
    refetchOnMount: 'always',
    meta: { entities: conversationId ? [E.dmConversation(conversationId)] : [] },
  });
  const meeting = isScheduled ? schedule.data?.confirmed ?? null : null;
  const startMs = meeting?.startAt ? Date.parse(meeting.startAt) : null;
  const scheduleChecked = !isScheduled || schedule.isFetchedAfterMount;
  const roomKey = `${conversationId}:${kind}`;
  const live = conn && conn.room === roomKey ? conn : null;

  // A scheduled meeting opened early waits on a countdown; one long over says
  // so. Once the person is in the room, neither takes them out of it again.
  const gated = isScheduled && !forceJoin && !live;
  const waiting = gated && startMs !== null && now < startMs - EARLY_JOIN_MS;
  const ended = gated && isMeetingOver(meeting?.startAt, meeting?.durationMin, now);
  // The room's token is minted as the person goes in: once the start time is
  // known, after the countdown or "Join now anyway". Minted on page load, a page
  // opened early entered later on a token from outside the meeting's window,
  // and the server never counted that person as there (calls never unlocked).
  const entering = scheduleChecked && !waiting && !ended;

  useEffect(() => {
    if (!entering) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.post(`/dm/conversations/${conversationId}/call-token`, { kind });
        if (!cancelled) setConn({ token: data.data.token, url: data.data.url, room: `${conversationId}:${kind}` });
      } catch (e) {
        if (!cancelled) setError(errorMessage(e, 'Could not start the call. Try again from the chat.'));
      }
    })();
    return () => { cancelled = true; };
  }, [entering, conversationId, kind]);

  // Tick the countdown while we're waiting for a scheduled meeting to open.
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [waiting]);

  if (error) {
    return (
      <div
        className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-[#0b0b12] px-6 text-center text-white"
        style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <p className="max-w-sm text-lg">{error}</p>
        <button onClick={leave} className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-white/10 px-4 text-sm font-medium hover:bg-white/20">
          <ArrowLeft className="h-4 w-4" /> Back to chat
        </button>
      </div>
    );
  }

  // A scheduled meeting whose window has fully ended (isMeetingOver) — don't
  // drop into an empty room; point them back to the chat to call now.
  if (ended && meeting?.startAt) {
    return (
      <div
        className="flex min-h-[100dvh] flex-col items-center justify-center gap-5 bg-[#0b0b12] px-6 text-center text-white"
        style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-white/10">
          <CalendarClock className="h-7 w-7 text-white/60" />
        </div>
        <div className="space-y-1">
          <p className="text-lg font-semibold">This meeting has ended</p>
          <p className="text-sm text-white/50">{whenWithZone(meeting.startAt, viewerZone())}</p>
        </div>
        <p className="max-w-xs text-xs text-white/40">You can start a new call from the chat.</p>
        <button onClick={leave} className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-white/10 px-4 text-sm font-medium hover:bg-white/20">
          <ArrowLeft className="h-4 w-4" /> Back to chat
        </button>
      </div>
    );
  }

  // A scheduled meeting opened early — show a countdown, but never trap the user:
  // they can join now anyway, or go back.
  if (waiting && meeting?.startAt && startMs !== null) {
    const remaining = startMs - now;
    const localTime = whenWithZone(meeting.startAt, viewerZone());
    return (
      <div
        className="flex min-h-[100dvh] flex-col items-center justify-center gap-5 bg-[#0b0b12] px-6 text-center text-white"
        style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-white/10">
          <CalendarClock className="h-7 w-7 text-white/80" />
        </div>
        <div className="space-y-1">
          <p className="text-white/60 text-sm">Your meeting starts in</p>
          <p className="text-3xl font-bold tabular-nums">{untilLabel(remaining)}</p>
          <p className="text-white/50 text-sm">{localTime}</p>
        </div>
        <p className="max-w-xs text-xs text-white/40">
          You can wait here — it opens automatically {MEETING_JOIN_EARLY_MIN} minutes before — or join now if you're ready early.
        </p>
        <div className="flex flex-col items-center gap-3">
          <button
            onClick={() => setForceJoin(true)}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-emerald-600 px-5 text-sm font-semibold text-white hover:bg-emerald-700"
          >
            Join now anyway
          </button>
          <button onClick={leave} className="inline-flex min-h-[44px] items-center gap-2 text-sm text-white/70 hover:text-white">
            <ArrowLeft className="h-4 w-4" /> Back to chat
          </button>
        </div>
      </div>
    );
  }

  // Don't flash into the room before we know a scheduled meeting's start time,
  // or before its token is here.
  if (!live || (isScheduled && !scheduleChecked)) {
    return <div className="min-h-[100dvh] bg-[#0b0b12]"><PageLoader /></div>;
  }

  return (
    <div
      className="flex h-[100dvh] flex-col bg-[#0b0b12] text-white"
      data-lk-theme="default"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      {/* Slim top bar — leave affordance + what kind of call this is. */}
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-white/10 px-4">
        <button
          onClick={leave}
          className="flex h-11 w-11 items-center justify-center rounded-lg text-white/80 hover:bg-white/10 hover:text-white"
          aria-label="Leave call and go back to chat"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0">
          <p className="text-sm font-semibold">{kind === 'audio' ? 'Audio call' : 'Video call'}</p>
          <p className="text-[11px] text-white/50">Connected on REASON</p>
        </div>
      </div>

      <LiveKitRoom
        token={live.token}
        serverUrl={live.url}
        connect
        video={kind === 'video'}
        audio
        onDisconnected={leave}
        style={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: 'transparent' }}
      >
        <CallStage />
        <RoomAudioRenderer />
        <CallEndWatcher onLeave={leave} />
        <div className="shrink-0" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
          <ControlBar variation="minimal" />
        </div>
      </LiveKitRoom>
    </div>
  );
}
