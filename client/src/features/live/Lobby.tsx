import { Users, Loader2, VideoOff, Sparkles, ChevronDown, ChevronUp, Mic, MicOff, Volume2, VolumeX, UserX, Clock, Camera } from 'lucide-react';
import HostRoundDashboard from './HostRoundDashboard';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { getSocket } from '@/lib/socket';
import {
  LiveKitRoom,
  VideoTrack,
  useTracks,
  useParticipants,
  useLocalParticipant,
  RoomAudioRenderer,
} from '@livekit/components-react';
import { isTrackReference } from '@livekit/components-core';
import '@livekit/components-styles';
import { Track } from 'livekit-client';

function LobbyMosaic({ isHost, sessionId }: { isHost: boolean; sessionId?: string }) {
  const tracks = useTracks(
    [{ source: Track.Source.Camera, withPlaceholder: true }],
    { onlySubscribed: false },
  );
  const participants = useParticipants();
  const { localParticipant } = useLocalParticipant();
  const hostUserId = useSessionStore(s => s.hostUserId);
  const lobbyDensity = useSessionStore(s => s.lobbyDensity);
  const cameraTracksRaw = tracks.filter(t => t.source === Track.Source.Camera);

  // Sort: host (local) tile always first in the grid
  const cameraTracks = [...cameraTracksRaw].sort((a, b) => {
    const aIsLocal = a.participant.sid === localParticipant.sid ? 0 : 1;
    const bIsLocal = b.participant.sid === localParticipant.sid ? 0 : 1;
    return aIsLocal - bIsLocal;
  });

  // Responsive grid based on density preference
  const n = participants.length;
  const gridCols = lobbyDensity === 'compact'
    ? (n <= 4 ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-3 sm:grid-cols-4 lg:grid-cols-6')
    : lobbyDensity === 'spacious'
    ? (n <= 2 ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2')
    : // normal (default)
      n <= 2 ? 'grid-cols-1 sm:grid-cols-2'
      : n <= 4 ? 'grid-cols-2 sm:grid-cols-2'
      : n <= 9 ? 'grid-cols-2 sm:grid-cols-3'
      : 'grid-cols-3 sm:grid-cols-4 lg:grid-cols-5';
  const gapClass = lobbyDensity === 'compact' ? 'gap-2' : lobbyDensity === 'spacious' ? 'gap-6' : 'gap-3';
  const maxWClass = lobbyDensity === 'compact' ? 'max-w-5xl' : lobbyDensity === 'spacious' ? 'max-w-2xl' : 'max-w-4xl';

  const handleHostMute = useCallback((targetIdentity: string, mute: boolean) => {
    if (!sessionId) return;
    const socket = getSocket();
    socket?.emit('host:mute_participant', { sessionId, targetUserId: targetIdentity, muted: mute });
  }, [sessionId]);

  const handleKick = useCallback((targetIdentity: string, targetName: string) => {
    if (!sessionId) return;
    if (!window.confirm(`Remove ${targetName} from this event?`)) return;
    const socket = getSocket();
    socket?.emit('host:remove_participant', { sessionId, userId: targetIdentity, reason: 'Removed by host' });
  }, [sessionId]);

  return (
    <div className={`grid ${gridCols} ${gapClass} w-full ${maxWClass} mx-auto`}>
      {cameraTracks.map(trackRef => {
        const name = trackRef.participant.name || trackRef.participant.identity || 'User';
        const hasVideo = !!trackRef.publication?.track;
        const isLocal = trackRef.participant.sid === localParticipant.sid;
        const isMicOn = trackRef.participant.isMicrophoneEnabled;
        return (
          <div key={trackRef.participant.sid} className="relative rounded-xl overflow-hidden bg-[#3c4043] aspect-video flex items-center justify-center group">
            {hasVideo && isTrackReference(trackRef) ? (
              <VideoTrack trackRef={trackRef} className="h-full w-full object-cover" />
            ) : (
              <div className="flex flex-col items-center gap-2">
                <div className="h-14 w-14 rounded-full bg-[#5f6368] flex items-center justify-center text-white font-semibold text-xl">
                  {name.charAt(0).toUpperCase()}
                </div>
              </div>
            )}
            <div className="absolute bottom-2 left-2 bg-black/60 backdrop-blur-sm rounded px-2 py-0.5 text-[11px] text-white truncate max-w-[90%] flex items-center gap-1.5">
              {name}
              {trackRef.participant.identity === hostUserId && (
                <span className="text-[9px] font-medium text-gray-300 ml-0.5">(Host)</span>
              )}
            </div>
            {/* Own media controls on local (host) tile */}
            {isLocal && (
              <div className="absolute bottom-1.5 right-1.5">
                <LobbyMediaControls isHost={isHost} sessionId={sessionId} />
              </div>
            )}
            {/* Host mute/unmute + kick buttons on remote participant tiles */}
            {isHost && !isLocal && (
              <div className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => handleHostMute(trackRef.participant.identity, !!isMicOn)}
                  className="bg-black/50 backdrop-blur-sm rounded-full p-1.5 text-white hover:bg-black/70"
                  title={isMicOn ? `Mute ${name}` : `Unmute ${name}`}
                >
                  {isMicOn ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5 text-red-400" />}
                </button>
                <button
                  onClick={() => handleKick(trackRef.participant.identity, name)}
                  className="bg-black/50 backdrop-blur-sm rounded-full p-1.5 text-white hover:bg-red-600/70"
                  title={`Remove ${name}`}
                >
                  <UserX className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            {/* Mic status indicator */}
            {!isMicOn && (
              <div className="absolute top-2 left-2 bg-red-500/90 rounded-full p-1">
                <MicOff className="h-2.5 w-2.5 text-white" />
              </div>
            )}
          </div>
        );
      })}
      {cameraTracks.length === 0 && (
        <div className="col-span-full text-center py-12 text-gray-500 text-sm">
          <div className="h-16 w-16 rounded-full bg-[#3c4043] flex items-center justify-center mx-auto mb-3">
            <VideoOff className="h-6 w-6 text-gray-400" />
          </div>
          Waiting for participants to enable cameras...
        </div>
      )}
    </div>
  );
}

function LobbyMediaControls({ isHost, sessionId }: { isHost: boolean; sessionId?: string }) {
  const { localParticipant } = useLocalParticipant();
  const { hostMuteCommand, setHostMuteCommand } = useSessionStore();
  const [micEnabled, setMicEnabled] = useState(isHost); // Host unmuted by default, others muted
  const [allMuted, setAllMuted] = useState(false);

  // Auto-mute participants (not host) on mount
  useEffect(() => {
    if (!isHost) {
      localParticipant.setMicrophoneEnabled(false);
      setMicEnabled(false);
    }
  }, [isHost, localParticipant]);

  // Respond to host mute/unmute commands
  useEffect(() => {
    if (hostMuteCommand !== null && !isHost) {
      localParticipant.setMicrophoneEnabled(!hostMuteCommand);
      setMicEnabled(!hostMuteCommand);
      setHostMuteCommand(null); // Clear the command after processing
    }
  }, [hostMuteCommand, isHost, localParticipant, setHostMuteCommand]);

  const toggleMic = useCallback(async () => {
    await localParticipant.setMicrophoneEnabled(!micEnabled);
    setMicEnabled(!micEnabled);
  }, [localParticipant, micEnabled]);

  const handleMuteAll = useCallback(() => {
    if (!sessionId) return;
    const socket = getSocket();
    const newMuted = !allMuted;
    socket?.emit('host:mute_all', { sessionId, muted: newMuted });
    setAllMuted(newMuted);
  }, [sessionId, allMuted]);

  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={toggleMic}
        className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-medium transition-colors backdrop-blur-sm ${
          micEnabled
            ? 'bg-black/40 text-white hover:bg-black/60'
            : 'bg-red-500/80 text-white hover:bg-red-600/80'
        }`}
      >
        {micEnabled ? <Mic className="h-3 w-3" /> : <MicOff className="h-3 w-3" />}
        {micEnabled ? 'Mute' : 'Unmute'}
      </button>
      {isHost && sessionId && (
        <button
          onClick={handleMuteAll}
          className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-medium transition-colors backdrop-blur-sm ${
            allMuted
              ? 'bg-red-500/80 text-white hover:bg-red-600/80'
              : 'bg-black/40 text-white hover:bg-black/60'
          }`}
        >
          {allMuted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}
          {allMuted ? 'Unmute All' : 'Mute All'}
        </button>
      )}
    </div>
  );
}

