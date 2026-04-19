import { useEffect, useState, useCallback, useRef, memo } from 'react';
import { useParams } from 'react-router-dom';
import { useSessionStore } from '@/stores/sessionStore';
import { formatTime } from '@/lib/utils';
import { Video, Clock, Mic, MicOff, VideoOff, Wifi, UserX, ArrowLeft, Sparkles } from 'lucide-react';
// Lazy-load track processors (may not be available in all environments)
let _bgBlur: any = null;
let _vBg: any = null;
let _bgLoaded = false;
async function loadBgProcessors() {
  if (_bgLoaded) return { BackgroundBlur: _bgBlur, VirtualBackground: _vBg };
  try {
    const mod = await import(/* @vite-ignore */ '@livekit/track-processors');
    _bgBlur = mod.BackgroundBlur;
    _vBg = mod.VirtualBackground;
    _bgLoaded = true;
    return { BackgroundBlur: _bgBlur, VirtualBackground: _vBg };
  } catch { return null; }
}
import { getSocket, disconnectSocket } from '@/lib/socket';
import {
  LiveKitRoom,
  VideoTrack,
  useTracks,
  useParticipants,
  useLocalParticipant,
  RoomAudioRenderer,
} from '@livekit/components-react';
import '@livekit/components-styles';
import { Track } from 'livekit-client';
import api from '@/lib/api';

// Prefer displayName → name → email local-part → "Partner".
// Avoids raw email addresses (and their trailing @domain) rendering full-width
// across the video tile when displayName is missing.
function userDisplayLabel(
  input?: { displayName?: string | null; email?: string | null; name?: string | null } | string | null,
): string {
  if (!input) return 'Partner';
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return 'Partner';
    return trimmed.includes('@') ? trimmed.split('@')[0] : trimmed;
  }
  const asAny = input as { displayName?: string | null; name?: string | null; email?: string | null };
  if (asAny.displayName && String(asAny.displayName).trim()) return String(asAny.displayName).trim();
  if (asAny.name && String(asAny.name).trim()) return String(asAny.name).trim();
  if (asAny.email) return String(asAny.email).split('@')[0];
  return 'Partner';
}

// Bug 8.7 (April 19) — memo'd. ConnectionIndicator has no props/state so
// React skips re-render when the parent re-renders for unrelated reasons
// (timer tick, dashboard update, etc.). Eliminates the visible flashing
// reported during live testing on the breakout-room toolbar.
const ConnectionIndicator = memo(function ConnectionIndicator() {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20">
      <Wifi className="h-3 w-3 text-emerald-400" />
      <span className="text-xs text-emerald-400">Connected</span>
    </div>
  );
});

// Bug 10 (April 19) — anchored reaction badge above the tile name.
// Subscribes ONLY to the per-user reaction entry so unrelated tiles
// don't re-render when a different person reacts. Auto-clears after 8s.
const TileReaction = memo(function TileReaction({ userId }: { userId?: string }) {
  const reaction = useSessionStore(s => userId ? s.tileReactions[userId] : undefined);
  if (!reaction) return null;
  return (
    <div className="absolute bottom-10 left-2 flex items-center gap-1 bg-black/80 text-white rounded-full px-2 py-0.5 shadow-lg animate-fade-in pointer-events-none z-20">
      <span className="text-base leading-none">{reaction.emoji}</span>
      <span className="text-[10px] font-medium truncate max-w-[120px]">{reaction.displayName}</span>
    </div>
  );
});

