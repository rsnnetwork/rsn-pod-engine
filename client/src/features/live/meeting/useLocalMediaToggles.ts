// ─── Your own microphone and camera in the meeting room (26 Oct 2026, VID-02) ──────
//
// On 25 Oct the guest's mic and camera buttons sat on their own tile, which was
// below the fold, so hiding the self-view also hid the controls. The meeting room
// puts them in the bottom bar; this hook is their logic. Mount it inside the
// meeting's <LiveKitRoom>.
//
// It follows what the speed-networking rooms learned:
//   - the reactive values from useLocalParticipant are the truth (Bug 11: the
//     SDK's own events for a local publish are not 'trackPublished');
//   - the camera is the EVENT-SCOPED engine track (lib/bgEngine): turning it on
//     publishes or unmutes that track (turnCameraOn), turning it off mutes it,
//     never stops it, so the background pipeline lives for the whole event;
//   - captured but not yet published reads as "starting", never as off;
//   - a host's mute command is applied with one retry (S17), for people who do
//     not run the event themselves.
// Unlike the main room, nobody is force-muted on joining a meeting: the mic keeps
// the person's own last choice (sessionStorage 'rsn_mic').

import { useCallback, useEffect, useState } from 'react';
import { useLocalParticipant, useRoomContext } from '@livekit/components-react';
import { useSessionStore } from '@/stores/sessionStore';
import { useToastStore } from '@/stores/toastStore';
import { useBgEngine } from '@/hooks/useBgEngine';
import { turnCameraOn } from '../BgCameraPublisher';

/** The mic choice a person joins with: their last one in this tab, else on. */
export function savedMicChoice(): boolean {
  return sessionStorage.getItem('rsn_mic') !== 'false';
}

export interface LocalMediaToggles {
  micOn: boolean;
  camOn: boolean;
  /** The camera is captured (its light is on) but not yet in the room. */
  camStarting: boolean;
  micBusy: boolean;
  camBusy: boolean;
  toggleMic: () => Promise<void>;
  toggleCam: () => Promise<void>;
}

const MIC_FAILED = "Your microphone didn't turn on. Check that this site may use it in your browser settings.";
const CAMERA_FAILED = "Your camera didn't turn on. Check that this site may use it in your browser settings.";

export function useLocalMediaToggles({ honourHostMute }: { honourHostMute: boolean }): LocalMediaToggles {
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled } = useLocalParticipant();
  const room = useRoomContext();
  const bg = useBgEngine();
  const hostMuteCommand = useSessionStore((s) => s.hostMuteCommand);
  const setHostMuteCommand = useSessionStore((s) => s.setHostMuteCommand);
  const [micOn, setMicOn] = useState(isMicrophoneEnabled);
  const [camOn, setCamOn] = useState(isCameraEnabled);
  const [micBusy, setMicBusy] = useState(false);
  const [camBusy, setCamBusy] = useState(false);

  useEffect(() => { setMicOn(isMicrophoneEnabled); }, [isMicrophoneEnabled]);
  useEffect(() => { setCamOn(isCameraEnabled); }, [isCameraEnabled]);

  // A host muted or unmuted this person: true means "mute".
  useEffect(() => {
    if (hostMuteCommand === null || !honourHostMute) return;
    const target = !hostMuteCommand;
    setHostMuteCommand(null);
    setMicBusy(true);
    setMicOn(target);
    sessionStorage.setItem('rsn_mic', String(target));
    void (async () => {
      try {
        await localParticipant.setMicrophoneEnabled(target);
      } catch {
        // S17 — an unmute can race ahead of the restored publish permission; try once more.
        await new Promise((r) => setTimeout(r, 1200));
        await localParticipant.setMicrophoneEnabled(target).catch(() => {
          setMicOn(localParticipant.isMicrophoneEnabled);
        });
      } finally {
        setMicBusy(false);
      }
    })();
  }, [hostMuteCommand, honourHostMute, localParticipant, setHostMuteCommand]);

  const toggleMic = useCallback(async () => {
    if (micBusy) return;
    const next = !micOn;
    setMicBusy(true);
    try {
      await localParticipant.setMicrophoneEnabled(next);
      setMicOn(next);
      sessionStorage.setItem('rsn_mic', String(next));
    } catch {
      setMicOn(localParticipant.isMicrophoneEnabled);
      if (next) useToastStore.getState().addToast(MIC_FAILED, 'error');
    } finally {
      setMicBusy(false);
    }
  }, [localParticipant, micOn, micBusy]);

  const camStarting = !camBusy && !camOn && bg.cameraCaptured;

  const toggleCam = useCallback(async () => {
    if (camBusy) return;
    const target = !camOn;
    setCamBusy(true);
    setCamOn(target);
    try {
      if (target) await turnCameraOn(room);
      else await localParticipant.setCameraEnabled(false);
    } catch {
      if (target) useToastStore.getState().addToast(CAMERA_FAILED, 'error');
    } finally {
      const actual = localParticipant.isCameraEnabled;
      setCamOn(actual);
      sessionStorage.setItem('rsn_cam', String(actual));
      setCamBusy(false);
    }
  }, [localParticipant, room, camOn, camBusy]);

  return { micOn, camOn, camStarting, micBusy, camBusy, toggleMic, toggleCam };
}
