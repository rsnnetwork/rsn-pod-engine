import { Users, Loader2, VideoOff, Sparkles } from 'lucide-react';
import Card from '@/components/ui/Card';
import { useSessionStore } from '@/stores/sessionStore';
import {
  LiveKitRoom,
  VideoTrack,
  useTracks,
  useParticipants,
  RoomAudioRenderer,
} from '@livekit/components-react';
import { isTrackReference } from '@livekit/components-core';
import '@livekit/components-styles';
import { Track } from 'livekit-client';

function LobbyMosaic() {
  const tracks = useTracks(
    [{ source: Track.Source.Camera, withPlaceholder: true }],
    { onlySubscribed: false },
  );
  const participants = useParticipants();
  const cameraTracks = tracks.filter(t => t.source === Track.Source.Camera);

  // Responsive grid: up to 2 cols on mobile, 3 on tablet, 4-5 on desktop
  const gridCols =
    participants.length <= 2 ? 'grid-cols-1 sm:grid-cols-2'
    : participants.length <= 4 ? 'grid-cols-2 sm:grid-cols-2'
    : participants.length <= 9 ? 'grid-cols-2 sm:grid-cols-3'
    : 'grid-cols-3 sm:grid-cols-4 lg:grid-cols-5';

  return (
    <div className={`grid ${gridCols} gap-3 w-full max-w-4xl mx-auto`}>
      {cameraTracks.map(trackRef => {
        const name = trackRef.participant.name || trackRef.participant.identity || 'User';
        const hasVideo = !!trackRef.publication?.track;
        return (
          <div key={trackRef.participant.sid} className="relative rounded-2xl overflow-hidden bg-gradient-to-br from-gray-50 to-gray-100 aspect-video flex items-center justify-center border border-gray-200 shadow-sm">
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

function LobbyStatusOverlay({ isHost }: { isHost: boolean }) {
  const { participants, isByeRound, currentRound, totalRounds, transitionStatus, sessionStatus, hostInLobby } = useSessionStore();

  // Session hasn't been started yet by host
  const isScheduled = sessionStatus === 'scheduled';

  return (
    <div className="text-center space-y-3">
      {isByeRound ? (
        <>
          <h2 className="text-xl font-bold text-[#1a1a2e]">Bye Round</h2>
          <p className="text-gray-500 text-sm">You have a bye this round — sit tight!</p>
        </>
      ) : transitionStatus === 'session_ending' ? (
        <div className="flex flex-col items-center gap-2">
          <Loader2 className="h-5 w-5 text-indigo-600 animate-spin" />
          <p className="text-gray-600 text-sm font-medium">Session complete — preparing your recap...</p>
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
          <h2 className="text-xl font-bold text-[#1a1a2e]">Session Starting</h2>
          <p className="text-gray-500 text-sm">Preparing your first match...</p>
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
              ? 'You\'re the host — click Start Session below when everyone is ready'
              : hostInLobby
                ? 'The host is here! They\'ll start the session shortly.'
                : 'Waiting for the host to join and start the session...'}
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
              ? 'You\'re the host — click Start Round below when everyone is ready'
              : 'You\'re in the lobby — sit tight, the host will start the round soon!'}
          </p>
        </>
      )}
      <div className="flex items-center justify-center gap-2 text-gray-500 text-xs">
        <Users className="h-3.5 w-3.5" />
        <span>{participants.length} participant{participants.length !== 1 ? 's' : ''} connected</span>
      </div>
    </div>
  );
}

export default function Lobby({ isHost = false }: { isHost?: boolean }) {
  const { participants, lobbyToken, lobbyUrl, sessionStatus } = useSessionStore();

  // If we have a lobby token, render the video mosaic
  if (lobbyToken && lobbyUrl) {
    return (
      <div className="flex-1 flex flex-col items-center p-6 gap-6 overflow-auto bg-gradient-to-b from-white to-gray-50/50">
        <LobbyStatusOverlay isHost={isHost} />
        <LiveKitRoom
          token={lobbyToken}
          serverUrl={lobbyUrl}
          connect={true}
          video={true}
          audio={false}
          className="flex-1 w-full max-w-4xl"
        >
          <RoomAudioRenderer />
          <LobbyMosaic />
        </LiveKitRoom>
      </div>
    );
  }

  // Fallback: text-only lobby (no LiveKit credentials or lobby room)
  return (
    <div className="flex-1 flex items-center justify-center p-6 bg-gradient-to-b from-white to-gray-50/50">
      <Card className="max-w-lg w-full text-center">
        <LobbyStatusOverlay isHost={isHost} />
        <div className="mt-6 flex flex-wrap gap-2 justify-center">
          {participants.map(p => (
            <span key={p.userId} className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-3 py-1.5 text-xs text-indigo-600 font-medium">
              <span className="h-5 w-5 rounded-full bg-indigo-100 flex items-center justify-center text-[10px] font-bold">
                {(p.displayName || 'U').charAt(0).toUpperCase()}
              </span>
              {p.displayName || 'User'}
            </span>
          ))}
        </div>
        {sessionStatus === 'scheduled' && (
          <p className="mt-4 text-xs text-gray-400 flex items-center justify-center gap-1.5">
            <VideoOff className="h-3.5 w-3.5" />
            Video mosaic will appear once the host starts the session
          </p>
        )}
      </Card>
    </div>
  );
}
