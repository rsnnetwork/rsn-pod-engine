// What the member has not sent yet: their picks, a time typed into "Another time", and the length and kind the confirm
// card offers. Kept per conversation while the panel is away (another conversation, another page) until it is sent,
// discarded or the page goes.

import { useEffect, useRef, useState } from 'react';
import { useToastStore } from '@/stores/toastStore';
import { hasStarted, isSlotKey, typedSlot } from './scheduler-flow';
import type { Scheduling } from './scheduling-types';

const drafts = new Map<string, { staged: Set<string> | null; duration: string; kind: 'audio' | 'video' }>();

interface DraftOptions {
  conversationId: string;
  data: Scheduling | undefined;
  savedMine: ReadonlySet<string>;
  /** When the server last answered a read of the scheduling. */
  dataUpdatedAt: number;
  /** The day on screen: a typed time is a time on it. */
  dayKey: string;
  zone: string;
  now: number;
  reveal: (key: string, panel: boolean) => void;
}

export function useSchedulerDraft({ conversationId, data, savedMine, dataUpdatedAt, dayKey, zone, now, reveal }: DraftOptions) {
  const addToast = useToastStore(s => s.addToast);
  const [staged, setStaged] = useState<Set<string> | null>(() => drafts.get(conversationId)?.staged ?? null);
  const [durationText, setDurationText] = useState(() => drafts.get(conversationId)?.duration ?? '30');
  const [meetingKind, setMeetingKind] = useState<'audio' | 'video'>(() => drafts.get(conversationId)?.kind ?? 'video');
  const [customTime, setCustomTime] = useState('');
  // "Send your times?" is showing: someone tried to close the panel with times not sent.
  const [asking, setAsking] = useState(false);
  // The member's own saved times as their last save's answer gives them, until a read newer than that answer lands:
  // the save does not wait for the panel's refresh, and the picks must not flick back to the old ones meanwhile.
  const [answered, setAnswered] = useState<{ mine: Set<string>; at: number } | null>(null);
  const draftRef = useRef({ staged, duration: durationText, kind: meetingKind });
  draftRef.current = { staged, duration: durationText, kind: meetingKind };
  useEffect(() => () => { drafts.set(conversationId, draftRef.current); }, [conversationId]);

  // Stage my saved selection once loaded (and re-sync after saves). Legacy
  // day-part picks are not shown or re-saved — they age out.
  useEffect(() => {
    if (data && staged === null) setStaged(new Set(data.mine.filter(isSlotKey)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new answer from the server re-stages; staged is what this sets
  }, [data]);

  const saved: ReadonlySet<string> = answered && answered.at > dataUpdatedAt ? answered.mine : savedMine;
  const mine = staged ?? saved;
  // A time typed into "Another time" counts as picked as soon as it is a time:
  // it is added on blur and on Enter, and Save carries it if neither came.
  const typedKey = customTime ? typedSlot(dayKey, customTime, zone) : null;
  const typed = typedKey && !hasStarted(typedKey, now) && !mine.has(typedKey) ? typedKey : null;
  const stagedChanged = staged !== null &&
    (staged.size !== saved.size || [...saved].some(w => !staged.has(w)));
  const unsaved = stagedChanged || typed !== null;

  const toggle = (key: string) => {
    const next = new Set(mine);
    if (next.has(key)) next.delete(key); else next.add(key);
    setStaged(next);
    setAsking(false);
  };

  const unpick = (key: string) => {
    const next = new Set(mine);
    next.delete(key);
    setStaged(next);
  };

  // Any time of day (Ali, 9 Sep): type it and it becomes a pick in its place
  // on the timeline, scrolled into view. A question already on screen ("Send
  // your times?") stays: the blur that adds the time is not an answer to it.
  const addTypedTime = () => {
    if (!customTime) return;
    const key = typedSlot(dayKey, customTime, zone);
    if (!key) { addToast('Enter a time like 21:30.', 'error'); return; }
    if (hasStarted(key, Date.now())) { addToast('That time has already passed.', 'error'); return; }
    if (!mine.has(key)) setStaged(new Set([...mine, key]));
    setCustomTime('');
    reveal(key, true);
  };

  // Forget what was not sent: this panel's state and the draft kept for it. After a save, its answer stands for what
  // the member has saved until the panel reads the server again.
  const forgetDraft = (answer?: Scheduling) => {
    setStaged(null);
    setCustomTime('');
    setAsking(false);
    setAnswered(answer ? { mine: new Set(answer.mine.filter(isSlotKey)), at: Date.now() } : null);
    drafts.delete(conversationId);
    draftRef.current = { staged: null, duration: durationText, kind: meetingKind };
  };

  return {
    mine, saved, typed, unsaved, asking, setAsking, customTime, setCustomTime,
    durationText, setDurationText, meetingKind, setMeetingKind,
    toggle, unpick, addTypedTime, forgetDraft,
  };
}

export type SchedulerDraft = ReturnType<typeof useSchedulerDraft>;
