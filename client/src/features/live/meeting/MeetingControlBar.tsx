// ─── The meeting room's bottom bar (26 Oct 2026, VID-03) ───────────────────────
//
// On 25 Oct the guest "couldn't hang up": Leave was a red text button top-right,
// End Event a red button bottom-right beside a look-alike red Control Center, and
// a super_admin saw End Event disabled although the server lets him end it. A video
// meeting has one bar for everyone: Mic, Camera, Chat, People and Leave; the
// director and a super_admin (canEndEvent, the server's rule) also get "End for
// everyone". Both ask first in the app's own dialog (Modal, portalled to body).
// Leave keeps the meeting running for the others (the director's too) and lands on
// the event page, where "Enter Live Event" brings the person back.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CircleStop, Loader2, MessageCircle, Mic, MicOff, PhoneOff, Play, Users, Video, VideoOff } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { getSocket } from '@/lib/socket';
import { useSessionStore } from '@/stores/sessionStore';
import { useActionLock } from '@/hooks/useActionLock';
import { useLocalMediaToggles } from './useLocalMediaToggles';

/** Every control in the bar: a 44px target at least. */
const BAR_BUTTON = 'relative inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center gap-2 rounded-full text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60';
const QUIET = 'bg-gray-100 text-gray-800 hover:bg-gray-200';
const OFF = 'bg-red-100 text-red-700 hover:bg-red-200';
const PRESSED = 'bg-[#1a1a2e] text-white hover:bg-[#2a2a40]';
const DIALOG_BUTTON = 'inline-flex min-h-[44px] items-center justify-center rounded-xl px-4 text-sm font-semibold transition-colors';

/** Mic and camera: inside the meeting's <LiveKitRoom> only. */
function MediaButtons({ honourHostMute }: { honourHostMute: boolean }) {
  const { micOn, camOn, camStarting, micBusy, camBusy, toggleMic, toggleCam } = useLocalMediaToggles({ honourHostMute });
  return (
    <>
      <button
        type="button"
        className={`${BAR_BUTTON} ${micOn ? QUIET : OFF}`}
        aria-label={micOn ? 'Mic on' : 'Mic off'}
        title={micOn ? 'Mute your microphone' : 'Unmute your microphone'}
        disabled={micBusy}
        onClick={() => { void toggleMic(); }}
      >
        {micOn ? <Mic className="h-5 w-5" aria-hidden="true" /> : <MicOff className="h-5 w-5" aria-hidden="true" />}
      </button>
      <button
        type="button"
        className={`${BAR_BUTTON} ${camStarting ? `${QUIET} cursor-wait` : camOn ? QUIET : OFF}`}
        aria-label={camStarting ? 'Starting camera' : camOn ? 'Camera on' : 'Camera off'}
        title={camStarting ? 'Starting your camera' : camOn ? 'Turn your camera off' : 'Turn your camera on'}
        disabled={camStarting || camBusy}
        onClick={() => { void toggleCam(); }}
      >
        {camStarting
          ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
          : camOn ? <Video className="h-5 w-5" aria-hidden="true" /> : <VideoOff className="h-5 w-5" aria-hidden="true" />}
      </button>
    </>
  );
}

function CountBadge({ value, tone }: { value: number; tone: 'blue' | 'gray' }) {
  if (value <= 0) return null;
  return (
    <span
      className={`absolute -right-1 -top-1 flex h-5 min-w-[20px] items-center justify-center rounded-full px-1 text-[11px] font-bold ${
        tone === 'blue' ? 'bg-blue-600 text-white' : 'bg-white text-gray-800 ring-1 ring-gray-300'
      }`}
      aria-hidden="true"
    >
      {value > 9 ? '9+' : value}
    </span>
  );
}

export interface MeetingControlBarProps {
  sessionId: string;
  /** In the room (inside <LiveKitRoom>): the mic and camera can be used. */
  inRoom: boolean;
  /** The meeting has not started yet. */
  preStart: boolean;
  /** Runs the meeting: may start it (the director, a co-host, a super_admin). */
  canManage: boolean;
  /** May end it for everyone: the director or a super_admin. */
  canEndEvent: boolean;
  isDirector: boolean;
  /** The director's name, or "the host" when it is not known. */
  directorName: string;
  chatOpen: boolean;
  unreadChat: number;
  onToggleChat: () => void;
  peopleOpen: boolean;
  peopleCount: number;
  onTogglePeople: () => void;
}