function VideoTile({ trackRef, label, isWaiting, isPinned, userId, fillMode = 'contain' }: { trackRef?: any; label: string; isWaiting?: boolean; isPinned?: boolean; userId?: string; fillMode?: 'contain' | 'cover' }) {
  const hasVideo = trackRef?.publication?.track;
  // Bug 2 + Bug 6 (April 18 Dr Arch): VideoTile fills its parent cell, but
  // the inner VideoTrack uses object-CONTAIN (not cover). Reasoning:
  //   - object-cover crops the source to fill the cell. Portrait phone video
  //     rendered in a landscape desktop tile gets aggressively zoomed in so
  //     only the centre slice of the face is visible (Bug #6).
  //   - object-contain preserves the full source frame and pads with the
  //     tile's bg colour (black for video tiles) — matches the way Google
  //     Meet shows portrait video on desktop without cropping.
  // The black `bg-black` parent makes the letterbox feel intentional and
  // unobtrusive instead of looking like a broken tile.
  return (
    <div className={`relative rounded-xl overflow-hidden ${fillMode === 'contain' ? 'rsn-tile-contain' : ''} ${hasVideo ? 'bg-black' : 'bg-[#3c4043]'} ${isPinned ? 'h-full w-full' : 'h-full w-full'} flex items-center justify-center`}>
      {hasVideo ? (
        <VideoTrack trackRef={trackRef} className={`h-full w-full ${fillMode === 'contain' ? 'object-contain' : 'object-cover'}`} />
      ) : (
        <div className="flex flex-col items-center gap-2">
          <div className={`h-20 w-20 rounded-full bg-[#5f6368] flex items-center justify-center ${isWaiting ? 'animate-pulse' : ''}`}>
            <Video className={`h-8 w-8 ${isWaiting ? 'text-gray-500' : 'text-gray-400'}`} />
          </div>
          <p className="text-gray-400 text-sm">
            {isWaiting ? 'Waiting for partner...' : `${label} — camera off`}
          </p>
        </div>
      )}
      <div className="absolute bottom-2 left-2 bg-black/60 rounded px-2 py-1 text-xs text-white max-w-[60%] truncate">
        {label}
      </div>
      <TileReaction userId={userId} />
    </div>
  );
}

