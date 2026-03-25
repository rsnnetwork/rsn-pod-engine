import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useSessionStore } from '@/stores/sessionStore';
import { formatTime } from '@/lib/utils';
import { Video, Clock, Mic, MicOff, VideoOff, Wifi, UserX, Loader2, ArrowLeft, Sparkles } from 'lucide-react';
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

function ConnectionIndicator() {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20">
      <Wifi className="h-3 w-3 text-emerald-400" />
      <span className="text-xs text-emerald-400">Connected</span>
    </div>
  );
}

function VideoTile({ trackRef, label, isWaiting }: { trackRef?: any; label: string; isWaiting?: boolean }) {
  const hasVideo = trackRef?.publication?.track;
  return (
    <div className="relative rounded-xl overflow-hidden bg-[#3c4043] aspect-video flex items-center justify-center">
      {hasVideo ? (
        <VideoTrack trackRef={trackRef} className="h-full w-full object-cover" />
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
      <div className="absolute bottom-2 left-2 bg-black/60 rounded px-2 py-1 text-xs text-white">
        {label}
      </div>
    </div>
  );
}

function VideoStage() {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.Microphone, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );
  useParticipants(); // Keep subscribed for LiveKit track updates
  const { localParticipant } = useLocalParticipant();
  const { currentPartners } = useSessionStore();
  const [pinnedSid, setPinnedSid] = useState<string | null>(null);

  const cameraTracks = tracks.filter(t => t.source === Track.Source.Camera);
  const localTrack = cameraTracks.find(t => t.participant.sid === localParticipant.sid);
  const remoteTracks = cameraTracks.filter(t => t.participant.sid !== localParticipant.sid);

  const allTiles = [
    { trackRef: localTrack, label: 'You', sid: localParticipant.sid },
    ...remoteTracks.map((rt, i) => ({
      trackRef: rt,
      label: rt.participant.name || currentPartners[i]?.displayName || 'Partner',
      sid: rt.participant.sid,
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
      <div className="flex-1 flex flex-col gap-3 max-h-[calc(100vh-200px)]">
        {/* Pinned tile — large */}
        <div className="flex-1 min-h-0 cursor-pointer" onClick={() => setPinnedSid(null)}>
          <div className="relative h-full">
            <VideoTile trackRef={pinnedTile.trackRef} label={pinnedTile.label} />
            <div className="absolute top-2 right-2 bg-black/60 text-white text-[10px] px-2 py-0.5 rounded-full">
              Pinned · click to unpin
            </div>
          </div>
        </div>
        {/* Unpinned tiles — small row */}
        <div className="flex gap-3 h-28 shrink-0">
          {unpinnedTiles.map(t => (
            <div key={t.sid} className="flex-1 cursor-pointer" onClick={() => setPinnedSid(t.sid)}>
              <VideoTile trackRef={t.trackRef} label={t.label} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={`flex-1 grid ${gridClass} gap-4 max-h-[calc(100vh-200px)]`}>
      {remoteTracks.length > 0 ? (
        allTiles.map(t => (
          <div key={t.sid} className="cursor-pointer" onClick={() => setPinnedSid(t.sid)}>
            <VideoTile trackRef={t.trackRef} label={t.label} />
          </div>
        ))
      ) : (
        <>
          <VideoTile trackRef={localTrack} label="You" />
          {currentPartners.map((p, i) => (
            <VideoTile key={p.userId || i} label={p.displayName || 'Partner'} isWaiting />
          ))}
        </>
      )}
    </div>
  );
}

function MediaControls() {
  const { localParticipant } = useLocalParticipant();
  const [micEnabled, setMicEnabled] = useState(true);
  const [camEnabled, setCamEnabled] = useState(true);
  const [bgBlur, setBgBlur] = useState(false);

  const toggleMic = useCallback(async () => {
    await localParticipant.setMicrophoneEnabled(!micEnabled);
    setMicEnabled(!micEnabled);
  }, [localParticipant, micEnabled]);

  const toggleCam = useCallback(async () => {
    await localParticipant.setCameraEnabled(!camEnabled);
    setCamEnabled(!camEnabled);
  }, [localParticipant, camEnabled]);

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={toggleMic}
        className={`p-2 rounded-full transition-colors ${micEnabled ? 'bg-[#3c4043] hover:bg-[#4a4e51] text-white' : 'bg-red-500/20 text-red-400 hover:bg-red-500/30'}`}
      >
        {micEnabled ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
      </button>
      <button
        onClick={toggleCam}
        className={`p-2 rounded-full transition-colors ${camEnabled ? 'bg-[#3c4043] hover:bg-[#4a4e51] text-white' : 'bg-red-500/20 text-red-400 hover:bg-red-500/30'}`}
      >
        {camEnabled ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
      </button>
      <button
        onClick={async () => {
          try {
            // @ts-ignore — dynamic import, package may not be installed
            const mod = await import('@livekit/track-processors');
            const camPub = localParticipant.getTrackPublicationByName?.('camera') || Array.from(localParticipant.trackPublications.values()).find(p => p.source === 'camera');
            const camTrack = camPub?.track;
            if (!camTrack) return;
            if (bgBlur) {
              await (camTrack as any).stopProcessor();
              setBgBlur(false);
            } else {
              await (camTrack as any).setProcessor(mod.BackgroundBlur(10));
              setBgBlur(true);
            }
          } catch {
            // @livekit/track-processors not installed — silently ignore
          }
        }}
        title="Background blur"
        className={`p-2 rounded-full transition-colors ${bgBlur ? 'bg-indigo-500/20 text-indigo-400' : 'bg-[#3c4043] hover:bg-[#4a4e51] text-white'}`}
      >
        <Sparkles className="h-5 w-5" />
      </button>
    </div>
  );
}

export default function VideoRoom({ isHost = false }: { isHost?: boolean }) {
  const { timerSeconds, currentRound, totalRounds, isByeRound, liveKitToken, livekitUrl, currentRoomId, transitionStatus, timerVisibility, partnerDisconnected } = useSessionStore();
  const { setLiveKitToken } = useSessionStore();
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const retryCountRef = useRef(0);
  const { sessionId } = useParams();
  useEffect(() => {
    if (!liveKitToken && sessionId) {
      api.post(`/sessions/${sessionId}/token`, currentRoomId ? { roomId: currentRoomId } : {}).then(res => {
        const { token, livekitUrl: url } = res.data.data;
        setLiveKitToken(token, url);
        retryCountRef.current = 0;
      }).catch(() => setConnectionError('Failed to get video room access'));
    }
  }, [liveKitToken, sessionId]);

  if (isByeRound) {
    return (
      <div className="flex-1 flex items-center justify-center p-4 bg-[#202124]">
        <div className="max-w-md w-full text-center bg-[#292a2d] rounded-2xl p-8">
          <div className="h-20 w-20 rounded-full bg-[#3c4043] flex items-center justify-center mx-auto mb-4">
            <Video className="h-8 w-8 text-gray-400" />
          </div>
          <h3 className="text-lg font-semibold text-white mb-2">Bye Round</h3>
          <p className="text-gray-400 text-sm">
            You have a bye this round — sit tight, you'll be matched in the next round!
          </p>
          <p className="text-gray-500 text-xs mt-3">Round {currentRound} of {totalRounds}</p>
        </div>
      </div>
    );
  }

  if (connectionError) {
    return (
      <div className="flex-1 flex items-center justify-center p-4 bg-[#202124]">
        <div className="max-w-md w-full text-center bg-[#292a2d] rounded-2xl p-8">
          <div className="h-20 w-20 rounded-full bg-red-500/20 flex items-center justify-center mx-auto mb-4">
            <VideoOff className="h-8 w-8 text-red-400" />
          </div>
          <h3 className="text-lg font-semibold text-white mb-2">Video Error</h3>
          <p className="text-gray-400 text-sm mb-3">{connectionError}</p>
          <button
            onClick={() => { setConnectionError(null); setLiveKitToken('', ''); }}
            className="text-sm text-blue-400 hover:text-blue-300 underline"
          >Retry</button>
        </div>
      </div>
    );
  }

  if (!liveKitToken || !livekitUrl) {
    return (
      <div className="flex-1 flex items-center justify-center p-4 bg-[#202124]">
        <div className="max-w-md w-full text-center bg-[#292a2d] rounded-2xl p-8">
          <div className="h-16 w-16 rounded-full bg-[#3c4043] flex items-center justify-center mx-auto mb-4 animate-pulse">
            <Video className="h-6 w-6 text-gray-400" />
          </div>
          <p className="text-gray-400 text-sm">Connecting to video room — please wait...</p>
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
        // Ignore disconnect during normal round transitions (server closes the room)
        if (useSessionStore.getState().phase !== 'matched') return;
        setTimeout(() => {
          if (useSessionStore.getState().phase !== 'matched') return;
          // Auto-retry once before showing error
          if (retryCountRef.current < 1) {
            retryCountRef.current++;
            setLiveKitToken(null, null);
          } else {
            setConnectionError('Video connection interrupted — try refreshing if the issue persists');
          }
        }, 3000);
      }}
      onError={(err) => {
        if (useSessionStore.getState().phase !== 'matched') return;
        setTimeout(() => {
          if (useSessionStore.getState().phase !== 'matched') return;
          // Auto-retry once before showing error
          if (retryCountRef.current < 1) {
            retryCountRef.current++;
            setLiveKitToken(null, null);
          } else {
            setConnectionError(err?.message || 'Video connection error');
          }
        }, 3000);
      }}
      className="flex-1 flex flex-col"
    >
      {/* Connecting to partner overlay */}
      {transitionStatus === 'preparing_match' && (
        <div className="bg-white/5 px-4 py-2 flex items-center justify-center gap-2">
          <div className="h-4 w-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-300">Connecting to your partner...</p>
        </div>
      )}

      {/* Partner disconnected overlay */}
      {partnerDisconnected && (
        <div className="bg-amber-500/10 px-4 py-3 flex items-center justify-center gap-2">
          <UserX className="h-4 w-4 text-amber-400" />
          <p className="text-sm text-amber-400 font-medium">Your partner left the room.</p>
          <button
            onClick={() => { if (sessionId) getSocket()?.emit('participant:leave_conversation', { sessionId }); }}
            className="ml-2 px-3 py-1 text-xs font-medium bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 rounded-full transition-colors"
          >
            Back to Lobby
          </button>
          <Loader2 className="h-4 w-4 text-amber-400 animate-spin" />
        </div>
      )}

      <div className="flex-1 flex flex-col p-4 gap-4 bg-[#202124] overflow-auto min-h-0">
        {/* Timer bar */}
        <div className="flex items-center justify-between bg-[#292a2d] rounded-xl px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-400">Round {currentRound} of {totalRounds}</span>
            <ConnectionIndicator />
            <MediaControls />
            {!isHost && (
              <>
                <button
                  onClick={() => {
                    if (confirm('Return to the lobby? Your round will continue for your partner.')) {
                      if (sessionId) getSocket()?.emit('participant:leave_conversation', { sessionId });
                    }
                  }}
                  className="flex items-center gap-1 px-2.5 py-1 text-xs text-gray-400 hover:text-amber-400 hover:bg-white/5 rounded-lg transition-colors"
                  title="You can return to the lobby at any time"
                >
                  <ArrowLeft className="h-3 w-3" /> Return to Lobby
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
                  className="flex items-center gap-1 px-2.5 py-1 text-xs text-gray-400 hover:text-red-400 hover:bg-white/5 rounded-lg transition-colors"
                >
                  <ArrowLeft className="h-3 w-3" /> Leave Event
                </button>
              </>
            )}
          </div>
          {(() => {
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