export default function MeetingControlBar({
  sessionId, inRoom, preStart, canManage, canEndEvent, isDirector, directorName,
  chatOpen, unreadChat, onToggleChat, peopleOpen, peopleCount, onTogglePeople,
}: MeetingControlBarProps) {
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState<'leave' | 'end' | null>(null);
  const startLock = useActionLock();
  // Held until the meeting has ended (the screen changes), or ten seconds if the server refuses.
  const endLock = useActionLock(10_000);
  const ending = endLock.isLocked('end_event');
  // A co-host runs the meeting but cannot end it: the Leave dialog says who can.
  const showEndNote = canManage && !canEndEvent;

  const startMeeting = () => startLock.runLocked('start_session', () => {
    getSocket()?.emit('host:start_session', { sessionId });
  });

  const endForEveryone = () => {
    setConfirm(null);
    endLock.runLocked('end_event', () => {
      getSocket()?.emit('host:end_session', { sessionId, endEvent: true });
    });
  };

  // The app's one live connection stays up (C10, COM-05): the server takes this socket out of the event's room on
  // session:leave. Cutting it as well left the guest's event page on the room's stale list ("Reconnecting…") and
  // without bells, the "Ended" flip or the organiser's message until the token rotated.
  const leaveMeeting = () => {
    setConfirm(null);
    getSocket()?.emit('session:leave', { sessionId });
    useSessionStore.getState().reset();
    navigate(`/sessions/${sessionId}`, { replace: true });
  };

  return (
    <div
      data-testid="meeting-control-bar"
      className="shrink-0 border-t border-gray-200 bg-white px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-4"
    >
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {inRoom && <MediaButtons honourHostMute={!canManage} />}
          <button
            type="button"
            className={`${BAR_BUTTON} ${chatOpen ? PRESSED : QUIET}`}
            aria-label="Chat"
            aria-pressed={chatOpen}
            title={chatOpen ? 'Close the chat' : 'Open the chat'}
            onClick={onToggleChat}
          >
            <MessageCircle className="h-5 w-5" aria-hidden="true" />
            <CountBadge value={chatOpen ? 0 : unreadChat} tone="blue" />
          </button>
          <button
            type="button"
            className={`${BAR_BUTTON} ${peopleOpen ? PRESSED : QUIET}`}
            aria-label="People"
            aria-pressed={peopleOpen}
            title={peopleOpen ? 'Close the people list' : 'See who is here'}
            onClick={onTogglePeople}
          >
            <Users className="h-5 w-5" aria-hidden="true" />
            <CountBadge value={peopleCount} tone="gray" />
          </button>
        </div>

        <div className="flex items-center gap-2">
          {preStart && canManage && (
            <button
              type="button"
              className={`${BAR_BUTTON} bg-reason-green-fill px-4 font-semibold text-white hover:bg-reason-green-fill-hover`}
              disabled={startLock.isLocked('start_session')}
              onClick={startMeeting}
            >
              {startLock.isLocked('start_session')
                ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                : <Play className="h-4 w-4" aria-hidden="true" />}
              Start meeting
            </button>
          )}
          <button
            type="button"
            data-testid="meeting-leave"
            className={`${BAR_BUTTON} bg-red-600 px-3 text-white hover:bg-red-700 sm:px-4`}
            aria-label="Leave meeting"
            title="Leave the meeting (it carries on for the others)"
            onClick={() => setConfirm('leave')}
          >
            <PhoneOff className="h-5 w-5" aria-hidden="true" />
            <span className="hidden sm:inline">Leave</span>
          </button>
          {canEndEvent && !preStart && (
            <button
              type="button"
              data-testid="meeting-end"
              className={`${BAR_BUTTON} border-2 border-red-600 bg-white px-3 font-semibold text-red-700 hover:bg-red-50`}
              aria-label="End for everyone"
              title="End the meeting for everyone"
              disabled={ending}
              onClick={() => setConfirm('end')}
            >
              {ending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <CircleStop className="h-4 w-4" aria-hidden="true" />}
              <span className="hidden sm:inline">{ending ? 'Ending…' : 'End for everyone'}</span>
              <span className="sm:hidden">End</span>
            </button>
          )}
        </div>
      </div>

      <Modal open={confirm === 'leave'} onClose={() => setConfirm(null)} className="max-w-sm">
        <div role="alertdialog" aria-modal="true" aria-labelledby="meeting-leave-title" aria-describedby="meeting-leave-text" className="pt-6">
          <h2 id="meeting-leave-title" className="text-lg font-semibold text-[#1a1a2e]">Leave the meeting?</h2>
          <p id="meeting-leave-text" className="mt-2 text-sm text-gray-600">The others can carry on. You can rejoin from the event page.</p>
          {showEndNote && (
            <p className="mt-2 text-sm text-gray-600">{`Only ${directorName} can end the meeting for everyone.`}</p>
          )}
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" autoFocus className={`${DIALOG_BUTTON} border border-gray-300 bg-white text-gray-800 hover:bg-gray-100`} onClick={() => setConfirm(null)}>
              Stay
            </button>
            <button type="button" className={`${DIALOG_BUTTON} bg-red-600 text-white hover:bg-red-700`} onClick={leaveMeeting}>
              Leave
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={confirm === 'end'} onClose={() => setConfirm(null)} className="max-w-sm">
        <div role="alertdialog" aria-modal="true" aria-labelledby="meeting-end-title" aria-describedby="meeting-end-text" className="pt-6">
          <h2 id="meeting-end-title" className="text-lg font-semibold text-[#1a1a2e]">End the meeting for everyone?</h2>
          <p id="meeting-end-text" className="mt-2 text-sm text-gray-600">Everyone will be disconnected.</p>
          {!isDirector && (
            <p className="mt-2 text-sm text-gray-600">{`You are ending ${directorName}'s meeting.`}</p>
          )}
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" autoFocus className={`${DIALOG_BUTTON} border border-gray-300 bg-white text-gray-800 hover:bg-gray-100`} onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button type="button" className={`${DIALOG_BUTTON} bg-red-600 text-white hover:bg-red-700`} onClick={endForEveryone}>
              End for everyone
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