// Bug 8.7 (April 19) — memo'd. VideoStage has no props; its internal
// selectors (currentPartners, useTracks, useParticipants) trigger their
// own re-renders when relevant. Memoization stops it from re-rendering
// when the parent VideoRoom re-renders for unrelated reasons.
const VideoStage = memo(function VideoStage() {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.Microphone, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );
  useParticipants(); // Keep subscribed for LiveKit track updates
  const { localParticipant } = useLocalParticipant();
  // Bug 8.7 (April 19) — selector pattern (was destructuring whole store).
  // Whole-store subscriptions made VideoStage re-render on EVERY field
  // change in the store (timer tick, dashboard refresh, participant
  // updates, etc.) which propagated to MediaControls + Leave/Main Room
  // buttons, causing the visible "flashing" reported during live testing.
  const currentPartners = useSessionStore(s => s.currentPartners);
  const [pinnedSid, setPinnedSid] = useState<string | null>(null);

  const cameraTracks = tracks.filter(t => t.source === Track.Source.Camera);
  const localTrack = cameraTracks.find(t => t.participant.sid === localParticipant.sid);
  const remoteTracks = cameraTracks.filter(t => t.participant.sid !== localParticipant.sid);

  const allTiles = [
    { trackRef: localTrack, label: 'You', sid: localParticipant.sid, userId: localParticipant.identity },
    ...remoteTracks.map((rt, i) => ({
      trackRef: rt,
      label: userDisplayLabel(rt.participant.name || currentPartners[i]),
      sid: rt.participant.sid,
      userId: rt.participant.identity,
    })),
  ];

  const pinnedTile = pinnedSid ? allTiles.find(t => t.sid === pinnedSid) : null;
  const unpinnedTiles = pinnedSid ? allTiles.filter(t => t.sid !== pinnedSid) : allTiles;

  const isTrio = currentPartners.length > 1;
  const gridClass = isTrio
    ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3'
    : 'grid-cols-1 md:grid-cols-2';

  if (pinnedTile) {
    return (
      <div className="flex-1 flex flex-col gap-3 max-h-[calc(100dvh-160px)]">
        {/* Pinned tile — large. Bug 6.5: same aspect-video cap as the grid
            cells so the pinned tile matches webcam source aspect (16:9)
            and avoids the huge black bar below the video on tall windows. */}
        <div className="flex-1 min-h-0 flex items-center justify-center cursor-pointer" onClick={() => setPinnedSid(null)}>
          <div className="relative w-full" style={{ aspectRatio: '16 / 9', maxHeight: '100%' }}>
            <VideoTile trackRef={pinnedTile.trackRef} label={pinnedTile.label} isPinned userId={pinnedTile.userId} />
            <div className="absolute top-2 right-2 bg-black/60 text-white text-[10px] px-2 py-0.5 rounded-full">
              Pinned · click to unpin
            </div>
          </div>
        </div>
        {/* Unpinned tiles — small row */}
        <div className="flex gap-3 h-28 shrink-0">
          {unpinnedTiles.map(t => (
            <div key={t.sid} className="flex-1 cursor-pointer" onClick={() => setPinnedSid(t.sid)}>
              <VideoTile trackRef={t.trackRef} label={t.label} userId={t.userId} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Mobile 1:1: stacked layout — partner 60%, self 40% (FaceTime/Google Meet style)
  // Mobile trio: partner grid + larger floating self-view
  // Desktop: side-by-side equal grid tiles
  return (
    <div className="flex-1 relative max-h-[calc(100dvh-160px)]">
      {remoteTracks.length > 0 ? (
        <>
          {/* Desktop: equal grid tiles including self-view.
              Bug 2 (April 18) — cells are h-full so VideoTile fills vertically.
              Bug 6.5 (April 19) — cap each tile to 16:9 aspect ratio so the
              tile matches the webcam source (which is universally 16:9). The
              previous "fill the cell" approach made each cell ~960×920
              (almost square) on a 1920px-wide desktop; with object-contain
              that left huge black bars below the video. Now: cells flex-
              center the inner tile with aspect-ratio 16/9 + max-h-full, so
              the tile is naturally sized like a Google Meet tile (width =
              column, height = width × 9/16). On short windows max-h-full
              caps the height and width shrinks proportionally to maintain
              the aspect ratio — no distortion, no overflow. */}
          <div className={`hidden md:grid h-full gap-4 ${isTrio ? 'grid-cols-2 lg:grid-cols-3' : 'grid-cols-2'}`}>
            {remoteTracks.map((rt, i) => (
              <div key={rt.participant.sid} className="h-full flex items-center justify-center cursor-pointer" onClick={() => setPinnedSid(rt.participant.sid)}>
                <div className="w-full" style={{ aspectRatio: '16 / 9', maxHeight: '100%' }}>
                  <VideoTile trackRef={rt} label={userDisplayLabel(rt.participant.name || currentPartners[i])} userId={rt.participant.identity} />
                </div>
              </div>
            ))}
            <div className="h-full flex items-center justify-center cursor-pointer" onClick={() => setPinnedSid(localParticipant.sid)}>
              <div className="w-full" style={{ aspectRatio: '16 / 9', maxHeight: '100%' }}>
                <VideoTile trackRef={localTrack} label="You" userId={localParticipant.identity} />
              </div>
            </div>
          </div>

          {/* Mobile 1:1: WhatsApp/Google Meet style — partner full screen, self-view PIP top-right */}
          {!isTrio && (
            <div className="md:hidden h-full relative">
              <div className="h-full cursor-pointer" onClick={() => setPinnedSid(remoteTracks[0].participant.sid)}>
                <VideoTile trackRef={remoteTracks[0]} label={userDisplayLabel(remoteTracks[0].participant.name || currentPartners[0])} userId={remoteTracks[0].participant.identity} />
              </div>
              <div
                className="absolute top-3 right-3 w-32 h-44 sm:w-36 sm:h-48 rounded-xl overflow-hidden shadow-lg border-2 border-white/80 z-10 bg-black"
                onClick={() => setPinnedSid(localParticipant.sid)}
                style={{ cursor: 'pointer' }}
              >
                <div className="absolute inset-0">
                  {/* Bug 16: PIP self-view uses cover mode — small portrait
                      container with portrait source looks too small with
                      contain (visible side bars shrink the user). */}
                  <VideoTile trackRef={localTrack} label="You" userId={localParticipant.identity} fillMode="cover" />
                </div>
              </div>
            </div>
          )}

          {/* Mobile trio: remote participants split screen, self-view PIP top-right.
              Bug 2 (April 18 Dr Arch): each row cell is h-full + min-h-0 so the
              tiles fill vertically (otherwise aspect-video collapses them). */}
          {isTrio && (
            <div className="md:hidden h-full relative">
              <div className="h-full grid grid-cols-1 gap-2">
                {remoteTracks.map((rt, i) => (
                  <div key={rt.participant.sid} className="h-full min-h-0 cursor-pointer" onClick={() => setPinnedSid(rt.participant.sid)}>
                    <VideoTile trackRef={rt} label={userDisplayLabel(rt.participant.name || currentPartners[i])} userId={rt.participant.identity} />
                  </div>
                ))}
              </div>
              <div
                className="absolute top-3 right-3 w-32 h-44 sm:w-36 sm:h-48 rounded-xl overflow-hidden shadow-lg border-2 border-white/80 z-10 bg-black"
                onClick={() => setPinnedSid(localParticipant.sid)}
                style={{ cursor: 'pointer' }}
              >
                <div className="absolute inset-0">
                  {/* Bug 16: PIP self-view uses cover mode — small portrait
                      container with portrait source looks too small with
                      contain (visible side bars shrink the user). */}
                  <VideoTile trackRef={localTrack} label="You" userId={localParticipant.identity} fillMode="cover" />
                </div>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className={`h-full grid ${gridClass} gap-4`}>
          <VideoTile trackRef={localTrack} label="You" userId={localParticipant.identity} />
          {currentPartners.map((p, i) => (
            <VideoTile key={p.userId || i} label={userDisplayLabel(p)} isWaiting userId={p.userId} />
          ))}
        </div>
      )}
    </div>
  );
});

const BG_PRESETS = [
  { label: 'None', mode: 'disabled' as const, preview: null },
  { label: 'Blur', mode: 'background-blur' as const, preview: null },
  { label: 'Office', mode: 'virtual-background' as const, preview: 'https://images.unsplash.com/photo-1497366216548-37526070297c?w=400&q=80', image: 'https://images.unsplash.com/photo-1497366216548-37526070297c?w=1280&q=80' },
  { label: 'Nature', mode: 'virtual-background' as const, preview: 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=400&q=80', image: 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=1280&q=80' },
  { label: 'City', mode: 'virtual-background' as const, preview: 'https://images.unsplash.com/photo-1480714378408-67cf0d13bc1b?w=400&q=80', image: 'https://images.unsplash.com/photo-1480714378408-67cf0d13bc1b?w=1280&q=80' },
  { label: 'Abstract', mode: 'virtual-background' as const, preview: 'https://images.unsplash.com/photo-1557683316-973673baf926?w=400&q=80', image: 'https://images.unsplash.com/photo-1557683316-973673baf926?w=1280&q=80' },
];

// Bug 8.7 (April 19) — memo'd. MediaControls has its own internal state
// (mic/cam/bg toggles) and doesn't depend on parent props. Memoization
// stops the toolbar from re-rendering on every timer tick.
const MediaControls = memo(function MediaControls() {
  const { localParticipant } = useLocalParticipant();
  const [micEnabled, setMicEnabled] = useState(true);
  const [camEnabled, setCamEnabled] = useState(true);
  const [bgMode, setBgMode] = useState<string>('disabled');
  const [showBgPanel, setShowBgPanel] = useState(false);
  const processorRef = useRef<any>(null);

  useEffect(() => {
    if (localParticipant) {
      setCamEnabled(localParticipant.isCameraEnabled);
    }
  }, [localParticipant]);

  const toggleMic = useCallback(async () => {
    await localParticipant.setMicrophoneEnabled(!micEnabled);
    setMicEnabled(!micEnabled);
  }, [localParticipant, micEnabled]);

  const toggleCam = useCallback(async () => {
    const target = !camEnabled;
    try {
      if (!target) {
        await localParticipant.setCameraEnabled(false);
        setCamEnabled(false);
      } else {
        // Unpublish stale tracks first, then re-enable fresh
        for (const pub of localParticipant.videoTrackPublications.values()) {
          if (pub.track) {
            try { await localParticipant.unpublishTrack(pub.track); } catch { /* ignore */ }
          }
        }
        await localParticipant.setCameraEnabled(true);
        setCamEnabled(true);
        setTimeout(() => setCamEnabled(localParticipant.isCameraEnabled), 500);
      }
    } catch (err) {
      console.error('Camera toggle failed:', err);
      setCamEnabled(localParticipant.isCameraEnabled);
    }
  }, [localParticipant, camEnabled]);

  const applyBackground = useCallback(async (mode: string, imagePath?: string) => {
    try {
      const mod = await loadBgProcessors();
      if (!mod) { console.error('Background processors not available'); return; }
      const camPub = Array.from(localParticipant.trackPublications.values()).find(p => p.source === 'camera');
      const camTrack = camPub?.track;
      if (!camTrack) return;

      if (mode === 'disabled') {
        await (camTrack as any).stopProcessor?.();
        processorRef.current = null;
        setBgMode('disabled');
        return;
      }

      // Stop existing processor first
      await (camTrack as any).stopProcessor?.();

      if (mode === 'background-blur') {
        const processor = mod.BackgroundBlur(10);
        await (camTrack as any).setProcessor(processor);
        processorRef.current = processor;
      } else if (mode === 'virtual-background' && imagePath) {
        const processor = mod.VirtualBackground(imagePath);
        await (camTrack as any).setProcessor(processor);
        processorRef.current = processor;
      }
      setBgMode(mode + (imagePath ? ':' + imagePath : ''));
    } catch (err) {
      console.error('Background effect failed:', err);
    }
  }, [localParticipant]);

  const handleCustomUpload = useCallback(async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      await applyBackground('virtual-background', url);
      setShowBgPanel(false);
    };
    input.click();
  }, [applyBackground]);

  return (
    <div className="flex items-center gap-3 relative">
      <button onClick={toggleMic}
        className={`p-2 rounded-full transition-colors ${micEnabled ? 'bg-gray-200 hover:bg-gray-300 text-gray-700' : 'bg-red-100 text-red-500 hover:bg-red-200'}`}>
        {micEnabled ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
      </button>
      <button onClick={toggleCam}
        className={`p-2 rounded-full transition-colors ${camEnabled ? 'bg-gray-200 hover:bg-gray-300 text-gray-700' : 'bg-red-100 text-red-500 hover:bg-red-200'}`}>
        {camEnabled ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
      </button>
      <button onClick={() => setShowBgPanel(!showBgPanel)} title="Background effects"
        className={`flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-medium transition-colors ${bgMode !== 'disabled' ? 'bg-indigo-500/80 text-white' : 'bg-gray-200 hover:bg-gray-300 text-gray-700'}`}>
        <Sparkles className="h-4 w-4" />
        BG
      </button>

      {/* Background effects panel */}
      {showBgPanel && (
        <div className="absolute top-full left-0 mt-2 bg-white rounded-xl shadow-xl border border-gray-200 p-3 w-56 sm:w-72 max-w-[calc(100vw-2rem)] z-50">
          <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Background Effects</p>
          <div className="grid grid-cols-3 gap-2">
            {BG_PRESETS.map(preset => (
              <button key={preset.label}
                onClick={() => { applyBackground(preset.mode, preset.image); if (preset.mode === 'disabled') setBgMode('disabled'); setShowBgPanel(false); }}
                className={`rounded-lg border-2 overflow-hidden transition-all ${
                  (preset.mode === 'disabled' && bgMode === 'disabled') || bgMode.includes(preset.image || '__none__')
                    ? 'border-rsn-red ring-2 ring-rsn-red/30' : 'border-gray-200 hover:border-gray-400'
                }`}>
                {preset.preview ? (
                  <img src={preset.preview} alt={preset.label} className="w-full h-14 object-cover" />
                ) : (
                  <div className={`w-full h-14 flex items-center justify-center text-xs font-medium ${
                    preset.mode === 'disabled' ? 'bg-gray-100 text-gray-500' : 'bg-indigo-50 text-indigo-600'
                  }`}>
                    {preset.label}
                  </div>
                )}
                <p className="text-[10px] text-gray-500 py-0.5 text-center">{preset.label}</p>
              </button>
            ))}
            {/* Custom upload */}
            <button onClick={() => { handleCustomUpload(); }}
              className="rounded-lg border-2 border-dashed border-gray-300 hover:border-gray-400 transition-all">
              <div className="w-full h-14 flex items-center justify-center text-xs font-medium text-gray-400">
                + Upload
              </div>
              <p className="text-[10px] text-gray-400 py-0.5 text-center">Custom</p>
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

function PartnerLeftAutoReturn({ sessionId }: { sessionId: string }) {
  const [countdown, setCountdown] = useState(5);
  useEffect(() => {
    const interval = setInterval(() => setCountdown(c => c - 1), 1000);
    const timer = setTimeout(() => {
      getSocket()?.emit('participant:leave_conversation', { sessionId });
    }, 5000);
    return () => { clearInterval(interval); clearTimeout(timer); };
  }, [sessionId]);
  return (
    <div className="bg-amber-500/10 px-4 py-3 flex items-center justify-center gap-2">
      <UserX className="h-4 w-4 text-amber-400" />
      <p className="text-sm text-amber-400 font-medium">Your partner left the room. Returning to main room in {Math.max(0, countdown)}s</p>
      <button
        onClick={() => getSocket()?.emit('participant:leave_conversation', { sessionId })}
        className="ml-2 px-3 py-1 text-xs font-medium bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 rounded-full transition-colors"
      >
        Return to Main Room
      </button>
    </div>
  );
}

export default function VideoRoom({ isHost = false }: { isHost?: boolean }) {
  const timerSeconds = useSessionStore(s => s.timerSeconds);
  const currentRound = useSessionStore(s => s.currentRound);
  const totalRounds = useSessionStore(s => s.totalRounds);
  const isByeRound = useSessionStore(s => s.isByeRound);
  const liveKitToken = useSessionStore(s => s.liveKitToken);
  const livekitUrl = useSessionStore(s => s.livekitUrl);
  const currentRoomId = useSessionStore(s => s.currentRoomId);
  const timerVisibility = useSessionStore(s => s.timerVisibility);
  const breakoutTimerHidden = useSessionStore(s => s.breakoutTimerHidden);
  const partnerDisconnected = useSessionStore(s => s.partnerDisconnected);
  const { setLiveKitToken } = useSessionStore.getState();
  const [retrying, setRetrying] = useState(false);
  const retryCountRef = useRef(0);
  const { sessionId } = useParams();

  // Backup token fetch if not provided inline
  useEffect(() => {
    if (!liveKitToken && sessionId) {
      api.post(`/sessions/${sessionId}/token`, currentRoomId ? { roomId: currentRoomId } : {}).then(res => {
        const { token, livekitUrl: url } = res.data.data;
        setLiveKitToken(token, url);
        retryCountRef.current = 0;
      }).catch(() => { /* Token fetch failed — VideoRoom will show loading state, user can leave */ });
    }
  }, [liveKitToken, sessionId, currentRoomId]);

  const handleReturnToLobby = () => {
    if (sessionId) getSocket()?.emit('participant:leave_conversation', { sessionId });
  };

  if (isByeRound) {
    return (
      <div className="flex-1 flex items-center justify-center p-4 bg-[#202124]">
        <div className="max-w-md w-full text-center bg-[#292a2d] rounded-2xl p-8">
          <div className="h-20 w-20 rounded-full bg-[#3c4043] flex items-center justify-center mx-auto mb-4">
            <Video className="h-8 w-8 text-gray-400" />
          </div>
          <h3 className="text-lg font-semibold text-white mb-2">Sitting this one out</h3>
          <p className="text-gray-400 text-sm">
            You'll be matched in the next round
          </p>
          <p className="text-gray-500 text-xs mt-3">Round {currentRound} of {totalRounds}</p>
        </div>
      </div>
    );
  }

  if (!liveKitToken || !livekitUrl || retrying) {
    return (
      <div className="flex-1 flex items-center justify-center p-4 bg-[#202124]">
        <div className="max-w-md w-full text-center bg-[#292a2d] rounded-2xl p-8">
          <div className="h-16 w-16 rounded-full bg-[#3c4043] flex items-center justify-center mx-auto mb-4 animate-pulse">
            <Video className="h-6 w-6 text-gray-400" />
          </div>
          <p className="text-gray-400 text-sm">{retrying ? 'Reconnecting...' : 'Joining room...'}</p>
          <button
            onClick={handleReturnToLobby}
            className="mt-4 text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            Return to Main Room
          </button>
        </div>
      </div>
    );
  }

  return (
    <LiveKitRoom
      token={liveKitToken}
      serverUrl={livekitUrl}
      connect={true}
      video={true}
      audio={true}
      options={{
        videoCaptureDefaults: { resolution: { width: 1280, height: 720, frameRate: 30 } },
      }}
      onDisconnected={() => {
        if (useSessionStore.getState().phase !== 'matched') return;
        setTimeout(() => {
          if (useSessionStore.getState().phase !== 'matched') return;
          if (retryCountRef.current < 2) {
            retryCountRef.current++;
            setRetrying(true);
            setLiveKitToken(null, null);
            setTimeout(() => setRetrying(false), 2000);
          } else {
            handleReturnToLobby();
          }
        }, 2000);
      }}
      onError={() => {
        if (useSessionStore.getState().phase !== 'matched') return;
        setTimeout(() => {
          if (useSessionStore.getState().phase !== 'matched') return;
          if (retryCountRef.current < 2) {
            retryCountRef.current++;
            setRetrying(true);
            setLiveKitToken(null, null);
            setTimeout(() => setRetrying(false), 2000);
          } else {
            handleReturnToLobby();
          }
        }, 2000);
      }}
      className="flex-1 flex flex-col"
    >
      {/* Partner disconnected — auto-return to main room */}
      {partnerDisconnected && sessionId && (
        <PartnerLeftAutoReturn sessionId={sessionId} />
      )}

      <div className="flex-1 flex flex-col p-4 gap-4 bg-[#202124] overflow-auto min-h-0 relative">
        {/* Timer bar — responsive: stacks on mobile */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 bg-[#292a2d] rounded-xl px-3 py-2 sm:px-4 sm:py-3">
          <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
            <span className="text-xs sm:text-sm text-white font-medium">Breakout Room</span>
            {currentRound > 0 && (
              <span className="text-xs sm:text-sm text-gray-400">Round {currentRound}/{totalRounds}</span>
            )}
            <ConnectionIndicator />
            <MediaControls />
          </div>
          {!isHost && (
            <div className="flex items-center gap-1 sm:gap-2">
              <button
                onClick={() => {
                  if (confirm('Return to the main room? Your conversation will end.')) {
                    if (sessionId) getSocket()?.emit('participant:leave_conversation', { sessionId });
                  }
                }}
                className="flex items-center gap-1 px-2 py-1 text-[10px] sm:text-xs text-gray-400 hover:text-amber-400 hover:bg-white/5 rounded-lg transition-colors"
                title="Return to the main room"
              >
                <ArrowLeft className="h-3 w-3" /> Main Room
              </button>
              <button
                onClick={() => {
                  if (confirm('Leave this event entirely? You will not be able to rejoin.')) {
                    if (sessionId) getSocket()?.emit('session:leave', { sessionId });
                    disconnectSocket();
                    useSessionStore.getState().reset();
                    window.location.href = '/sessions';
                  }
                }}
                className="flex items-center gap-1 px-2 py-1 text-[10px] sm:text-xs text-gray-400 hover:text-red-400 hover:bg-white/5 rounded-lg transition-colors"
              >
                <ArrowLeft className="h-3 w-3" /> Leave
              </button>
            </div>
          )}
          {(() => {
            // No timer if value is NaN/0 (e.g. host-created room without duration)
            if (!timerSeconds || isNaN(timerSeconds)) return null;
            // Task 14: per-room bulk breakout visibility override. Host always sees.
            if (breakoutTimerHidden && !isHost) return null;
            // Host always sees the timer regardless of visibility setting
            const showTimer = isHost ||
              timerVisibility === 'always_visible' ||
              (timerVisibility === 'last_10s' && timerSeconds <= 10) ||
              (timerVisibility === 'last_30s' && timerSeconds <= 30) ||
              (timerVisibility === 'last_60s' && timerSeconds <= 60) ||
              (timerVisibility === 'last_120s' && timerSeconds <= 120);
            if (timerVisibility === 'hidden' && !isHost) return null;
            if (!showTimer) return (
              <div className="flex items-center gap-2 text-gray-500">
                <Clock className="h-4 w-4" />
                <span className="text-sm">Timer hidden until final stretch</span>
              </div>
            );
            return (
              <div className="flex items-center gap-2 text-gray-300">
                <Clock className="h-4 w-4" />
                <span className={`font-mono text-lg ${timerSeconds <= 30 ? 'text-amber-400' : ''} ${timerSeconds <= 10 ? 'text-red-400 animate-pulse' : ''}`}>
                  {formatTime(timerSeconds)}
                </span>
                {timerSeconds <= 10 && timerSeconds > 0 && (
                  <span className="text-xs text-red-400 ml-1">Ending soon</span>
                )}
              </div>
            );
          })()}
        </div>

        {/* Video area */}
        <VideoStage />
      </div>
      <RoomAudioRenderer />
    </LiveKitRoom>
  );
}