/**
 * Hook: delays "host is offline" by a grace period to avoid flickering on brief disconnects.
 * Also checks participant list as a fallback.
 * - Starts as `null` (unknown) until session:state arrives
 * - First signal: shows the real value immediately (no grace period)
 * - Subsequent online→offline transitions: 5s grace period to absorb blips
 */
function useHostPresence(gracePeriodMs = 5000): boolean | null {
  const rawHostInLobby = useSessionStore(s => s.hostInLobby);
  const participants = useSessionStore(s => s.participants);
  const hostUserId = useSessionStore(s => s.hostUserId);

  const hostInParticipants = hostUserId ? participants.some(p => p.userId === hostUserId) : false;
  const isHostOnline = rawHostInLobby || hostInParticipants;

  const [debouncedOnline, setDebouncedOnline] = useState<boolean | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasEverOnline = useRef(false);

  useEffect(() => {
    if (!hostUserId) return;

    if (isHostOnline) {
      wasEverOnline.current = true;
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      setDebouncedOnline(true);
    } else {
      if (wasEverOnline.current) {
        // Host was online, now offline — apply grace period for brief disconnects
        timerRef.current = setTimeout(() => {
          setDebouncedOnline(false);
          timerRef.current = null;
        }, gracePeriodMs);
      } else {
        // Host was never online — show offline immediately, no grace period
        setDebouncedOnline(false);
      }
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isHostOnline, hostUserId, gracePeriodMs]);

  return debouncedOnline;
}

function LobbyStatusOverlay({ isHost }: { isHost: boolean }) {
  const { participants, isByeRound, currentRound, totalRounds, transitionStatus, sessionStatus, hostUserId } = useSessionStore();
  const hostOnline = useHostPresence();

  // Session hasn't been started yet by host
  const isScheduled = sessionStatus === 'scheduled';

  return (
    <div className="text-center space-y-3">
      {sessionStatus === 'closing_lobby' ? (
        <div className="flex flex-col items-center gap-3">
          <div className="inline-flex items-center justify-center h-14 w-14 rounded-full bg-emerald-500/20 text-emerald-400">
            <Sparkles className="h-7 w-7" />
          </div>
          <h2 className="text-xl font-bold text-white">All Rounds Complete!</h2>
          <p className="text-gray-400 text-sm max-w-xs">Take a moment to say your goodbyes. The host will end the event shortly.</p>
        </div>
      ) : isByeRound ? (
        <>
          <h2 className="text-xl font-bold text-white">Bye Round</h2>
          <p className="text-gray-400 text-sm">Odd one out this round — you'll be matched in the next round!</p>
          <p className="text-xs text-gray-500 mt-1">The round timer is still running. Hang tight.</p>
        </>
      ) : transitionStatus === 'session_ending' ? (
        <div className="flex flex-col items-center gap-2">
          <Loader2 className="h-5 w-5 text-gray-400 animate-spin" />
          <p className="text-gray-300 text-sm font-medium">Event complete — preparing your recap...</p>
        </div>
      ) : transitionStatus === 'between_rounds' ? (
        <div className="flex flex-col items-center gap-2">
          <Loader2 className="h-5 w-5 text-gray-400 animate-spin" />
          <h2 className="text-xl font-bold text-white">Getting Ready</h2>
          <p className="text-gray-400 text-sm">Preparing round {(currentRound || 0) + 1} of {totalRounds}...</p>
        </div>
      ) : transitionStatus === 'starting_session' ? (
        <div className="flex flex-col items-center gap-2">
          <Loader2 className="h-5 w-5 text-gray-400 animate-spin" />
          <h2 className="text-xl font-bold text-white">Event Starting</h2>
          <p className="text-gray-400 text-sm">
            {isHost ? 'Main room is open — use Match People below when ready.' : 'Waiting for the host to begin matching...'}
          </p>
        </div>
      ) : (sessionStatus === 'round_active' || sessionStatus === 'round_rating') ? (
        <div className="flex flex-col items-center gap-2">
          <Loader2 className="h-5 w-5 text-gray-400 animate-spin" />
          <h2 className="text-xl font-bold text-white">Round in Progress</h2>
          <p className="text-gray-400 text-sm">
            {isHost ? 'Monitoring breakout rooms...' : 'You have a bye this round — hang tight!'}
          </p>
        </div>
      ) : isScheduled ? (
        <>
          <div className="inline-flex items-center justify-center h-12 w-12 rounded-full bg-white/10 text-gray-300 mx-auto">
            <Sparkles className="h-6 w-6" />
          </div>
          <h2 className="text-xl font-bold text-white">Waiting Room</h2>
          <p className="text-gray-400 text-sm">
            {isHost
              ? 'You\'re the host — click Start Event below when everyone is ready'
              : hostOnline
                ? 'The host is here! They\'ll start the event shortly.'
                : 'Waiting for the host to join and start the event...'}
          </p>
        </>
      ) : (
        <>
          <div className="inline-flex items-center justify-center h-12 w-12 rounded-full bg-white/10 text-gray-300 mx-auto">
            <Sparkles className="h-6 w-6" />
          </div>
          <h2 className="text-xl font-bold text-white">Main Room</h2>
          <p className="text-gray-400 text-sm">
            {isHost
              ? 'You\'re the host — click Match People below when ready'
              : hostOnline
                ? 'You\'re in the main room — waiting for the host to begin matching...'
                : 'You\'re in the main room — waiting for the host to reconnect...'}
          </p>
          {!isHost && !hostOnline && (
            <div className="inline-flex items-center gap-1.5 text-xs text-amber-400 bg-amber-500/10 px-3 py-1 rounded-full">
              <Loader2 className="h-3 w-3 animate-spin" />
              Host is offline
            </div>
          )}
        </>
      )}
      <div className="flex items-center justify-center gap-2 text-gray-500 text-xs">
        <Users className="h-3.5 w-3.5" />
        <span>
          {(() => {
            const hostInList = participants.some(p => p.userId === hostUserId);
            const count = participants.length - (hostInList ? 1 : 0);
            return `${count} participant${count !== 1 ? 's' : ''}${hostOnline || hostInList ? ' + host' : ''} connected`;
          })()}
        </span>
      </div>
    </div>
  );
}

function HostParticipantPanel({ sessionId }: { sessionId?: string }) {
  const { participants, hostUserId, cohosts } = useSessionStore();
  const [expanded, setExpanded] = useState(true);

  const handleKick = useCallback((userId: string, displayName: string) => {
    if (!sessionId) return;
    if (!window.confirm(`Remove ${displayName} from this event?`)) return;
    const socket = getSocket();
    socket?.emit('host:remove_participant', { sessionId, userId, reason: 'Removed by host' });
  }, [sessionId]);

  return (
    <div className="w-full max-w-4xl mx-auto bg-[#292a2d] rounded-xl overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-sm font-medium text-gray-300 hover:bg-white/5 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-gray-400" />
          <span>Participants ({participants.filter(p => p.userId !== hostUserId && !cohosts.has(p.userId)).length}) + Host{cohosts.size > 0 ? 's' : ''}</span>
        </div>
        {expanded ? <ChevronUp className="h-4 w-4 text-gray-500" /> : <ChevronDown className="h-4 w-4 text-gray-500" />}
      </button>
      {expanded && (
        <div className="border-t border-white/10 px-4 py-2 max-h-48 overflow-y-auto">
          {participants.length === 0 ? (
            <p className="text-xs text-gray-500 text-center py-3">No participants yet</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
              {participants.map(p => (
                <div key={p.userId} className="flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-white/5 transition-colors group/participant relative">
                  <div className="h-8 w-8 rounded-full bg-[#5f6368] flex items-center justify-center text-white text-xs font-semibold shrink-0">
                    {(p.displayName || 'U').charAt(0).toUpperCase()}
                  </div>
                  <span className="text-sm text-gray-300 truncate">{p.displayName || 'User'}</span>
                  {p.userId === hostUserId && (
                    <span className="text-[9px] text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded-full shrink-0">Host</span>
                  )}
                  {sessionId && p.userId !== hostUserId && (
                    <button
                      onClick={() => handleKick(p.userId, p.displayName || 'User')}
                      className="absolute top-2 right-2 opacity-0 group-hover/participant:opacity-100 transition-opacity text-gray-500 hover:text-red-400 p-1 rounded"
                      title={`Remove ${p.displayName || 'User'}`}
                    >
                      <UserX className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Camera/Mic test — Google Meet style self-preview before joining.
 * Uses raw getUserMedia (no LiveKit room needed).
 */
function DeviceTest() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [micLevel, setMicLevel] = useState(0);
  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);

  useEffect(() => {
    let mounted = true;
    let mediaStream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;

    navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      .then(s => {
        if (!mounted) { s.getTracks().forEach(t => t.stop()); return; }
        mediaStream = s;
        setStream(s);
        if (videoRef.current) videoRef.current.srcObject = s;

        // Set up mic level meter
        audioCtx = new AudioContext();
        const source = audioCtx.createMediaStreamSource(s);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        analyserRef.current = analyser;

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          if (!mounted) return;
          analyser.getByteFrequencyData(dataArray);
          const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
          setMicLevel(Math.min(avg / 128, 1));
          animFrameRef.current = requestAnimationFrame(tick);
        };
        tick();
      })
      .catch(() => {
        if (mounted) setError('Camera or microphone not available');
      });

    return () => {
      mounted = false;
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (audioCtx) audioCtx.close().catch(() => {});
      if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
    };
  }, []);

  const toggleCam = () => {
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (track) { track.enabled = !track.enabled; setCamOn(track.enabled); }
  };

  const toggleMic = () => {
    if (!stream) return;
    const track = stream.getAudioTracks()[0];
    if (track) { track.enabled = !track.enabled; setMicOn(track.enabled); }
  };

  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 py-4">
        <div className="h-32 w-48 rounded-xl bg-[#3c4043] flex items-center justify-center">
          <VideoOff className="h-8 w-8 text-gray-500" />
        </div>
        <p className="text-xs text-gray-500">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 py-4">
      {/* Camera preview */}
      <div className="relative w-56 h-40 rounded-xl overflow-hidden bg-[#3c4043]">
        {camOn ? (
          <video ref={videoRef} autoPlay muted playsInline className="h-full w-full object-cover" style={{ transform: 'scaleX(-1)' }} />
        ) : (
          <div className="h-full w-full flex items-center justify-center">
            <VideoOff className="h-8 w-8 text-gray-500" />
          </div>
        )}
      </div>

      {/* Controls + mic level */}
      <div className="flex items-center gap-3">
        <button onClick={toggleCam} className={`p-2 rounded-full transition-colors ${camOn ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-red-500/80 text-white'}`}>
          {camOn ? <Camera className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
        </button>
        <button onClick={toggleMic} className={`p-2 rounded-full transition-colors ${micOn ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-red-500/80 text-white'}`}>
          {micOn ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
        </button>
        {/* Mic level bar */}
        {micOn && (
          <div className="flex items-center gap-1">
            <div className="w-16 h-1.5 bg-white/10 rounded-full overflow-hidden">
              <div className="h-full bg-green-500 rounded-full transition-all duration-75" style={{ width: `${micLevel * 100}%` }} />
            </div>
          </div>
        )}
      </div>
      <p className="text-[10px] text-gray-500">Test your camera and mic before the event starts</p>
    </div>
  );
}

/**
 * Participant-only waiting room shown before the host starts the event.
 * No video, no lobby controls — just a clean holding screen with participant list.
 */
function PreLobbyWaitingRoom({ isHost = false }: { isHost?: boolean }) {
  const { participants, hostUserId } = useSessionStore();
  const hostOnline = useHostPresence();

  return (
    <div className="flex-1 flex items-center justify-center p-6 bg-[#202124]">
      <div className="max-w-md w-full text-center py-10 px-6 bg-[#292a2d] rounded-2xl">
        <div className="flex flex-col items-center gap-4">
          <div className="inline-flex items-center justify-center h-16 w-16 rounded-full bg-white/10 text-gray-400">
            <Clock className="h-8 w-8" />
          </div>
          <h2 className="text-xl font-bold text-white">Waiting for host to start the event...</h2>
          <p className="text-gray-400 text-sm max-w-xs">
            {hostOnline === true
              ? 'The host is here! The event will begin shortly.'
              : hostOnline === false
              ? 'The host hasn\'t joined yet. Once they start the event, you\'ll enter the main room.'
              : 'Connecting to the event...'}
          </p>
          {hostOnline === true ? (
            <div className="inline-flex items-center gap-1.5 text-xs text-green-400 bg-green-500/10 px-3 py-1.5 rounded-full">
              <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
              Host is online
            </div>
          ) : hostOnline === false ? (
            <div className="inline-flex items-center gap-1.5 text-xs text-gray-500 bg-white/5 px-3 py-1.5 rounded-full">
              <span className="h-2 w-2 rounded-full bg-gray-500" />
              Host is offline
            </div>
          ) : (
            <div className="inline-flex items-center gap-1.5 text-xs text-gray-500 bg-white/5 px-3 py-1.5 rounded-full">
              <span className="h-2 w-2 rounded-full bg-gray-500 animate-pulse" />
              Checking...
            </div>
          )}
        </div>

        {/* Connected participants — host sees names, participants see only count */}
        {participants.length > 0 && (
          <div className="mt-8 pt-6 border-t border-white/10">
            <div className="flex items-center justify-center gap-2 text-gray-500 text-xs mb-3">
              <Users className="h-3.5 w-3.5" />
              <span>
                {(() => {
                  const hostInList = participants.some(p => p.userId === hostUserId);
                  const participantCount = participants.length - (hostInList ? 1 : 0);
                  return `${participantCount} participant${participantCount !== 1 ? 's' : ''}${hostOnline || hostInList ? ' + host' : ''} waiting`;
                })()}
              </span>
            </div>
            {isHost && (
              <div className="flex flex-wrap gap-2 justify-center">
                {participants.map(p => (
                  <span key={p.userId} className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium ${
                    p.userId === hostUserId ? 'bg-amber-500/10 text-amber-400' : 'bg-white/10 text-gray-300'
                  }`}>
                    <span className={`h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                      p.userId === hostUserId ? 'bg-amber-500/20' : 'bg-white/10'
                    }`}>
                      {(p.displayName || 'U').charAt(0).toUpperCase()}
                    </span>
                    {p.displayName || 'User'}
                    {p.userId === hostUserId && <span className="text-[9px] text-amber-400 ml-0.5">(Host)</span>}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Camera/mic test */}
        <div className="mt-6 pt-6 border-t border-white/10">
          <DeviceTest />
        </div>
      </div>
    </div>
  );
}

export default function Lobby({ isHost = false, sessionId }: { isHost?: boolean; sessionId?: string }) {
  const { participants, lobbyToken, lobbyUrl, sessionStatus, hostUserId, roundDashboard } = useSessionStore();

  // During an active round or rating, the host sees the breakout room dashboard
  // but ONLY if we have dashboard data — otherwise stay in lobby with status message
  if (isHost && (sessionStatus === 'round_active' || sessionStatus === 'round_rating') && roundDashboard && roundDashboard.rooms.length > 0) {
    return <HostRoundDashboard sessionId={sessionId!} />;
  }

  // LOBBY GATE: Participants cannot enter the lobby before the host starts the event.
  // Show a dedicated waiting room instead. Host still sees the normal lobby with controls.
  if (!isHost && sessionStatus === 'scheduled') {
    return <PreLobbyWaitingRoom isHost={isHost} />;
  }

  // If we have a lobby token, render the video mosaic
  if (lobbyToken && lobbyUrl) {
    return (
      <div className="flex-1 flex flex-col items-center p-6 gap-6 overflow-auto bg-[#202124]">
        <LobbyStatusOverlay isHost={isHost} />
        <DensityToggle />
        {isHost && <HostParticipantPanel sessionId={sessionId} />}
        <LiveKitRoom
          token={lobbyToken}
          serverUrl={lobbyUrl}
          connect={true}
          video={true}
          audio={true}
          className="flex-1 w-full max-w-4xl"
          options={{
            videoCaptureDefaults: { resolution: { width: 1280, height: 720, frameRate: 30 } },
          }}
        >
          <RoomAudioRenderer />
          <LobbyMosaic isHost={isHost} sessionId={sessionId} />
        </LiveKitRoom>
      </div>
    );
  }

  // Fallback: text-only lobby (no LiveKit credentials or lobby room)
  return (
    <div className="flex-1 flex items-center justify-center p-6 bg-[#202124]">
      <div className="max-w-lg w-full text-center bg-[#292a2d] rounded-2xl p-8">
        <LobbyStatusOverlay isHost={isHost} />
        {isHost && (
          <div className="mt-4">
            <HostParticipantPanel />
          </div>
        )}
        {isHost && (
          <div className="mt-6 flex flex-wrap gap-2 justify-center">
            {participants.map(p => (
              <span key={p.userId} className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium ${
                p.userId === hostUserId ? 'bg-amber-500/10 text-amber-400' : 'bg-white/10 text-gray-300'
              }`}>
                <span className={`h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                  p.userId === hostUserId ? 'bg-amber-500/20' : 'bg-white/10'
                }`}>
                  {(p.displayName || 'U').charAt(0).toUpperCase()}
                </span>
                {p.displayName || 'User'}
                {p.userId === hostUserId && <span className="text-[9px] text-amber-400 ml-0.5">(Host)</span>}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Layout Density Toggle ──────────────────────────────────────────────── */

function DensityToggle() {
  const lobbyDensity = useSessionStore(s => s.lobbyDensity);
  const setLobbyDensity = useSessionStore(s => s.setLobbyDensity);

  const options = [
    { value: 'compact' as const, label: 'Compact' },
    { value: 'normal' as const, label: 'Normal' },
    { value: 'spacious' as const, label: 'Spacious' },
  ];

  return (
    <div className="flex items-center gap-1 bg-white/10 rounded-full p-0.5">
      {options.map(o => (
        <button
          key={o.value}
          onClick={() => setLobbyDensity(o.value)}
          className={`px-3 py-1 text-[11px] font-medium rounded-full transition-colors ${
            lobbyDensity === o.value
              ? 'bg-white/20 text-white'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
