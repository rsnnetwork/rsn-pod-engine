import { Users, Loader2, VideoOff, Sparkles, ChevronDown, ChevronUp, Mic, MicOff, Volume2, VolumeX, UserX } from 'lucide-react';
import HostRoundDashboard from './HostRoundDashboard';
import { useState, useEffect, useCallback } from 'react';
import Card from '@/components/ui/Card';
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
  const cameraTracks = tracks.filter(t => t.source === Track.Source.Camera);

  // Responsive grid: up to 2 cols on mobile, 3 on tablet, 4-5 on desktop
  const gridCols =
    participants.length <= 2 ? 'grid-cols-1 sm:grid-cols-2'
    : participants.length <= 4 ? 'grid-cols-2 sm:grid-cols-2'
    : participants.length <= 9 ? 'grid-cols-2 sm:grid-cols-3'
    : 'grid-cols-3 sm:grid-cols-4 lg:grid-cols-5';

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
    <div className={`grid ${gridCols} gap-3 w-full max-w-4xl mx-auto`}>
      {cameraTracks.map(trackRef => {
        const name = trackRef.participant.name || trackRef.participant.identity || 'User';
        const hasVideo = !!trackRef.publication?.track;
        const isLocal = trackRef.participant.sid === localParticipant.sid;
        const isMicOn = trackRef.participant.isMicrophoneEnabled;
        return (
          <div key={trackRef.participant.sid} className="relative rounded-2xl overflow-hidden bg-gradient-to-br from-gray-50 to-gray-100 aspect-video flex items-center justify-center border border-gray-200 shadow-sm group">
            {hasVideo && isTrackReference(trackRef) ? (
              <VideoTrack trackRef={trackRef} className="h-full w-full object-cover" />
            ) : (
              <div className="flex flex-col items-center gap-2">
                <div className="h-14 w-14 rounded-full bg-indigo-50 flex items-center justify-center text-indigo-500 font-bold text-xl shadow-inner">
                  {name.charAt(0).toUpperCase()}
                </div>
                <VideoOff className="h-3.5 w-3.5 text-gray-300" />
              </div>
            )}
            <div className="absolute bottom-1.5 left-1.5 bg-black/50 backdrop-blur-sm rounded-lg px-2 py-0.5 text-[11px] text-white truncate max-w-[90%]">
              {name}
            </div>
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
              <div className="absolute top-1.5 left-1.5 bg-red-500/80 rounded-full p-1">
                <MicOff className="h-2.5 w-2.5 text-white" />
              </div>
            )}
          </div>
        );
      })}
      {cameraTracks.length === 0 && (
        <div className="col-span-full text-center py-12 text-gray-400 text-sm">
          <div className="h-16 w-16 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-3">
            <VideoOff className="h-6 w-6 text-gray-300" />
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
    <div className="flex items-center gap-2">
      <button
        onClick={toggleMic}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
          micEnabled
            ? 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            : 'bg-red-50 text-red-500 hover:bg-red-100'
        }`}
      >
        {micEnabled ? <Mic className="h-3.5 w-3.5" /> : <MicOff className="h-3.5 w-3.5" />}
        {micEnabled ? 'Mute' : 'Unmute'}
      </button>
      {isHost && sessionId && (
        <button
          onClick={handleMuteAll}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
            allMuted
              ? 'bg-red-50 text-red-500 hover:bg-red-100'
              : 'bg-indigo-50 text-indigo-600 hover:bg-indigo-100'
          }`}
        >
          {allMuted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
          {allMuted ? 'Unmute All' : 'Mute All'}
        </button>
      )}
    </div>
  );
}

