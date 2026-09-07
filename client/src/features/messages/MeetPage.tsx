// ─── 1:1 meeting call (W-meet, 8 Sep 2026) ──────────────────────────────────
//
// A full-page call on RSN for a scheduled meeting or a "Meet now". Reached from
// the chat meeting card, the Join button, the bell "X is calling", or the email
// link. Uses the same LiveKit stack the events use. Leaving returns to the chat.

import { useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { LiveKitRoom, RoomAudioRenderer, GridLayout, ParticipantTile, ControlBar, useTracks } from '@livekit/components-react';
import '@livekit/components-styles';
import { Track } from 'livekit-client';
import { ArrowLeft } from 'lucide-react';
import api from '@/lib/api';
import { PageLoader } from '@/components/ui/Spinner';

function CallStage() {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );
  return (
    <div className="min-h-0 flex-1">
      <GridLayout tracks={tracks} style={{ height: '100%' }}>
        <ParticipantTile />
      </GridLayout>
    </div>
  );
}

export default function MeetPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const [params] = useSearchParams();
  const kind = params.get('kind') === 'audio' ? 'audio' : 'video';
  const navigate = useNavigate();
  const [conn, setConn] = useState<{ token: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const leave = () => navigate(`/messages/${conversationId}`);

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

  if (!conn) {
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
        <div className="shrink-0" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
          <ControlBar variation="minimal" />
        </div>
      </LiveKitRoom>
    </div>
  );
}
