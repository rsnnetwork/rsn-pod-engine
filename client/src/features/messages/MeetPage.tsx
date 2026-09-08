// ─── 1:1 meeting call (W-meet, 8 Sep 2026) ──────────────────────────────────
//
// A full-page call on RSN for a scheduled meeting or a "Meet now". Reached from
// the chat meeting card, the Join button, the bell "X is calling", or the email
// link. Uses the same LiveKit stack the events use. Leaving returns to the chat.

import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { LiveKitRoom, RoomAudioRenderer, ParticipantTile, ControlBar, useTracks, useRoomContext, type TrackReference } from '@livekit/components-react';
import '@livekit/components-styles';
import { Track, RoomEvent, type RemoteParticipant } from 'livekit-client';
import { ArrowLeft, CalendarClock, Maximize2, Minimize2, PhoneOff } from 'lucide-react';
import api from '@/lib/api';
import { PageLoader } from '@/components/ui/Spinner';

/** A stable key for a track reference (participant + source + track sid). */
function trackId(t: TrackReference | { participant?: { identity?: string }; source?: string; publication?: { trackSid?: string } }): string {
  return `${t.participant?.identity ?? '?'}:${t.source ?? '?'}:${t.publication?.trackSid ?? 'ph'}`;
}

// You can enter a scheduled meeting from 5 minutes before its start; earlier
// than that, you land on a countdown (but can still force your way in).
const EARLY_JOIN_MS = 5 * 60 * 1000;

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
            className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-lg bg-black/50 text-white hover:bg-black/70"
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
              className="absolute right-2 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-lg bg-black/50 text-white hover:bg-black/70"
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

// When the other person leaves (they hung up), the call is over for both — we
// surface a small "call ended" note and return to the chat (Ali, 8 Sep 2026).
function CallEndWatcher({ onRemoteLeft }: { onRemoteLeft: (name: string) => void }) {
  const room = useRoomContext();
  useEffect(() => {
    const handler = (p: RemoteParticipant) => onRemoteLeft(p?.name || 'The other person');
    room.on(RoomEvent.ParticipantDisconnected, handler);
    return () => { room.off(RoomEvent.ParticipantDisconnected, handler); };
  }, [room, onRemoteLeft]);
  return null;
}

export default function MeetPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const [params] = useSearchParams();
  const kind = params.get('kind') === 'audio' ? 'audio' : 'video';
  // Only a scheduled meeting is time-gated; an instant "Meet now" is never
  // gated (it's happening right now).
  const isScheduled = params.get('scheduled') === '1';
  const navigate = useNavigate();
  const [conn, setConn] = useState<{ token: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startAt, setStartAt] = useState<Date | null>(null);
  const [durationMin, setDurationMin] = useState<number | null>(null);
  const [scheduleChecked, setScheduleChecked] = useState(!isScheduled);
  const [now, setNow] = useState<number>(Date.now());
  const [forceJoin, setForceJoin] = useState(false);
  const [remoteEnded, setRemoteEnded] = useState<string | null>(null);

  const leave = useCallback(() => navigate(`/messages/${conversationId}`), [navigate, conversationId]);
  const handleRemoteLeft = useCallback((name: string) => setRemoteEnded(name), []);

  // Once the other person leaves, show the note briefly, then return to chat.
  useEffect(() => {
    if (!remoteEnded) return;
    const t = setTimeout(leave, 3500);
    return () => clearTimeout(t);
  }, [remoteEnded, leave]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.post(`/dm/conversations/${conversationId}/call-token`, { kind });
        if (!cancelled) setConn({ token: data.data.token, url: data.data.url });
      } catch (e: any) {
        if (!cancelled) setError(e?.response?.data?.error?.message || 'Could not start the call. Try again from the chat.');
      }
    })();
    return () => { cancelled = true; };
  }, [conversationId, kind]);

  // For a scheduled meeting, learn its start time so we can gate early joins.
  useEffect(() => {
    if (!isScheduled) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get(`/dm/conversations/${conversationId}/scheduling`);
        const s = data?.data?.confirmed?.startAt;
        if (!cancelled && s) { setStartAt(new Date(s)); setDurationMin(data?.data?.confirmed?.durationMin ?? null); }
      } catch { /* no schedule info → don't gate */ }
      finally { if (!cancelled) setScheduleChecked(true); }
    })();
    return () => { cancelled = true; };
  }, [conversationId, isScheduled]);

  // Tick the countdown while we're waiting for a scheduled meeting to open.
  const waiting = isScheduled && !forceJoin && !!startAt && now < startAt.getTime() - EARLY_JOIN_MS;
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

  // A scheduled meeting whose window has fully ended (30 min past its end) —
  // don't drop into an empty room; point them back to the chat to call now.
  const MEETING_GRACE_MS = 30 * 60 * 1000;
  const ended = isScheduled && !forceJoin && !!startAt
    && now > startAt.getTime() + ((durationMin ?? 30) * 60_000) + MEETING_GRACE_MS;
  if (ended) {
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
          <p className="text-sm text-white/50">
            {startAt.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}
          </p>
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
  if (waiting) {
    const startMs = startAt!.getTime();
    const remaining = startMs - now;
    const localTime = startAt!.toLocaleString([], {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    });
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
          You can wait here — it opens automatically 5 minutes before — or join now if you're ready early.
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

  // The other person hung up — the call is over for both. Show a small note,
  // then go back to the chat.
  if (remoteEnded) {
    return (
      <div
        className="flex min-h-[100dvh] flex-col items-center justify-center gap-5 bg-[#0b0b12] px-6 text-center text-white"
        style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-white/10">
          <PhoneOff className="h-7 w-7 text-white/70" />
        </div>
        <div className="space-y-1">
          <p className="text-lg font-semibold">Call ended</p>
          <p className="text-sm text-white/50">{remoteEnded} left the call.</p>
        </div>
        <button onClick={leave} className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-white/10 px-4 text-sm font-medium hover:bg-white/20">
          <ArrowLeft className="h-4 w-4" /> Back to chat
        </button>
      </div>
    );
  }

  // Don't flash into the room before we know a scheduled meeting's start time.
  if (!conn || (isScheduled && !scheduleChecked)) {
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
          className="flex h-10 w-10 items-center justify-center rounded-lg text-white/80 hover:bg-white/10 hover:text-white"
          aria-label="Leave call and go back to chat"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0">
          <p className="text-sm font-semibold">{kind === 'audio' ? 'Audio call' : 'Video call'}</p>
          <p className="text-[11px] text-white/50">Connected on RSN</p>
        </div>
      </div>

      <LiveKitRoom
        token={conn.token}
        serverUrl={conn.url}
        connect
        video={kind === 'video'}
        audio
        onDisconnected={leave}
        style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: 'transparent' }}
      >
        <CallStage />
        <RoomAudioRenderer />
        <CallEndWatcher onRemoteLeft={handleRemoteLeft} />
        <div className="shrink-0" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
          <ControlBar variation="minimal" />
        </div>
      </LiveKitRoom>
    </div>
  );
}
