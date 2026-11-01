// client/src/hooks/useMessageChime.ts
// A sound when a new message comes in (30 Oct 2026 review, item 4.4, L8), mounted once in App.tsx so it works on every
// signed-in page (the profile and the meeting room are outside the shell). It listens to the one-to-one dm:message and
// to a group's bell (notification:new of type group_message, at most one per group in 10 minutes), and plays at most
// one chime per message across all of the member's open tabs, by the rule in lib/message-chime-policy.ts. No sound for
// meeting requests or any other bell (Stefan asked for messages).
import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { getSocket } from '@/lib/socket';
import { messageSoundOn, playMessageChime, readyAudioOnFirstPress } from '@/lib/chime';
import {
  CHIME_VOTE_WINDOW_MS, chimeFromDm, chimeFromNotification, playsHere, quietHere,
  type ChimeEvent, type ChimeVote, type DmMessageLike, type NotificationLike,
} from '@/lib/message-chime-policy';

const CHANNEL = 'reason-message-chime';
/** How long a message's votes are kept: long after any tab could still be deciding. */
const FORGET_AFTER_MS = 30_000;

type ChannelMessage =
  | { kind: 'vote'; vote: ChimeVote }
  | { kind: 'played'; id: string; at: number };

export function useMessageChime(userId: string | undefined): void {
  const { pathname } = useLocation();
  const where = useRef(pathname);
  where.current = pathname;

  useEffect(() => {
    if (!userId) return;
    const tabId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const votes = new Map<string, ChimeVote[]>();
    const played = new Set<string>();
    let lastPlayedAt: number | null = null;
    const timers = new Set<number>();
    const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;

    const remember = (vote: ChimeVote) => {
      const list = votes.get(vote.id) ?? [];
      if (!list.some((v) => v.tabId === vote.tabId)) list.push(vote);
      votes.set(vote.id, list);
      const t = window.setTimeout(() => { votes.delete(vote.id); timers.delete(t); }, FORGET_AFTER_MS);
      timers.add(t);
    };

    if (channel) {
      channel.onmessage = (e: MessageEvent<ChannelMessage>) => {
        const m = e.data;
        if (m?.kind === 'vote') remember(m.vote);
        if (m?.kind === 'played') {
          played.add(m.id);
          lastPlayedAt = Math.max(lastPlayedAt ?? 0, m.at);
        }
      };
    }

    const consider = (ev: ChimeEvent | null) => {
      if (!ev) return;
      const vote: ChimeVote = {
        id: ev.id,
        tabId,
        quiet: quietHere(ev, { pathname: where.current, visible: document.visibilityState === 'visible', soundOn: messageSoundOn() }),
        visible: document.visibilityState === 'visible',
      };
      remember(vote);
      channel?.postMessage({ kind: 'vote', vote } satisfies ChannelMessage);
      const t = window.setTimeout(() => {
        timers.delete(t);
        const now = Date.now();
        if (!playsHere(votes.get(ev.id) ?? [vote], tabId, { alreadyPlayed: played.has(ev.id), lastPlayedAt, now })) return;
        played.add(ev.id);
        lastPlayedAt = now;
        channel?.postMessage({ kind: 'played', id: ev.id, at: now } satisfies ChannelMessage);
        playMessageChime(ev.id);
      }, CHIME_VOTE_WINDOW_MS);
      timers.add(t);
    };

    const onDm = (msg: DmMessageLike) => consider(chimeFromDm(msg, userId));
    const onBell = (n: NotificationLike) => consider(chimeFromNotification(n));
    const socket = getSocket();
    socket.on('dm:message', onDm);
    socket.on('notification:new', onBell);
    const unready = readyAudioOnFirstPress();

    return () => {
      socket.off('dm:message', onDm);
      socket.off('notification:new', onBell);
      unready();
      for (const t of timers) window.clearTimeout(t);
      channel?.close();
    };
  }, [userId]);
}
