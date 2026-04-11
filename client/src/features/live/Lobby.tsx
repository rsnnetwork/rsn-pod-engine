import { Users, Loader2, Video, VideoOff, Sparkles, ChevronDown, ChevronUp, Mic, MicOff, Volume2, VolumeX, UserX, Camera } from 'lucide-react';
import HostRoundDashboard from './HostRoundDashboard';

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

  // Pin/spotlight state — client-side only, no server interaction
  const [pinnedSid, setPinnedSid] = useState<string | null>(null);

  // Auto-unpin if pinned participant leaves
  useEffect(() => {
    if (pinnedSid && !cameraTracks.find(t => t.participant.sid === pinnedSid)) {
      setPinnedSid(null);
    }
  }, [cameraTracks, pinnedSid]);

  // Helper to render a single video tile with all overlays
  const renderTile = (trackRef: any, { isPinned = false, onClick }: { isPinned?: boolean; onClick?: () => void } = {}) => {
    const name = trackRef.participant.name || trackRef.participant.identity || 'User';
    const hasVideo = !!trackRef.publication?.track;
    const isLocal = trackRef.participant.sid === localParticipant.sid;
    const isMicOn = trackRef.participant.isMicrophoneEnabled;
    return (
      <div
        key={trackRef.participant.sid}
        className={`relative rounded-xl overflow-hidden bg-[#3c4043] ${isPinned ? 'h-full w-full' : 'aspect-video'} flex items-center justify-center group cursor-pointer`}
        onClick={onClick}
      >
        {hasVideo && isTrackReference(trackRef) ? (
          <VideoTrack trackRef={trackRef} className={`h-full w-full ${isPinned ? 'object-contain' : 'object-cover'}`} />
        ) : (
          <div className="flex flex-col items-center gap-2">
            <div className={`${isPinned ? 'h-20 w-20' : 'h-14 w-14'} rounded-full bg-[#5f6368] flex items-center justify-center text-white font-semibold text-xl`}>
              {name.charAt(0).toUpperCase()}
            </div>
          </div>
        )}
        <div className="absolute bottom-2 left-2 bg-black/60 backdrop-blur-sm rounded px-2 py-0.5 text-[11px] text-white truncate max-w-[90%] flex items-center gap-1.5">
          {name}
          {trackRef.participant.identity === hostUserId && (
            <span className="text-[9px] font-medium text-amber-300 ml-0.5">(Host)</span>
          )}
        </div>
        {isPinned && (
          <div className="absolute top-2 right-2 bg-black/60 text-white text-[10px] px-2 py-0.5 rounded-full">
            Pinned · click to unpin
          </div>
        )}
        {/* Own media controls on local tile */}
        {isLocal && (
          <div className="absolute bottom-1.5 right-1.5" onClick={e => e.stopPropagation()}>
            <LobbyMediaControls isHost={isHost} sessionId={sessionId} />
          </div>
        )}
        {/* Host mute/unmute + kick buttons on remote participant tiles */}
        {isHost && !isLocal && (
          <div className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
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
            <MicOff className="h-2.5 w-2.5 text-[#1a1a2e]" />
          </div>
        )}
      </div>
    );
  };

  // Pinned layout: large tile + small row at bottom
  const pinnedTrack = pinnedSid ? cameraTracks.find(t => t.participant.sid === pinnedSid) : null;
  if (pinnedTrack) {
    const unpinnedTracks = cameraTracks.filter(t => t.participant.sid !== pinnedSid);
    return (
      <div className={`flex flex-col gap-3 w-full ${maxWClass} mx-auto h-full`}>
        <div className="flex-1 min-h-0">
          {renderTile(pinnedTrack, { isPinned: true, onClick: () => setPinnedSid(null) })}
        </div>
        {unpinnedTracks.length > 0 && (
          <div className="flex gap-2 h-24 shrink-0 overflow-x-auto">
            {unpinnedTracks.map(t => (
              <div key={t.participant.sid} className="flex-shrink-0 w-32">
                {renderTile(t, { onClick: () => setPinnedSid(t.participant.sid) })}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Default grid layout (unchanged behavior when nothing is pinned)
  return (
    <div className={`grid ${gridCols} ${gapClass} w-full ${maxWClass} mx-auto`}>
      {cameraTracks.map(trackRef =>
        renderTile(trackRef, { onClick: () => setPinnedSid(trackRef.participant.sid) })
      )}
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
  const [camEnabled, setCamEnabled] = useState(true);
  const [allMuted, setAllMuted] = useState(false);
  const [bgMode, setBgMode] = useState('disabled');
  const [showBgPanel, setShowBgPanel] = useState(false);

  useEffect(() => {
    if (localParticipant) {
      setCamEnabled(localParticipant.isCameraEnabled);
    }
  }, [localParticipant]);

  // Auto-mute participants (not host) on mount
  useEffect(() => {
    if (!isHost) {
      localParticipant.setMicrophoneEnabled(false);
      setMicEnabled(false);
    }
  }, [isHost, localParticipant]);

  // Guard: prevent user toggle while host mute command is being applied (race condition)
  const [hostMuteProcessing, setHostMuteProcessing] = useState(false);

  // Respond to host mute/unmute commands — takes priority over local toggle
  useEffect(() => {
    if (hostMuteCommand !== null && !isHost) {
      setHostMuteProcessing(true);
      const target = !hostMuteCommand; // hostMuteCommand=true means "mute", so !true = false = mute
      localParticipant.setMicrophoneEnabled(target);
      setMicEnabled(target);
      setHostMuteCommand(null);
      setTimeout(() => setHostMuteProcessing(false), 500);
    }
  }, [hostMuteCommand, isHost, localParticipant, setHostMuteCommand]);

  const toggleMic = useCallback(async () => {
    if (hostMuteProcessing) return; // Don't allow toggle while host command is being applied
    await localParticipant.setMicrophoneEnabled(!micEnabled);
    setMicEnabled(!micEnabled);
  }, [localParticipant, micEnabled, hostMuteProcessing]);

  const toggleCam = useCallback(async () => {
    const target = !camEnabled;
    setCamEnabled(target); // Optimistic UI update
    try {
      await localParticipant.setCameraEnabled(target);
    } catch (err) {
      console.error('Camera toggle failed:', err);
      // If direct toggle fails, try the nuclear option: stop all video, then re-enable
      if (target) {
        try {
          // Stop existing tracks
          const tracks = Array.from(localParticipant.videoTrackPublications.values());
          for (const pub of tracks) {
            if (pub.track) pub.track.stop();
          }
          // Wait for cleanup
          await new Promise(r => setTimeout(r, 300));
          // Request fresh camera
          await localParticipant.setCameraEnabled(true);
        } catch (retryErr) {
          console.error('Camera retry also failed:', retryErr);
        }
      }
    }
    // Always sync from actual state after 500ms
    setTimeout(() => setCamEnabled(localParticipant.isCameraEnabled), 500);
  }, [localParticipant, camEnabled]);

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
            : 'bg-red-500/80 text-[#1a1a2e] hover:bg-red-600/80'
        }`}
      >
        {micEnabled ? <Mic className="h-3 w-3" /> : <MicOff className="h-3 w-3" />}
        {micEnabled ? 'Mute' : 'Unmute'}
      </button>
      <button
        onClick={toggleCam}
        className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-medium transition-colors backdrop-blur-sm ${
          camEnabled
            ? 'bg-black/40 text-white hover:bg-black/60'
            : 'bg-red-500/80 text-[#1a1a2e] hover:bg-red-600/80'
        }`}
      >
        {camEnabled ? <Video className="h-3 w-3" /> : <VideoOff className="h-3 w-3" />}
        {camEnabled ? 'Cam Off' : 'Cam On'}
      </button>
      {/* Virtual background toggle */}
      <div className="relative">
        <button
          onClick={() => setShowBgPanel(!showBgPanel)}
          className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-medium transition-colors backdrop-blur-sm ${
            bgMode !== 'disabled' ? 'bg-indigo-500/80 text-white' : 'bg-black/40 text-white hover:bg-black/60'
          }`}
          title="Background effects"
        >
          <Sparkles className="h-3 w-3" />
          BG
        </button>
        {showBgPanel && (
          <div className="absolute bottom-full right-0 mb-2 bg-white rounded-xl shadow-xl border border-gray-200 p-2 w-56 z-50">
            <p className="text-[10px] font-semibold text-gray-400 uppercase mb-1.5 px-1">Background</p>
            <div className="grid grid-cols-3 gap-1.5">
              {[
                { label: 'None', mode: 'disabled' },
                { label: 'Blur', mode: 'blur' },
                { label: 'Office', mode: 'office', img: 'https://images.unsplash.com/photo-1497366216548-37526070297c?w=200&q=60' },
                { label: 'Nature', mode: 'nature', img: 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=200&q=60' },
                { label: 'City', mode: 'city', img: 'https://images.unsplash.com/photo-1480714378408-67cf0d13bc1b?w=200&q=60' },
                { label: 'Abstract', mode: 'abstract', img: 'https://images.unsplash.com/photo-1557683316-973673baf926?w=200&q=60' },
              ].map(preset => (
                <button key={preset.mode} onClick={async () => {
                  try {
                    const mod = await loadBgProcessors();
                    if (!mod) { console.error('Background processors not available'); return; }
                    const camPub = Array.from(localParticipant.trackPublications.values()).find(p => p.source === 'camera');
                    const camTrack = camPub?.track;
                    if (!camTrack) return;
                    await (camTrack as any).stopProcessor?.();
                    if (preset.mode === 'disabled') { setBgMode('disabled'); }
                    else if (preset.mode === 'blur') { await (camTrack as any).setProcessor(mod.BackgroundBlur(10)); setBgMode('blur'); }
                    else if (preset.img) { await (camTrack as any).setProcessor(mod.VirtualBackground(preset.img.replace('w=200', 'w=1280'))); setBgMode(preset.mode); }
                  } catch (err) { console.error('BG effect failed:', err); }
                  setShowBgPanel(false);
                }}
                className={`rounded-lg border-2 overflow-hidden ${bgMode === preset.mode ? 'border-rsn-red' : 'border-gray-200 hover:border-gray-400'}`}>
                  {preset.img ? (
                    <img src={preset.img} alt={preset.label} className="w-full h-10 object-cover" />
                  ) : (
                    <div className={`w-full h-10 flex items-center justify-center text-[10px] font-medium ${preset.mode === 'disabled' ? 'bg-gray-100 text-gray-500' : 'bg-indigo-50 text-indigo-600'}`}>{preset.label}</div>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {isHost && sessionId && (
        <button
          onClick={handleMuteAll}
          className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-medium transition-colors backdrop-blur-sm ${
            allMuted
              ? 'bg-red-500/80 text-[#1a1a2e] hover:bg-red-600/80'
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
function useHostPresence(gracePeriodMs = 15000): boolean | null {
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
  const { participants, isByeRound, currentRound, totalRounds, transitionStatus, sessionStatus, hostUserId, timerSeconds } = useSessionStore();
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
          <h2 className="text-xl font-bold text-[#1a1a2e]">Event finished</h2>
          <p className="text-gray-400 text-sm max-w-xs">Preparing your recap...</p>
          {timerSeconds > 0 && (
            <p className="text-sm text-gray-500 mt-2">
              Ending in <span className="text-white font-mono">{timerSeconds}s</span>
            </p>
          )}
        </div>
      ) : isByeRound ? (
        <>
          <h2 className="text-xl font-bold text-[#1a1a2e]">Waiting for Next Round</h2>
          <p className="text-gray-400 text-sm">You have a round off — you'll be back in the next one!</p>
          <p className="text-xs text-gray-500 mt-1">The round is still in progress. Sit tight.</p>
        </>
      ) : transitionStatus === 'session_ending' ? (
        <div className="flex flex-col items-center gap-2">
          <Loader2 className="h-5 w-5 text-gray-400 animate-spin" />
          <p className="text-gray-300 text-sm font-medium">Event complete — preparing your recap...</p>
        </div>
      ) : transitionStatus === 'between_rounds' ? (
        <div className="flex flex-col items-center gap-2">
          <Loader2 className="h-5 w-5 text-gray-400 animate-spin" />
          <h2 className="text-xl font-bold text-[#1a1a2e]">Getting Ready</h2>
          <p className="text-gray-400 text-sm">Preparing round {(currentRound || 0) + 1} of {totalRounds}...</p>
        </div>
      ) : transitionStatus === 'starting_session' ? (
        <div className="flex flex-col items-center gap-2">
          <Loader2 className="h-5 w-5 text-gray-400 animate-spin" />
          <h2 className="text-xl font-bold text-[#1a1a2e]">Event Starting</h2>
          <p className="text-gray-400 text-sm">
            {isHost ? 'Main room is open — use Match People below when ready.' : 'Waiting for the host to begin matching...'}
          </p>
        </div>
      ) : (sessionStatus === 'round_active' || sessionStatus === 'round_rating') ? (
        <div className="flex flex-col items-center gap-2">
          <Loader2 className="h-5 w-5 text-gray-400 animate-spin" />
          <h2 className="text-xl font-bold text-[#1a1a2e]">Round in Progress</h2>
          <p className="text-gray-400 text-sm">
            {isHost ? 'Monitoring breakout rooms...' : 'Waiting for this round to finish'}
          </p>
        </div>
      ) : isScheduled ? (
        <>
          <div className="inline-flex items-center justify-center h-12 w-12 rounded-full bg-white/10 text-gray-300 mx-auto">
            <Sparkles className="h-6 w-6" />
          </div>
          <h2 className="text-xl font-bold text-[#1a1a2e]">Waiting Room</h2>
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
          <h2 className="text-xl font-bold text-[#1a1a2e]">Main Room</h2>
          {isHost && (
            <p className="text-gray-400 text-sm">
              You're the host — click Match People below when ready
            </p>
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
    <div className="w-full max-w-4xl mx-auto bg-gray-50 rounded-xl overflow-hidden">
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
    <div className="flex flex-col items-center gap-3">
      {/* Camera preview — large, prominent, the main thing users see */}
      <div className="relative w-full aspect-video max-w-lg rounded-2xl overflow-hidden bg-gray-900 shadow-lg">
        <video
          ref={videoRef}
          autoPlay muted playsInline
          className="h-full w-full object-cover"
          style={{ transform: 'scaleX(-1)', display: camOn ? 'block' : 'none' }}
        />
        {!camOn && (
          <div className="h-full w-full flex items-center justify-center bg-gray-100">
            <VideoOff className="h-10 w-10 text-gray-400" />
          </div>
        )}

        {/* Controls overlaid on bottom of camera — Google Meet style */}
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-white/90 backdrop-blur-sm rounded-full px-4 py-2 shadow-md">
          <button onClick={toggleCam} className={`p-2 rounded-full transition-colors ${camOn ? 'bg-gray-100 text-gray-700 hover:bg-gray-200' : 'bg-red-500 text-white'}`}>
            {camOn ? <Camera className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
          </button>
          <button onClick={toggleMic} className={`p-2 rounded-full transition-colors ${micOn ? 'bg-gray-100 text-gray-700 hover:bg-gray-200' : 'bg-red-500 text-white'}`}>
            {micOn ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
          </button>
          {/* Mic level bar */}
          <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all duration-75 ${micOn ? 'bg-green-500' : 'bg-gray-400'}`} style={{ width: `${micOn ? micLevel * 100 : 0}%` }} />
          </div>
        </div>
      </div>
      <p className="text-xs text-gray-400">Check your camera and mic before the event starts</p>
    </div>
  );
}

/**
 * Participant-only waiting room shown before the host starts the event.
 * Camera-first layout: video preview is the primary content,
 * status overlay is secondary — matches how Google Meet / FaceTime handle pre-call.
 */
function PreLobbyWaitingRoom({ isHost = false }: { isHost?: boolean }) {
  const { participants, hostUserId } = useSessionStore();
  const hostOnline = useHostPresence();

  return (
    <div className="flex-1 flex flex-col bg-white">
      {/* Camera-first: DeviceTest is the primary content area */}
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-lg">
          {/* Large camera preview — the main thing you see */}
          <DeviceTest />

          {/* Status strip — compact overlay below camera */}
          <div className="mt-4 flex flex-col items-center gap-2">
            {hostOnline === true ? (
              <div className="inline-flex items-center gap-2 bg-green-50 border border-green-200 px-4 py-2 rounded-full">
                <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                <span className="text-sm font-medium text-green-700">Host is here — event starting soon</span>
              </div>
            ) : hostOnline === false ? (
              <div className="inline-flex items-center gap-2 bg-gray-50 border border-gray-200 px-4 py-2 rounded-full">
                <span className="h-2 w-2 rounded-full bg-gray-400" />
                <span className="text-sm font-medium text-gray-600">Waiting for host to start the event</span>
              </div>
            ) : (
              <div className="inline-flex items-center gap-2 bg-gray-50 border border-gray-200 px-4 py-2 rounded-full">
                <span className="h-2 w-2 rounded-full bg-gray-500 animate-pulse" />
                <span className="text-sm font-medium text-gray-600">Connecting...</span>
              </div>
            )}

            {/* Participant count — compact inline */}
            {participants.length > 0 && (
              <div className="flex items-center gap-2 text-gray-500 text-xs">
                <Users className="h-3.5 w-3.5" />
                <span>
                  {(() => {
                    const hostInList = participants.some(p => p.userId === hostUserId);
                    const participantCount = participants.length - (hostInList ? 1 : 0);
                    return `${participantCount} participant${participantCount !== 1 ? 's' : ''}${hostOnline || hostInList ? ' + host' : ''} waiting`;
                  })()}
                </span>
              </div>
            )}

            {/* Host sees participant names */}
            {isHost && participants.length > 0 && (
              <div className="flex flex-wrap gap-2 justify-center mt-2">
                {participants.map(p => (
                  <span key={p.userId} className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium ${
                    p.userId === hostUserId ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-gray-100 text-gray-600'
                  }`}>
                    <span className={`h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                      p.userId === hostUserId ? 'bg-amber-100' : 'bg-gray-200'
                    }`}>
                      {(p.displayName || 'U').charAt(0).toUpperCase()}
                    </span>
                    {p.displayName || 'User'}
                    {p.userId === hostUserId && <span className="text-[9px] text-amber-600 ml-0.5">(Host)</span>}
                  </span>
                ))}
              </div>
            )}
          </div>
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
      <div className="flex-1 flex flex-col items-center p-6 gap-6 overflow-auto bg-white">
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
    <div className="flex-1 flex items-center justify-center p-6 bg-white">
      <div className="max-w-lg w-full text-center bg-gray-50 rounded-2xl p-8">
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
              ? 'bg-white/20 text-[#1a1a2e]'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
