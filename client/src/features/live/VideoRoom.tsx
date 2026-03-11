import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useSessionStore } from '@/stores/sessionStore';
import Card from '@/components/ui/Card';
import { formatTime } from '@/lib/utils';
import { Video, Clock, Mic, MicOff, VideoOff, Wifi } from 'lucide-react';
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

function VideoStage() {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.Microphone, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );
  const participants = useParticipants();
  const { localParticipant } = useLocalParticipant();

  const cameraTracks = tracks.filter(t => t.source === Track.Source.Camera);
  const localTrack = cameraTracks.find(t => t.participant.sid === localParticipant.sid);
  const remoteTrack = cameraTracks.find(t => t.participant.sid !== localParticipant.sid);

  return (
    <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* Local video */}
      <div className="relative rounded-xl overflow-hidden bg-gray-50 min-h-[300px] flex items-center justify-center border border-gray-200">
        {localTrack?.publication?.track ? (
          <VideoTrack trackRef={localTrack} className="h-full w-full object-cover" />
        ) : (
          <div className="flex flex-col items-center gap-2">
            <div className="h-20 w-20 rounded-full bg-gray-100 flex items-center justify-center">
              <Video className="h-8 w-8 text-gray-400" />
            </div>
            <p className="text-gray-500 text-sm">Camera off</p>
          </div>
        )}
        <div className="absolute bottom-2 left-2 bg-black/60 rounded px-2 py-1 text-xs text-white">
          You
        </div>
      </div>

      {/* Remote video */}
      <div className="relative rounded-xl overflow-hidden bg-gray-50 min-h-[300px] flex items-center justify-center border border-gray-200">
        {remoteTrack?.publication?.track ? (
          <VideoTrack trackRef={remoteTrack} className="h-full w-full object-cover" />
        ) : (
          <div className="flex flex-col items-center gap-2">
            <div className="h-20 w-20 rounded-full bg-gray-100 flex items-center justify-center animate-pulse">
              <Video className="h-8 w-8 text-gray-300" />
            </div>
            <p className="text-gray-400 text-sm">
              {participants.length < 2 ? 'Waiting for partner...' : 'Partner camera off'}
            </p>
          </div>
        )}
        {participants.length >= 2 && (
          <div className="absolute bottom-2 left-2 bg-black/60 rounded px-2 py-1 text-xs text-white">
            Partner
          </div>
        )}
      </div>
    </div>
  );
}

function MediaControls() {
  const { localParticipant } = useLocalParticipant();
  const [micEnabled, setMicEnabled] = useState(true);
  const [camEnabled, setCamEnabled] = useState(true);

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
        className={`p-2 rounded-full transition-colors ${micEnabled ? 'bg-gray-200 hover:bg-surface-600 text-gray-800' : 'bg-red-500/20 text-red-400 hover:bg-red-500/30'}`}
      >
        {micEnabled ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
      </button>
      <button
        onClick={toggleCam}
        className={`p-2 rounded-full transition-colors ${camEnabled ? 'bg-gray-200 hover:bg-surface-600 text-gray-800' : 'bg-red-500/20 text-red-400 hover:bg-red-500/30'}`}
      >
        {camEnabled ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
      </button>
    </div>
  );
}

export default function VideoRoom() {
  const { timerSeconds, currentRound, totalRounds, isByeRound, liveKitToken, livekitUrl, currentRoomId, transitionStatus } = useSessionStore();
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
      <div className="flex-1 flex items-center justify-center p-4">
        <Card className="max-w-md w-full text-center">
          <div className="h-20 w-20 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-4">
            <Video className="h-8 w-8 text-gray-400" />
          </div>
          <h3 className="text-lg font-semibold text-gray-800 mb-2">Bye Round</h3>
          <p className="text-gray-500 text-sm">
            You have a bye this round — sit tight, you'll be matched in the next round!
          </p>
          <p className="text-gray-400 text-xs mt-3">Round {currentRound} of {totalRounds}</p>
        </Card>
      </div>
    );
  }

  if (connectionError) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <Card className="max-w-md w-full text-center">
          <div className="h-20 w-20 rounded-full bg-red-500/20 flex items-center justify-center mx-auto mb-4">
            <VideoOff className="h-8 w-8 text-red-400" />
          </div>
          <h3 className="text-lg font-semibold text-gray-800 mb-2">Video Error</h3>
          <p className="text-gray-500 text-sm mb-3">{connectionError}</p>
          <button
            onClick={() => { setConnectionError(null); setLiveKitToken('', ''); }}
            className="text-sm text-indigo-600 hover:text-brand-300 underline"
          >Retry</button>
        </Card>
      </div>
    );
  }

  if (!liveKitToken || !livekitUrl) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <Card className="max-w-md w-full text-center">
          <div className="h-16 w-16 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-4 animate-pulse">
            <Video className="h-6 w-6 text-gray-400" />
          </div>
          <p className="text-gray-500 text-sm">Connecting to video room — please wait...</p>
        </Card>
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
        <div className="bg-[#1a1a2e]/10 border-b border-brand-500/20 px-4 py-2 flex items-center justify-center gap-2">
          <div className="h-4 w-4 border-2 border-brand-400 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-brand-300">Connecting to your partner...</p>
        </div>
      )}

      <div className="flex-1 flex flex-col p-4 gap-4">
        {/* Timer bar */}
        <div className="flex items-center justify-between bg-gray-50/60 rounded-xl px-4 py-3 border border-gray-200">
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500">Round {currentRound} of {totalRounds}</span>
            <ConnectionIndicator />
            <MediaControls />
          </div>
          <div className="flex items-center gap-2 text-gray-800">
            <Clock className="h-4 w-4" />
            <span className={`font-mono text-lg ${timerSeconds <= 30 ? 'text-amber-400' : ''} ${timerSeconds <= 10 ? 'text-red-400 animate-pulse' : ''}`}>
              {formatTime(timerSeconds)}
            </span>
            {timerSeconds <= 10 && timerSeconds > 0 && (
              <span className="text-xs text-red-400 ml-1">Ending soon</span>
            )}
          </div>
        </div>

        {/* Video area */}
        <VideoStage />
      </div>
      <RoomAudioRenderer />
    </LiveKitRoom>
  );
}