function LobbyStatusOverlay({ isHost }: { isHost: boolean }) {
  const { participants, isByeRound, currentRound, totalRounds, transitionStatus, sessionStatus, hostInLobby } = useSessionStore();

  // Session hasn't been started yet by host
  const isScheduled = sessionStatus === 'scheduled';

  return (
    <div className="text-center space-y-3">
      {isByeRound ? (
        <>
          <h2 className="text-xl font-bold text-[#1a1a2e]">Bye Round</h2>
          <p className="text-gray-500 text-sm">Odd one out this round — you'll be matched in the next round!</p>
          <p className="text-xs text-gray-400 mt-1">The round timer is still running. Hang tight.</p>
        </>
      ) : transitionStatus === 'session_ending' ? (
        <div className="flex flex-col items-center gap-2">
          <Loader2 className="h-5 w-5 text-indigo-600 animate-spin" />
          <p className="text-gray-600 text-sm font-medium">Event complete — preparing your recap...</p>
        </div>
      ) : transitionStatus === 'between_rounds' ? (
        <div className="flex flex-col items-center gap-2">
          <Loader2 className="h-5 w-5 text-indigo-600 animate-spin" />
          <h2 className="text-xl font-bold text-[#1a1a2e]">Getting Ready</h2>
          <p className="text-gray-500 text-sm">Preparing round {(currentRound || 0) + 1} of {totalRounds}...</p>
        </div>
      ) : transitionStatus === 'starting_session' ? (
        <div className="flex flex-col items-center gap-2">
          <Loader2 className="h-5 w-5 text-indigo-600 animate-spin" />
          <h2 className="text-xl font-bold text-[#1a1a2e]">Event Starting</h2>
          <p className="text-gray-500 text-sm">
            {isHost ? 'Lobby is open — use Match People below when ready.' : 'Preparing your first match...'}
          </p>
        </div>
      ) : isScheduled ? (
        // Session not yet started by host
        <>
          <div className="inline-flex items-center justify-center h-12 w-12 rounded-full bg-amber-50 text-amber-500 mx-auto">
            <Sparkles className="h-6 w-6" />
          </div>
          <h2 className="text-xl font-bold text-[#1a1a2e]">Waiting Room</h2>
          <p className="text-gray-500 text-sm">
            {isHost
              ? 'You\'re the host — click Start Event below when everyone is ready'
              : hostInLobby
                ? 'The host is here! They\'ll start the event shortly.'
                : 'Waiting for the host to join and start the event...'}
          </p>
        </>
      ) : (
        // Session is active (lobby_open or later)
        <>
          <div className="inline-flex items-center justify-center h-12 w-12 rounded-full bg-indigo-50 text-indigo-500 mx-auto">
            <Sparkles className="h-6 w-6" />
          </div>
          <h2 className="text-xl font-bold text-[#1a1a2e]">Lobby</h2>
          <p className="text-gray-500 text-sm">
            {isHost
              ? 'You\'re the host — click Match People below when ready'
              : hostInLobby
                ? 'You\'re in the lobby — the host will start the next round soon!'
                : 'You\'re in the lobby — waiting for the host to reconnect...'}
          </p>
          {!isHost && !hostInLobby && (
            <div className="inline-flex items-center gap-1.5 text-xs text-amber-600 bg-amber-50 px-3 py-1 rounded-full">
              <Loader2 className="h-3 w-3 animate-spin" />
              Host is offline
            </div>
          )}
        </>
      )}
      <div className="flex items-center justify-center gap-2 text-gray-500 text-xs">
        <Users className="h-3.5 w-3.5" />
        <span>
          {Math.max(0, participants.length - (hostInLobby ? 1 : 0))} participant{(participants.length - (hostInLobby ? 1 : 0)) !== 1 ? 's' : ''}
          {hostInLobby ? ' + host' : ''} connected
        </span>
      </div>
    </div>
  );
}

