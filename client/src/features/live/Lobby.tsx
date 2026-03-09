import { Users, Clock, Loader2, VideoOff } from 'lucide-react';
import Card from '@/components/ui/Card';
import { useSessionStore } from '@/stores/sessionStore';
import {
  LiveKitRoom,
  VideoTrack,
  useTracks,
  useParticipants,
  RoomAudioRenderer,
} from '@livekit/components-react';
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
    <div className={`grid ${gridCols} gap-2 w-full`}>
      {cameraTracks.map(trackRef => {
        const name = trackRef.participant.name || trackRef.participant.identity || 'User';
        const hasVideo = !!trackRef.publication?.track;
        return (
          <div key={trackRef.participant.sid} className="relative rounded-xl overflow-hidden bg-surface-900 aspect-video flex items-center justify-center border border-surface-800">
            {hasVideo ? (
              <VideoTrack trackRef={trackRef} className="h-full w-full object-cover" />
            ) : (
              <div className="flex flex-col items-center gap-1">
                <div className="h-12 w-12 rounded-full bg-surface-800 flex items-center justify-center text-surface-400 font-bold text-lg">
                  {name.charAt(0).toUpperCase()}
                </div>
                <VideoOff className="h-3 w-3 text-surface-600" />
              </div>
            )}
            <div className="absolute bottom-1 left-1 bg-black/60 rounded px-1.5 py-0.5 text-[10px] text-white truncate max-w-[90%]">
              {name}
            </div>
          </div>
        );
      })}
      {cameraTracks.length === 0 && (
        <div className="col-span-full text-center py-8 text-surface-500 text-sm">
          Waiting for participants to enable cameras...
        </div>
      )}
    </div>
  );
}

function LobbyStatusOverlay() {
  const { participants, isByeRound, currentRound, totalRounds, transitionStatus } = useSessionStore();

  return (
    <div className="text-center space-y-3">
      {isByeRound ? (
        <>
          <h2 className="text-lg font-bold text-surface-100">Bye Round</h2>
          <p className="text-surface-400 text-sm">You have a bye this round — sit tight!</p>
        </>
      ) : transitionStatus === 'between_rounds' ? (
        <div className="flex items-center justify-center gap-2">
          <Loader2 className="h-4 w-4 text-brand-400 animate-spin" />
          <p className="text-surface-400 text-sm">Preparing round {currentRound} of {totalRounds}...</p>
        </div>
      ) : transitionStatus === 'starting_session' ? (
        <div className="flex items-center justify-center gap-2">
          <Loader2 className="h-4 w-4 text-brand-400 animate-spin" />
          <p className="text-surface-400 text-sm">Session starting — preparing your first match...</p>
        </div>
      ) : (
        <>
          <h2 className="text-lg font-bold text-surface-100">Lobby</h2>
          <p className="text-surface-400 text-sm">The host will start the session soon</p>
        </>
      )}
      <div className="flex items-center justify-center gap-2 text-surface-300 text-xs">
        <Clock className="h-3 w-3" />
        <span>{participants.length} participant{participants.length !== 1 ? 's' : ''} connected</span>
      </div>
    </div>
  );
}

export default function Lobby() {
  const { participants, lobbyToken, lobbyUrl } = useSessionStore();

  // If we have a lobby token, render the video mosaic
  if (lobbyToken && lobbyUrl) {
    return (
      <div className="flex-1 flex flex-col p-4 gap-4 overflow-auto">
        <LobbyStatusOverlay />
        <LiveKitRoom
          token={lobbyToken}
          serverUrl={lobbyUrl}
          connect={true}
          video={true}
          audio={false}
          className="flex-1"
        >
          <RoomAudioRenderer />
          <LobbyMosaic />
        </LiveKitRoom>
      </div>
    );
  }

  // Fallback: text-only lobby (no LiveKit credentials or lobby room)
  return (
    <div className="flex-1 flex items-center justify-center p-4">
      <Card className="max-w-lg w-full text-center">
        <div className="inline-flex items-center justify-center h-16 w-16 rounded-full bg-brand-500/20 text-brand-400 mb-4">
          <Users className="h-8 w-8" />
        </div>
        <LobbyStatusOverlay />
        <div className="mt-6 flex flex-wrap gap-2 justify-center">
          {participants.map(p => (
            <span key={p.userId} className="inline-flex items-center gap-1 rounded-full bg-surface-800 px-3 py-1 text-xs text-surface-300">
              {p.displayName || 'User'}
            </span>
          ))}
        </div>
      </Card>
    </div>
  );
}