function HostParticipantPanel({ sessionId }: { sessionId?: string }) {
  const { participants, hostUserId } = useSessionStore();
  const [expanded, setExpanded] = useState(true);

  const handleKick = useCallback((userId: string, displayName: string) => {
    if (!sessionId) return;
    if (!window.confirm(`Remove ${displayName} from this event?`)) return;
    const socket = getSocket();
    socket?.emit('host:remove_participant', { sessionId, userId, reason: 'Removed by host' });
  }, [sessionId]);

  return (
    <div className="w-full max-w-4xl mx-auto bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-indigo-500" />
          <span>Participants ({Math.max(0, participants.length - 1)}) + Host</span>
        </div>
        {expanded ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
      </button>
      {expanded && (
        <div className="border-t border-gray-100 px-4 py-2 max-h-48 overflow-y-auto">
          {participants.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-3">No participants yet</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5">
              {participants.map(p => (
                <div key={p.userId} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-50 group/participant">
                  <div className={`h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                    p.userId === hostUserId ? 'bg-amber-50 text-amber-600' : 'bg-indigo-50 text-indigo-500'
                  }`}>
                    {(p.displayName || 'U').charAt(0).toUpperCase()}
                  </div>
                  <span className="text-xs text-gray-700 truncate flex-1">{p.displayName || 'User'}</span>
                  {p.userId === hostUserId && <span className="text-[9px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">Host</span>}
                  {sessionId && (
                    <button
                      onClick={() => handleKick(p.userId, p.displayName || 'User')}
                      className="opacity-0 group-hover/participant:opacity-100 transition-opacity text-gray-400 hover:text-red-500 p-0.5 rounded"
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

export default function Lobby({ isHost = false, sessionId }: { isHost?: boolean; sessionId?: string }) {
  const { participants, lobbyToken, lobbyUrl, sessionStatus, roundDashboard, hostUserId } = useSessionStore();

  // During an active round, the host sees the breakout room dashboard instead of lobby
  if (isHost && sessionStatus === 'round_active' && roundDashboard) {
    return <HostRoundDashboard sessionId={sessionId!} />;
  }

  // If we have a lobby token, render the video mosaic
  if (lobbyToken && lobbyUrl) {
    return (
      <div className="flex-1 flex flex-col items-center p-6 gap-6 overflow-auto bg-gradient-to-b from-white to-gray-50/50">
        <LobbyStatusOverlay isHost={isHost} />
        {isHost && <HostParticipantPanel sessionId={sessionId} />}
        <LiveKitRoom
          token={lobbyToken}
          serverUrl={lobbyUrl}
          connect={true}
          video={true}
          audio={true}
          className="flex-1 w-full max-w-4xl"
        >
          <RoomAudioRenderer />
          <LobbyMediaControls isHost={isHost} sessionId={sessionId} />
          <LobbyMosaic isHost={isHost} sessionId={sessionId} />
        </LiveKitRoom>
      </div>
    );
  }

  // Fallback: text-only lobby (no LiveKit credentials or lobby room)
  return (
    <div className="flex-1 flex items-center justify-center p-6 bg-gradient-to-b from-white to-gray-50/50">
      <Card className="max-w-lg w-full text-center">
        <LobbyStatusOverlay isHost={isHost} />
        {isHost && (
          <div className="mt-4">
            <HostParticipantPanel />
          </div>
        )}
        <div className="mt-6 flex flex-wrap gap-2 justify-center">
          {participants.map(p => (
            <span key={p.userId} className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium ${
              p.userId === hostUserId ? 'bg-amber-50 text-amber-700 ring-1 ring-amber-200' : 'bg-indigo-50 text-indigo-600'
            }`}>
              <span className={`h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                p.userId === hostUserId ? 'bg-amber-100' : 'bg-indigo-100'
              }`}>
                {(p.displayName || 'U').charAt(0).toUpperCase()}
              </span>
              {p.displayName || 'User'}
              {p.userId === hostUserId && <span className="text-[9px] bg-amber-200 text-amber-800 px-1.5 py-0.5 rounded-full ml-0.5">Host</span>}
            </span>
          ))}
        </div>
        {sessionStatus === 'scheduled' && (
          <p className="mt-4 text-xs text-gray-400 flex items-center justify-center gap-1.5">
            <VideoOff className="h-3.5 w-3.5" />
            Video mosaic will appear once the host starts the event
          </p>
        )}
      </Card>
    </div>
  );
}
