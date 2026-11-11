// Messages page — Phase E of chat-fix-and-dm-system plan (1 May 2026).
//
// Two-pane layout: conversation list (left) + active thread (right).
// On mobile: single-pane, list collapses when a conversation is open.
//
// Real-time updates: subscribes to dm:message, dm:read_receipt,
// dm:conversation_updated. Updates React Query cache so the inbox sort
// + thread view update without polling.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, SmilePlus, Trash2, MessageSquare, CalendarClock, ShieldAlert, Video, Phone, Ban } from 'lucide-react';
import MeetingScheduler, { type SchedulerHandle } from './MeetingScheduler';
import ThreadMeetingBanner from './ThreadMeetingBanner';
import { messageCallAction } from './thread-call-rules';
import { confirmable, isMeetingOver, localizeMeetingText } from './scheduler-flow';
import SystemMessageCard, { type DmMessageKind } from './SystemMessageCard';
import { CallRequestModal } from './CallRequest';
import CallButton from '@/features/calls/CallButton';
import { useCallRequest } from '@/features/calls/useCallRequest';
import OfflineCallSheet from '@/features/calls/OfflineCallSheet';
import { useInboxPresence } from '@/features/calls/usePresence';
import { awayNote, callHint, inboxDot, presenceBadge, stateIn } from '@/features/calls/presence-words';
import Linkify from '@/components/ui/Linkify';
import MeetingRequests, { FocusedMeetingRequest } from './MeetingRequests';
import GroupThread from './GroupThread';
import GroupInboxRow from './GroupInboxRow';
import { useMyGroups } from './useGroups';
import { GROUPS_FAILED, TRY_AGAIN, isRateLimited, mergeInbox } from './group-chat-text';
import { dayHeaderLabel, formatRelative, sameLocalDay, timeOnly } from './message-time';
import { BUBBLE_LINK, bubbleLook, clusterMessages } from './bubble-look';
import ReplyQuote from './ReplyQuote';
import { ReplyButton } from './ReplyStrip';
import { replyContentOf, type ReplyTarget } from './reply-text';
import Avatar from '@/components/ui/Avatar';
import PersonLink from '@/components/people/PersonLink';
import { PageLoader, Spinner } from '@/components/ui/Spinner';
import ReportUserModal, { type ReportSubject } from '@/components/ReportUserModal';
import { BLOCK_MEMBER, REPORT_MEMBER, UNBLOCK, blockConsequence, blockTitle } from '@/components/safety/safety-words';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { getSocket } from '@/lib/socket';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import { useConfirm } from '@/hooks/useConfirm';
import type { DmMessage } from './thread/dm-message';
import type { InviteEmailState } from '@rsn/shared';
import { useThreadMessages } from './thread/useThreadMessages';
import DmComposer from './DmComposer';
import VoiceNotePlayer from './voice/VoiceNotePlayer';
import { dropDraftsTo, moveNewMessageDrafts, threadKeyOf } from './voice/composer-drafts';
import { VOICE_COPY, knownDurationMs } from './voice/voice-note';
import { BlockedThreadBanner, MENU_ITEM, MessageMoreButton, ThreadMoreMenu } from './thread/ThreadSafety';
import PostCallFeedback from './thread/PostCallFeedback';

interface ConversationSummary {
  conversationId: string;
  otherUserId: string;
  otherDisplayName: string | null;
  otherAvatarUrl: string | null;
  // 13 Aug 2026 overhaul (task A5) — "unclear who's messaging you". The
  // header needs more than a name to say WHO is writing.
  otherJobTitle: string | null;
  otherCompany: string | null;
  otherBio: string | null;
  lastMessage: string | null;
  lastMessageAt: string | null;
  lastMessageFromMe: boolean;
  lastMessageKind?: DmMessageKind;
  unreadCount: number;
  /** T2 (1 Nov 2026): their account was removed, suspended or banned. The thread stays; they read "Former member". */
  otherIsFormerMember?: boolean;
}

// Phase E — client-side reaction palette. Server stores type strings so the
// client controls the unicode glyph. Same set as the in-event ChatPanel uses
// for its message reactions, plus laugh/fire/wow which Slack-class chats expect.
const DM_REACTIONS: ReadonlyArray<{ type: string; emoji: string; label: string }> = [
  { type: 'heart', emoji: '❤️', label: 'Love' },
  { type: 'clap', emoji: '👏', label: 'Clap' },
  { type: 'thumbs_up', emoji: '👍', label: 'Thumbs up' },
  { type: 'laugh', emoji: '😂', label: 'Laugh' },
  { type: 'fire', emoji: '🔥', label: 'Fire' },
  { type: 'wow', emoji: '😮', label: 'Wow' },
];

function emojiForType(type: string): string {
  return DM_REACTIONS.find(r => r.type === type)?.emoji || type;
}

export default function MessagesPage() {
  // Feature 18 (13 May spec) — single page renders four modes:
  //   • /messages                     → inbox only (right pane is empty state)
  //   • /messages/:conversationId     → existing thread
  //   • /messages/new/:userId         → compose to a user who isn't in the inbox yet
  //   • /messages/g/:groupId          → a group chat (26 Oct 2026, C12), its own thread (GroupThread)
  // In compose mode the right pane shows the target user's header and an empty
  // thread with the same composer; on first send the server creates the
  // conversation and we replace the URL with the real conversationId.
  const { conversationId: activeId, userId: composeToUserId, groupId } = useParams<{
    conversationId?: string;
    userId?: string;
    groupId?: string;
  }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // The 'X asked to meet you' bell links here as /messages?poke=<id>. Focus that
  // specific request so the recipient sees whose profile to check, instead of
  // landing on the generic page (7 Sep 2026, Ali).
  const focusPokeId = searchParams.get('poke');
  const qc = useQueryClient();
  const { user } = useAuthStore();
  const { addToast } = useToastStore();
  const myUserId = user?.id;
  const { ask, confirmDialog } = useConfirm();
  // The message box's key: who is signed in, and this conversation (or the person a first message is for).
  const threadKey = threadKeyOf(myUserId, { conversationId: activeId, toUserId: composeToUserId });
  // The message being replied to (30 Oct 2026, L7): "Replying to …" above the box until it is sent or cancelled. It is
  // kept with the conversation it was chosen in and shown only there, so another conversation never shows it, not
  // even for the one render an effect resetting it on navigation would take (11 Nov 2026).
  const [reply, setReply] = useState<{ key: string; target: ReplyTarget } | null>(null);
  const replyTarget = reply && reply.key === threadKey ? reply.target : null;
  const clearReply = useCallback(() => setReply(null), []);
  // REASON Phase 2 — "Find a time" panel (availability windows) per thread.
  const [schedulerOpen, setSchedulerOpen] = useState(false);
  // A time on a proposal card asks the panel for that time's confirm card (26 Oct 2026).
  const [confirmRequest, setConfirmRequest] = useState<{ slot: string; at: number } | null>(null);
  // Opened by Reschedule (a meeting's page, ?schedule=1): offered to every pair,
  // also one that has met, and opened ready for the first pick.
  const [rescheduling, setRescheduling] = useState(false);
  // The open panel decides whether it may close: with unsaved times it asks first.
  const schedulerRef = useRef<SchedulerHandle>(null);
  // Task E4 — report entry point for the thread's conversation partner. 11 Nov 2026 (item 16): the member, or one of
  // their messages (`subject`); the sheet is the same, and the person stays in the conversation afterwards.
  const [reporting, setReporting] = useState<{ subject: ReportSubject | null } | null>(null);
  // 4 Sep 2026 (device audit): a guessed calc(100vh - 100px) was taller than the
  // space between the phone header and the bottom nav, so the page scrolled,
  // the thread header's first line (the name) slid away and the composer sat
  // half under the nav. Fill exactly what <main> gives us instead.
  const fillRef = useRef<HTMLDivElement>(null);
  const [fillHeight, setFillHeight] = useState<number | null>(null);
  useEffect(() => {
    const main = fillRef.current?.closest('main') ?? document.querySelector('main');
    if (!main) return;
    const compute = () => {
      const cs = getComputedStyle(main);
      setFillHeight(Math.max(320, main.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(main);
    window.addEventListener('resize', compute);
    return () => { ro.disconnect(); window.removeEventListener('resize', compute); };
  }, [myUserId]);
  // Phase E — which message the reaction picker is currently anchored to.
  const [reactionPickerFor, setReactionPickerFor] = useState<string | null>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Phase E — toggle a reaction on a DM message. Uses socket events so the
  // server fan-out broadcasts to both users at once. Optimistic invalidation
  // happens via the `dm:reaction_added` / `dm:reaction_removed` listeners.
  const toggleReaction = (messageId: string, type: string, alreadyMine: boolean) => {
    const socket = getSocket();
    if (!socket) return;
    socket.emit(alreadyMine ? 'dm:unreact' : 'dm:react', { messageId, emoji: type });
    setReactionPickerFor(null);
  };

  // Inbox: list of conversations sorted by recent activity.
  const { data: inboxData } = useQuery({
    queryKey: ['dm-conversations'],
    queryFn: () => api.get('/dm/conversations').then(r => r.data.data as ConversationSummary[]),
    refetchOnWindowFocus: true,
    meta: { entities: myUserId ? [E.userDms(myUserId)] : [] },
  });

  // The group chats the member is in, listed beside the conversations (26 Oct 2026, C12).
  const groups = useMyGroups();

  // Where every conversation partner is (11 Nov 2026, RSN 07): online, away or offline, pushed by each partner's
  // user:<id>:presence tag, never polled. The inbox dots and the thread header read this ONE query, so they agree.
  const inboxPresence = useInboxPresence(myUserId, inboxData?.map((c) => c.otherUserId) ?? []);

  // Thread: messages in the active conversation, marked read on opening it (features/messages/thread, 1 Nov 2026).
  const { data: messagesData } = useThreadMessages(activeId);

  // Feature 18 — compose-new mode: fetch the target user's profile for the
  // header so the composer doesn't show "User" before the conversation exists.
  const { data: composeTargetUser } = useQuery({
    queryKey: ['user', composeToUserId],
    queryFn: () => api.get(`/users/${composeToUserId}`).then(r => r.data.data),
    enabled: !!composeToUserId,
    meta: { entities: composeToUserId ? [E.user(composeToUserId)] : [] },
  });

  // Feature 18 — if a conversation with this user already exists in the
  // inbox, redirect to it so the back button and refresh don't get stuck
  // on /messages/new/:userId after the first send.
  useEffect(() => {
    if (!composeToUserId || !inboxData) return;
    const existing = inboxData.find(c => c.otherUserId === composeToUserId);
    if (existing) {
      // Anything already written in the new-message box goes with it, to that same conversation (11 Nov 2026).
      if (myUserId) moveNewMessageDrafts(myUserId, composeToUserId, existing.conversationId);
      // What the link asked for goes too (a profile's "Find a time" asks for the scheduler with ?schedule=1).
      const asked = searchParams.toString();
      navigate(`/messages/${existing.conversationId}${asked ? `?${asked}` : ''}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the address's query is read when the redirect happens
  }, [composeToUserId, inboxData, navigate, myUserId]);

  // Nothing can be sent to a former member: what was written to them is dropped, so no hidden note keeps the leave
  // prompt up (11 Nov 2026).
  useEffect(() => {
    inboxData?.filter((c) => c.otherIsFormerMember).forEach((c) => dropDraftsTo(c.otherUserId));
  }, [inboxData]);

  // Real-time subscriptions: refresh inbox + active thread on incoming events.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const onMessage = (msg: DmMessage) => {
      // If it's for the active thread, append + refetch
      if (msg.conversationId === activeId) {
        qc.invalidateQueries({ queryKey: ['dm-messages', activeId] });
      }
      // Always refresh inbox sort + unread badge
      qc.invalidateQueries({ queryKey: ['dm-conversations'] });
      qc.invalidateQueries({ queryKey: ['dm-unread-count'] });
    };
    const onConversationUpdated = () => {
      qc.invalidateQueries({ queryKey: ['dm-conversations'] });
    };
    const onReadReceipt = (data: { conversationId: string }) => {
      if (data.conversationId === activeId) {
        qc.invalidateQueries({ queryKey: ['dm-messages', activeId] });
      }
      qc.invalidateQueries({ queryKey: ['dm-conversations'] });
      qc.invalidateQueries({ queryKey: ['dm-unread-count'] });
    };
    // Phase E — reaction events update the active thread in real time.
    const onReaction = (data: { conversationId: string }) => {
      if (data.conversationId === activeId) {
        qc.invalidateQueries({ queryKey: ['dm-messages', activeId] });
      }
    };

    socket.on('dm:message', onMessage);
    socket.on('dm:conversation_updated', onConversationUpdated);
    socket.on('dm:read_receipt', onReadReceipt);
    socket.on('dm:reaction_added', onReaction);
    socket.on('dm:reaction_removed', onReaction);
    return () => {
      socket.off('dm:message', onMessage);
      socket.off('dm:conversation_updated', onConversationUpdated);
      socket.off('dm:read_receipt', onReadReceipt);
      socket.off('dm:reaction_added', onReaction);
      socket.off('dm:reaction_removed', onReaction);
    };
  }, [activeId, qc]);

  // Auto-scroll to bottom when messages change.
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messagesData]);

  const activeConv = inboxData?.find(c => c.conversationId === activeId);

  // The partner's presence, from the inbox's one read: undefined while it loads and null when unknown, both shown as
  // nothing (never as "Offline"), and neither ever holds the call buttons back (RSN 07).
  const partnerPresence = stateIn(inboxPresence.data, activeConv?.otherUserId);
  const presenceShown = presenceBadge(partnerPresence);

  // Have I blocked them (11 Nov 2026, item 16)? Then the thread stays open, read-only: no message box and no calls,
  // with Unblock in their place. Asked only for a conversation with a member; the block tags answer it at once.
  const otherId = activeConv?.otherUserId;
  const { data: blockStatus } = useQuery({
    queryKey: ['dm-block-status', otherId],
    queryFn: () => api.get(`/users/${otherId}/block-status`).then(r => r.data.data as { hasBlocked: boolean }),
    enabled: !!otherId && !activeConv?.otherIsFormerMember,
    meta: { entities: myUserId && otherId ? [E.userBlocks(myUserId), E.userBlocks(otherId)] : [] },
  });
  const blockedByMe = !!blockStatus?.hasBlocked;

  // 9 Sep 2026 (Ali/Stefan): calls go REQUEST → ACCEPT, with a duration the
  // caller types. "startCall" opens the request dialog; the request itself is
  // sent from there. 1 Nov 2026: the call then lives app-wide (stores/callStore,
  // features/calls/useCallSignals), so its "Calling…" card, the other person's
  // banner and the way into the room no longer depend on this thread staying
  // open. `calling` is true while a call I rang waits for an answer.
  const callRequest = useCallRequest(activeId ? { conversationId: activeId } : null, activeConv?.otherDisplayName ?? null, {
    state: partnerPresence,
    refresh: () => inboxPresence.refetch().then((r) => stateIn(r.data, otherId)),
  });
  const calling = callRequest.ringing;

  const startCall = (kind: 'audio' | 'video') => {
    if (!activeId || calling) return;
    callRequest.open(kind);
  };

  // Block the conversation partner (8 Sep 2026, Ali). Blocking stops future messages, calls and matches (enforced
  // server-side). 11 Nov 2026 (item 16): what it does is said before it is done, and the person stays in the thread,
  // which turns read-only (the block-status read, refreshed by the block tag).
  const [unblocking, setUnblocking] = useState(false);
  const blockUser = async (userId: string, name: string | null) => {
    if (!(await ask({ title: blockTitle(name), body: blockConsequence(name), confirmLabel: 'Block', tone: 'danger' }))) return;
    try {
      await api.post(`/users/${userId}/block`, {});
      dropDraftsTo(userId);
      addToast(`You blocked ${name || 'this person'}.`, 'success');
      void qc.invalidateQueries({ queryKey: ['dm-block-status', userId] });
    } catch (e: any) {
      addToast(e?.response?.data?.error?.message || 'Could not block this person.', 'error');
    }
  };
  const unblockUser = async (userId: string, name: string | null) => {
    if (unblocking) return;
    setUnblocking(true);
    try {
      await api.delete(`/users/${userId}/block`);
      addToast(`You unblocked ${name || 'this person'}.`, 'success');
      void qc.invalidateQueries({ queryKey: ['dm-block-status', userId] });
    } catch (e: any) {
      addToast(e?.response?.data?.error?.message || 'Could not unblock this person.', 'error');
    } finally {
      setUnblocking(false);
    }
  };

  // W-meet (8 Sep 2026) — a dot on the calendar icon when the partner changed
  // their availability since I last opened the scheduler. The dm-conversation
  // entity makes this live; the flag is server-computed so it survives refresh.
  const { data: scheduling } = useQuery({
    queryKey: ['meetingScheduling', activeId],
    queryFn: () => api.get(`/dm/conversations/${activeId}/scheduling`).then(r => r.data.data as {
      schedulingUpdated?: boolean;
      callsUnlocked?: boolean;
      canCall?: boolean;
      overlap?: string[];
      confirmed?: {
        type?: 'audio' | 'video' | null; startAt?: string | null; durationMin?: number | null;
        inviteEmail?: InviteEmailState | null;
      } | null;
    }),
    enabled: !!activeId,
    meta: { entities: activeId ? [E.dmConversation(activeId)] : [] },
  });
  // 9 Sep 2026 (Ali): until this pair's first scheduled meeting has happened,
  // the chat offers the scheduler and NOT calls; once it has, calls appear and
  // the scheduler steps aside.
  const callsUnlocked = !!scheduling?.callsUnlocked;
  // 1 Nov 2026 (30 Oct review item 4): a connection can ring for VIDEO with no meeting held first. Audio keeps
  // the 9 Sep rule (callsUnlocked), and so does the scheduler's place in the chat.
  const canCall = !!scheduling?.canCall;
  const availabilityDot = !!scheduling?.schedulingUpdated && !schedulerOpen && !callsUnlocked;
  const confirmedCallKind: 'audio' | 'video' = scheduling?.confirmed?.type === 'audio' ? 'audio' : 'video';
  // A scheduled meeting whose window has ended behaves like an instant call
  // ("Call now") rather than "Join" (Ali, 8 Sep 2026).
  const confirmedMeetingOver = isMeetingOver(scheduling?.confirmed?.startAt, scheduling?.confirmed?.durationMin);

  // A system line in the thread gets its own action button (Ali, 8 Sep 2026):
  //  - a SCHEDULED meeting ("Meeting confirmed …") → "Join meeting" (enter the room)
  //  - an INSTANT "Meet now" ("Started a … call") that's already over → "Call
  //    again" / "Call back" (re-initiate the call), NOT "join", since there's no
  //    standing room to join.
  const meetingActionForMessage = (
    content: string | null | undefined,
  ): { kind: 'audio' | 'video'; scheduled: boolean } | null => {
    if (!content) return null;
    if (content.includes('Meeting confirmed')) return { kind: confirmedCallKind, scheduled: true };
    const m = content.match(/Started an? (audio|video) call/i);
    if (m) return { kind: m[1].toLowerCase() as 'audio' | 'video', scheduled: false };
    return null;
  };

  // Opening the scheduler clears the dot (marks it seen server-side). The dot
  // is a nicety: if marking it fails, the panel is open all the same.
  const markSchedulerSeen = () => {
    if (!activeId) return;
    api.post(`/dm/conversations/${activeId}/scheduling/seen`)
      .then(() => qc.invalidateQueries({ queryKey: ['meetingScheduling', activeId] }))
      .catch(() => {});
  };

  // Asking the panel to close, not closing it: with times not sent it says
  // "Send your times?" instead (26 Oct 2026; they used to be dropped silently).
  const closeScheduler = useCallback(() => {
    if (!schedulerRef.current) { setSchedulerOpen(false); return; }
    schedulerRef.current.requestClose();
  }, []);

  // The header's calendar button opens the panel, and closes it again.
  const openScheduler = () => {
    if (schedulerOpen) { closeScheduler(); return; }
    setConfirmRequest(null);
    setRescheduling(false);
    setSchedulerOpen(true);
    markSchedulerSeen();
  };

  // The offline sheet's Find a time (RSN 07): the scheduler, for every pair, as Reschedule opens it.
  const findATime = () => {
    callRequest.closeOffline();
    setConfirmRequest(null);
    setRescheduling(true);
    setSchedulerOpen(true);
    markSchedulerSeen();
  };
  // Its Send a message: the box takes the focus.
  const sendAMessage = () => {
    callRequest.closeOffline();
    textareaRef.current?.focus();
  };

  // A thread card's button: a proposal's time opens the panel on that time's
  // confirm card; "See all times" and "Add my times" just open it.
  const openSchedulerOn = (slot: string | null) => {
    if (slot) setConfirmRequest({ slot, at: Date.now() });
    if (schedulerOpen) return;
    if (!slot) setConfirmRequest(null);
    setSchedulerOpen(true);
    markSchedulerSeen();
  };

  // Another conversation: its own panel, closed (an unsent pick stays as that
  // conversation's draft and is back when its panel opens again).
  useEffect(() => {
    setSchedulerOpen(false);
    setConfirmRequest(null);
    setRescheduling(false);
  }, [activeId]);

  // Reschedule on a meeting's page opens this chat with ?schedule=1: open the
  // panel, once, then drop the flag by replacing the entry, so Back or a
  // refresh does not open it again. It opens for every pair: one that has met
  // has calls instead of the scheduler, and Reschedule would land on nothing.
  const wantsScheduler = searchParams.get('schedule') === '1';
  // Back from a call (11 Nov 2026, RSN 08): ?feedback=<meetingId> asks how it went over this thread, once. The flag is
  // dropped by replacing the address, so Back or a refresh never asks again.
  const feedbackFor = activeId ? searchParams.get('feedback') : null;
  const feedbackDone = useCallback(() => {
    setSearchParams((now) => {
      const next = new URLSearchParams(now);
      next.delete('feedback');
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  useEffect(() => {
    if (!wantsScheduler || !activeId || !scheduling) return;
    setConfirmRequest(null);
    setRescheduling(true);
    setSchedulerOpen(true);
    markSchedulerSeen();
    const next = new URLSearchParams(searchParams);
    next.delete('schedule');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the flag is there and the scheduling has loaded
  }, [wantsScheduler, activeId, scheduling]);

  // The scheduler closes on a click anywhere outside it, or Escape (Ali,
  // 9 Sep) — like a menu. Its toggle is excluded so the click that closes
  // it doesn't reopen it, and so are the thread cards' buttons that open or
  // point it (a card's time pressed with the panel open used to close it and
  // reopen it empty, which looked like nothing happened).
  useEffect(() => {
    if (!schedulerOpen) return;
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t?.closest('[data-scheduler-panel],[data-scheduler-toggle],[data-scheduler-trigger]')) return;
      closeScheduler();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeScheduler(); };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [schedulerOpen, closeScheduler]);

  // Feature 18 — derive an "effective active context" so the thread view and
  // composer can render uniformly whether we're in an existing thread or
  // composing a new one. composeTarget supplies the header info when we
  // don't have a conversation row yet.
  const isComposeMode = !!composeToUserId && !activeId;
  // The right pane holds a thread: a conversation, a new message, or a group chat. On a phone it then
  // takes the screen, and the inbox list steps aside.
  const threadShown = !!activeId || isComposeMode || !!groupId;
  const composeTarget = composeToUserId && composeTargetUser
    ? {
        otherUserId: composeToUserId,
        otherDisplayName: composeTargetUser.displayName ?? null,
        otherAvatarUrl: composeTargetUser.avatarUrl ?? null,
        // 13 Aug 2026 overhaul (task A5) — /users/:id already returns these
        // public profile fields for non-owner viewers, so compose-new mode
        // gets the same "who is this" context as an existing conversation.
        otherJobTitle: composeTargetUser.jobTitle ?? null,
        otherCompany: composeTargetUser.company ?? null,
        otherBio: composeTargetUser.bio ?? null,
      }
    : null;
  const headerContext: {
    otherUserId: string;
    otherDisplayName: string | null;
    otherAvatarUrl: string | null;
    otherJobTitle: string | null;
    otherCompany: string | null;
    otherBio: string | null;
  } | null = activeConv ?? composeTarget;
  // T2 (1 Nov 2026): a former member's thread keeps its messages, links to no profile and takes no new ones.
  const otherIsFormer = !!activeConv?.otherIsFormerMember;
  // Nothing can be sent to them and they cannot be called: a former member, or someone I blocked (11 Nov 2026).
  const readOnly = otherIsFormer || blockedByMe;

  // The box took the focus: a phone keyboard is opening, and the thread could scroll out from under it (Phase A).
  const pinNewest = () => { setTimeout(() => threadEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 250); };

  // Reply (30 Oct 2026, L7): the strip above the box names the message, and the box takes the focus for the answer.
  const replyTo = (m: DmMessage, fromMe: boolean) => {
    if (!threadKey) return;
    setReply({ key: threadKey, target: {
      id: m.id,
      senderName: fromMe ? (user?.displayName ?? '') : (headerContext?.otherDisplayName ?? ''),
      content: replyContentOf(m),
      mine: fromMe,
    } });
    textareaRef.current?.focus();
  };

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/dm/conversations/${id}`),
    onSuccess: (_res, id) => {
      // What was written in it and not sent goes with it.
      const partner = inboxData?.find((c) => c.conversationId === id)?.otherUserId;
      if (partner) dropDraftsTo(partner);
      addToast('Conversation deleted', 'info');
      qc.invalidateQueries({ queryKey: ['dm-conversations'] });
      navigate('/messages');
    },
    onError: (err: any) => {
      addToast(err?.response?.data?.error?.message || 'Failed to delete', 'error');
    },
  });

  if (!myUserId) return <PageLoader />;

  // The first message to someone made the conversation: its address replaces /messages/new/:userId (Feature 18), and
  // what is still unsent in the box moves with it.
  const firstSent = (conversationId: string) => {
    if (composeToUserId) moveNewMessageDrafts(myUserId, composeToUserId, conversationId);
    navigate(`/messages/${conversationId}`, { replace: true });
  };

  // One list: the conversations and the group chats, the latest activity first (26 Oct 2026, C12).
  const inboxRows = inboxData ? mergeInbox(inboxData, groups.data ?? []) : [];
  // The group list could not be read: it failed, or a 429 is being waited out. Said, with a retry, only when there is no
  // list to show; a list already shown stays as it was until the next read succeeds.
  const groupsUnavailable = !groups.data && (groups.isError || isRateLimited(groups.failureReason));

  return (
    <div ref={fillRef} className="flex min-h-0 flex-col lg:flex-row gap-4" style={{ height: fillHeight ?? 'calc(100dvh - 100px)' }}>
      {/* Conversation list (left, hidden on mobile when a thread is open or a new
          message is being written: stacked above the compose panel it left the
          message box under the bottom bar on a short phone) */}
      <div className={`lg:w-80 lg:flex-shrink-0 bg-white rounded-xl border border-gray-200 overflow-hidden ${threadShown ? 'hidden lg:flex' : 'flex'} flex-col`}>
        <div className="px-4 py-3 border-b border-gray-200 flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-gray-500" />
          <h2 className="text-sm font-semibold text-[#1a1a2e]">Messages</h2>
        </div>
        <div className="flex-1 overflow-y-auto">
          {/* Pending meeting requests sit above the inbox — this is the page the
              'poke' notification links to, so the accept must live here. */}
          <MeetingRequests myUserId={myUserId} focusPokeId={focusPokeId} />
          {/* Group chats that could not be read are said, with a retry; the conversations still show. */}
          {groupsUnavailable && (
            <div role="alert" className="flex items-center justify-between gap-3 border-b border-gray-100 px-4 py-1 text-xs text-gray-600">
              <span>{GROUPS_FAILED}</span>
              <button
                type="button"
                onClick={() => { void groups.refetch(); }}
                className="min-h-[44px] shrink-0 rounded-lg px-3 font-semibold text-rsn-red hover:bg-rsn-red/5"
              >
                {TRY_AGAIN}
              </button>
            </div>
          )}
          {inboxData === undefined || (groups.isPending && !groupsUnavailable) ? (
            <div className="flex items-center justify-center py-12"><Spinner /></div>
          ) : inboxRows.length === 0 ? (
            <div className="text-center py-12 px-4 text-sm text-gray-500">
              No conversations yet. When you accept a meeting request — or someone accepts yours — the chat opens here.
            </div>
          ) : (
            inboxRows.map((row) => {
              if (row.kind === 'group') {
                return <GroupInboxRow key={row.key} group={row.group} active={groupId === row.group.id} myUserId={myUserId} />;
              }
              const c = row.conversation;
              return (
                <Link
                  key={row.key}
                  to={`/messages/${c.conversationId}`}
                  className={`flex items-center gap-3 px-4 py-3 hover:bg-gray-50 border-b border-gray-100 transition-colors ${activeId === c.conversationId ? 'bg-rsn-red/5' : ''}`}
                >
                  {/* Presence dot on the avatar (8 Sep 2026; 11 Nov 2026, RSN 07): green when this partner is
                      online, amber when away, none when offline or not known. The header reads the same query. */}
                  <span className="relative shrink-0">
                    <Avatar src={c.otherAvatarUrl || undefined} name={c.otherDisplayName || 'User'} size="md" />
                    {(() => {
                      const seen = stateIn(inboxPresence.data, c.otherUserId);
                      const dot = inboxDot(seen);
                      const badge = presenceBadge(seen);
                      return dot && badge ? (
                        <span
                          className={`absolute bottom-0 right-0 h-3 w-3 rounded-full ${dot} ring-2 ring-white`}
                          title={badge.label}
                          aria-label={badge.label}
                          data-testid="inbox-presence-dot"
                        />
                      ) : null;
                    })()}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between">
                      <p className="text-sm font-medium text-[#1a1a2e] truncate">{c.otherDisplayName || 'User'}</p>
                      {c.lastMessageAt && <span className="text-[11px] text-gray-400 flex-shrink-0 ml-2">{formatRelative(c.lastMessageAt)}</span>}
                    </div>
                    {/* 13 Aug 2026 overhaul (task A5 review fix) — the inbox row, not
                        the thread header, is a stranger's FIRST encounter with a new
                        sender. listConversations() already returns otherJobTitle /
                        otherCompany over the wire; this line is what stops them being
                        dead payload weight. Own <p>, own truncate — it can never
                        collide with the timestamp on the row above, which lives in a
                        separate flex row. Bio deliberately excluded here (row density
                        + it already lives in the thread header). */}
                    {(c.otherJobTitle || c.otherCompany) && (
                      <p className="truncate text-xs text-gray-500">
                        {[c.otherJobTitle, c.otherCompany].filter(Boolean).join(' · ')}
                      </p>
                    )}
                    <p className={`text-xs truncate ${c.unreadCount > 0 && !c.lastMessageFromMe ? 'font-semibold text-[#1a1a2e]' : 'text-gray-500'}`}>
                      {c.lastMessageFromMe && c.lastMessageKind !== 'system' ? 'You: ' : ''}{c.lastMessage ? localizeMeetingText(c.lastMessage) : <em className="text-gray-300">No messages yet</em>}
                    </p>
                  </div>
                  {c.unreadCount > 0 && !c.lastMessageFromMe && (
                    <span className="bg-rsn-red text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
                      {c.unreadCount > 99 ? '99+' : c.unreadCount}
                    </span>
                  )}
                </Link>
              );
            })
          )}
        </div>
      </div>

      {/* Thread view (right) */}
      <div className={`flex-1 bg-white rounded-xl border border-gray-200 overflow-hidden ${threadShown ? 'flex' : 'hidden lg:flex'} flex-col`}>
        {groupId ? (
          <GroupThread key={groupId} groupId={groupId} />
        ) : !headerContext ? (
          composeToUserId ? (
            <>
              {/* The inbox list is hidden on a phone while composing, so the way back is
                  here too: before the person has loaded, and if they never do. */}
              <div className="px-4 py-3 border-b border-gray-200 lg:hidden">
                <button
                  onClick={() => navigate('/messages')}
                  className="-ml-2 flex h-11 w-11 items-center justify-center rounded-lg hover:bg-gray-100"
                  aria-label="Back to inbox"
                >
                  <ArrowLeft className="h-4 w-4 text-gray-500" />
                </button>
              </div>
              <div className="flex-1 flex items-center justify-center px-6"><Spinner /></div>
            </>
          ) : (focusPokeId && myUserId) ? (
            // Landed from the bell's "X asked to meet you" — show that person's
            // profile card with Accept / Decline right here (7 Sep 2026, Ali).
            <FocusedMeetingRequest pokeId={focusPokeId} myUserId={myUserId} />
          ) : (
            <div className="flex-1 flex items-center justify-center text-sm text-gray-500 px-6 text-center">
              Select a conversation to start chatting.
            </div>
          )
        ) : (
          <>
            {/* Thread header */}
            <div className="px-4 py-3 border-b border-gray-200 flex items-center gap-3">
              <button
                onClick={() => navigate('/messages')}
                className="lg:hidden -ml-2 flex h-11 w-11 items-center justify-center rounded-lg hover:bg-gray-100"
                aria-label="Back to inbox"
              >
                <ArrowLeft className="h-4 w-4 text-gray-500" />
              </button>
              {/* 13 Aug 2026 overhaul (task A5) — "unclear who's messaging you".
                  The name-only link is now bold + prominent, and job title /
                  company / bio give the recipient a sense of who this is
                  before they even open the thread. truncate + line-clamp-2
                  keep this from overflowing at 360px.
                  30 Oct 2026 (L7, "names should be clickable"): the picture and the
                  name are one link to the profile, and say so on every width. */}
              <PersonLink
                userId={headerContext.otherUserId}
                from="Messages"
                former={otherIsFormer}
                className="group/person flex min-w-0 flex-1 items-center gap-3 rounded-lg hover:opacity-80"
                title={`View ${headerContext.otherDisplayName || 'their'} profile`}
              >
                <Avatar src={headerContext.otherAvatarUrl || undefined} name={headerContext.otherDisplayName || 'User'} size="sm" />
                <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span data-testid="thread-partner-name" className="truncate text-sm font-bold text-[#1a1a2e] group-hover/person:underline">
                    {headerContext.otherDisplayName || 'User'}
                  </span>
                  {!otherIsFormer && (
                    <span className="shrink-0 text-[11px] font-medium text-gray-500">View profile ›</span>
                  )}
                </span>
                {/* Presence (8 Sep 2026; 11 Nov 2026, RSN 07): Online, Away or Offline, and nothing at all until it
                    is known, so a thread that is still loading never reads as "Offline". */}
                {activeConv && !readOnly && presenceShown && (
                  <span
                    className="flex items-center gap-1 text-[11px]"
                    data-testid="partner-presence"
                    data-state={partnerPresence ?? undefined}
                  >
                    <span className={`h-2 w-2 rounded-full ${presenceShown.dot}`} aria-hidden="true" />
                    <span className={presenceShown.text}>{presenceShown.label}</span>
                  </span>
                )}
                {(headerContext.otherJobTitle || headerContext.otherCompany) && (
                  <p className="truncate text-xs text-gray-500">
                    {[headerContext.otherJobTitle, headerContext.otherCompany].filter(Boolean).join(' · ')}
                  </p>
                )}
                {headerContext.otherBio && (
                  <p className="mt-0.5 line-clamp-1 sm:line-clamp-2 text-xs text-gray-400">{headerContext.otherBio}</p>
                )}
                {otherIsFormer && <p className="text-xs text-gray-500" data-testid="former-member-header">No longer a member of REASON</p>}
                </span>
              </PersonLink>
              <div className="hidden sm:flex items-center gap-1">
              {/* Video: any connection (canCall, 1 Nov 2026). Audio: once the pair's first meeting has happened (Ali,
                  9 Sep). Never to a former member (T2) or someone I blocked. 11 Nov 2026 (RSN 07): never disabled for
                  presence, only while a call of mine rings; pressed while they are offline, the offline sheet opens. */}
              {activeConv && !readOnly && canCall && (
                <CallButton
                  variant="icon"
                  onClick={() => startCall('video')}
                  disabled={calling}
                  title={callHint(partnerPresence, headerContext.otherDisplayName)}
                />
              )}
              {activeConv && !readOnly && callsUnlocked && (
                <button
                  onClick={() => startCall('audio')}
                  disabled={calling}
                  className="flex h-11 w-11 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-rsn-red disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-400"
                  title={callHint(partnerPresence, headerContext.otherDisplayName, 'Audio call')}
                  aria-label="Start an audio call now"
                >
                  <Phone className="h-4 w-4" />
                </button>
              )}
              {/* REASON Phase 2 — arrange a time to meet (availability windows).
                  A red dot appears when the partner changed their availability
                  since I last opened this (W-meet, 8 Sep 2026). */}
              {activeConv && !readOnly && !callsUnlocked && (
                <button
                  onClick={openScheduler}
                  data-scheduler-toggle
                  className={`relative flex h-11 w-11 items-center justify-center rounded-lg transition-colors ${
                    schedulerOpen ? 'bg-rsn-red-light text-rsn-red' : 'hover:bg-gray-100 text-gray-400 hover:text-gray-600'
                  }`}
                  title={availabilityDot ? 'They updated their availability' : 'Find a time to meet'}
                  aria-label={availabilityDot ? 'They updated their availability — find a time to meet' : 'Find a time to meet'}
                >
                  <CalendarClock className="h-4 w-4" />
                  {availabilityDot && (
                    <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-rsn-red ring-2 ring-white" aria-hidden="true" />
                  )}
                </button>
              )}
              </div>
              {/* 11 Nov 2026 (item 16): Report member, Block member and Delete conversation live in one labelled menu at
                  every width, never as lone icons (the Flag read as an Outlook follow-up marker). On a phone it also
                  holds the calls and Find a time, so the name keeps the width it needs. */}
              <ThreadMoreMenu dot={availabilityDot && !readOnly}>
                {(close) => (
                  <>
                    {activeConv && !readOnly && canCall && (
                      <div className="sm:hidden">
                        <CallButton
                          variant="menu"
                          disabled={calling}
                          onClick={() => { close(); startCall('video'); }}
                          title={callHint(partnerPresence, headerContext.otherDisplayName)}
                          note={partnerPresence === 'away' ? awayNote(headerContext.otherDisplayName) : undefined}
                        />
                      </div>
                    )}
                    {activeConv && !readOnly && callsUnlocked && (
                      <button type="button" role="menuitem" disabled={calling}
                        onClick={() => { close(); startCall('audio'); }}
                        className={`${MENU_ITEM} disabled:opacity-40 sm:hidden`}>
                        <Phone className="h-4 w-4 text-gray-400" /> Audio call
                      </button>
                    )}
                    {activeConv && !readOnly && !callsUnlocked && (
                      <button type="button" role="menuitem" onClick={() => { close(); openScheduler(); }}
                        data-scheduler-toggle
                        className={`${MENU_ITEM} sm:hidden`}>
                        <CalendarClock className="h-4 w-4 text-gray-400" /> Find a time to meet
                        {availabilityDot && <span className="ml-auto h-2 w-2 rounded-full bg-rsn-red" aria-hidden="true" />}
                      </button>
                    )}
                    {/* headerContext.otherUserId is never myUserId via normal navigation; the guard is a backstop. */}
                    {headerContext.otherUserId !== myUserId && (
                      <button type="button" role="menuitem" onClick={() => { close(); setReporting({ subject: null }); }}
                        className={MENU_ITEM} data-testid="report-member">
                        <ShieldAlert className="h-4 w-4 text-gray-400" aria-hidden="true" /> {REPORT_MEMBER}
                      </button>
                    )}
                    {headerContext.otherUserId !== myUserId && !otherIsFormer && (
                      blockedByMe ? (
                        <button type="button" role="menuitem" onClick={() => { close(); void unblockUser(headerContext.otherUserId, headerContext.otherDisplayName); }}
                          className={MENU_ITEM} data-testid="unblock-member">
                          <Ban className="h-4 w-4 text-gray-400" aria-hidden="true" /> {UNBLOCK}
                        </button>
                      ) : (
                        <button type="button" role="menuitem" onClick={() => { close(); void blockUser(headerContext.otherUserId, headerContext.otherDisplayName); }}
                          className={`${MENU_ITEM} text-red-600 hover:bg-red-50`} data-testid="block-member">
                          <Ban className="h-4 w-4" aria-hidden="true" /> {BLOCK_MEMBER}
                        </button>
                      )
                    )}
                    {/* Delete is only available for existing conversations (compose-new mode has nothing to delete). */}
                    {activeConv && (
                      <button type="button" role="menuitem"
                        onClick={() => {
                          close();
                          void ask({ title: 'Delete this conversation?', body: "It goes from your Messages only. The other person's view is unaffected.", confirmLabel: 'Delete', tone: 'danger' })
                            .then((yes) => { if (yes) deleteMutation.mutate(activeConv.conversationId); });
                        }}
                        className={`${MENU_ITEM} text-red-600 hover:bg-red-50`}>
                        <Trash2 className="h-4 w-4" aria-hidden="true" /> Delete conversation
                      </button>
                    )}
                  </>
                )}
              </ThreadMoreMenu>
            </div>

            {/* Report member or message (11 Nov 2026, item 16). An "Also block" keeps the person here: the thread
                turns read-only behind the sheet, whose "Report sent" stays until it is closed. */}
            <ReportUserModal
              open={!!reporting}
              onClose={() => setReporting(null)}
              reportedId={headerContext.otherUserId}
              reportedDisplayName={headerContext.otherDisplayName}
              conversationId={activeConv?.conversationId}
              subject={reporting?.subject ?? null}
              alreadyBlocked={blockedByMe || otherIsFormer}
              onBlocked={() => { void qc.invalidateQueries({ queryKey: ['dm-block-status', headerContext.otherUserId] }); }}
            />

            {/* Request a call: pick video/audio + type a duration (Ali, 9 Sep). */}
            {/* Audio is offered only once calls are unlocked; before that a call is video. */}
            <CallRequestModal {...callRequest.modal} videoOnly={!callsUnlocked} />
            {/* Pressed while they are offline, or the ring refused because they just went (RSN 07). */}
            <OfflineCallSheet
              {...callRequest.offline}
              name={headerContext.otherDisplayName}
              onFindATime={readOnly ? undefined : findATime}
              onSendMessage={sendAMessage}
            />
            {/* Back from a call: how did it go, over the thread, with "Not now" (RSN 08). */}
            {activeId && feedbackFor && <PostCallFeedback key={feedbackFor} meetingId={feedbackFor} onDone={feedbackDone} />}

            {/* Confirmed meeting — always pinned so both people see it in the
                chat, with Join, not buried in the scheduler (Ali, 8 Sep 2026). */}
            {activeConv && <ThreadMeetingBanner conversationId={activeConv.conversationId} onCallNow={startCall} former={readOnly} canCall={canCall} />}


            {/* Availability grid — collapsible so the thread stays primary. Gone
                once calls are unlocked (the first meeting has happened), except
                when Reschedule opened it (26 Oct 2026).
                min-h-0: this column has a fixed height and clips its overflow,
                so the panel must be allowed to shrink and scroll inside itself.
                Without it the panel kept its full height and pushed "Confirm
                meeting", Save and the message box past the clip edge on any
                laptop-height window (Stefan + Shradha, 19 Sep 2026). */}
            {activeConv && !readOnly && schedulerOpen && (!callsUnlocked || rescheduling) && (
              <div data-scheduler-panel className="flex min-h-0 flex-col">
                <MeetingScheduler
                  key={activeConv.conversationId}
                  ref={schedulerRef}
                  conversationId={activeConv.conversationId}
                  confirmRequest={confirmRequest}
                  focusFirstPick={rescheduling}
                  onClose={() => { setSchedulerOpen(false); setConfirmRequest(null); setRescheduling(false); }}
                />
              </div>
            )}

            {/* Messages — clustered by sender + day. In compose-new mode there's
                no conversation yet, so we render the empty-state and let the
                composer below handle the first send. */}
            <div className="flex-1 overflow-y-auto px-4 py-3">
              {isComposeMode ? (
                <div className="text-center py-8 text-sm text-gray-500">No messages yet — say hi!</div>
              ) : messagesData === undefined ? (
                <div className="flex items-center justify-center py-8"><Spinner /></div>
              ) : messagesData.length === 0 ? (
                <div className="text-center py-8 text-sm text-gray-500">No messages yet — say hi!</div>
              ) : (
                (() => {
                  // Server returns newest-first; we render oldest-first.
                  const oldest = [...messagesData].reverse();
                  // A quote can bring its original into view only when that message is on the page.
                  const loadedIds = new Set(oldest.map((x) => x.id));
                  const clusters = clusterMessages(oldest);
                  const elements: ReactNode[] = [];
                  let prevClusterDate: Date | null = null;

                  clusters.forEach((cluster, ci) => {
                    const firstDate = new Date(cluster.messages[0].createdAt);
                    const lastMsg = cluster.messages[cluster.messages.length - 1];
                    const lastDate = new Date(lastMsg.createdAt);

                    // Day separator when the cluster crosses a day boundary
                    if (!prevClusterDate || !sameLocalDay(firstDate, prevClusterDate)) {
                      elements.push(
                        <div key={`day-${cluster.messages[0].id}`} className="flex items-center justify-center py-3">
                          <span className="text-[11px] font-medium text-gray-500 bg-gray-100 px-2.5 py-0.5 rounded-full">
                            {dayHeaderLabel(firstDate)}
                          </span>
                        </div>,
                      );
                    }

                    // A card the product wrote: one neutral block, identical
                    // for both people, outside the bubble machinery entirely.
                    if (cluster.messages[0].kind === 'system') {
                      const m = cluster.messages[0];
                      elements.push(
                        <div key={m.id} data-message-id={m.id}>
                          <SystemMessageCard
                            content={localizeMeetingText(m.content)}
                            meta={m.systemMeta}
                            liveSlots={scheduling ? confirmable(scheduling.overlap ?? [], Date.now()) : undefined}
                            meetingConfirmed={!!scheduling?.confirmed}
                            onOpenScheduler={readOnly ? undefined : () => openSchedulerOn(null)}
                            onPickSlot={readOnly ? undefined : (slot) => openSchedulerOn(slot)}
                            calendar={!readOnly && m.systemMeta?.type === 'meeting_confirmed' && activeId ? { conversationId: activeId, partnerName: headerContext.otherDisplayName || 'your match', inviteEmail: scheduling?.confirmed?.inviteEmail } : undefined}
                            onCallNow={readOnly ? undefined : startCall}
                            callsUnlocked={callsUnlocked}
                            canCall={canCall}
                            former={readOnly}
                            meetingOver={confirmedMeetingOver}
                            currentMeeting={scheduling ? (scheduling.confirmed ? { startAt: scheduling.confirmed.startAt ?? null } : null) : undefined}
                            viewerId={myUserId}
                            partnerName={headerContext?.otherDisplayName?.trim().split(/\s+/)[0]}
                          />
                        </div>,
                      );
                      prevClusterDate = lastDate;
                      return;
                    }

                    const fromMe = cluster.senderId === myUserId;

                    elements.push(
                      <div
                        key={cluster.messages[0].id}
                        className={`flex items-end gap-2 ${fromMe ? 'justify-end' : 'justify-start'} ${ci > 0 ? 'mt-3' : ''}`}
                      >
                        {!fromMe && (
                          <PersonLink
                            userId={headerContext.otherUserId}
                            from="Messages"
                            former={otherIsFormer}
                            className="-m-1.5 flex-shrink-0 rounded-full p-1.5"
                            title={`View ${headerContext.otherDisplayName || 'their'} profile`}
                          >
                            <Avatar
                              src={headerContext.otherAvatarUrl || undefined}
                              name={headerContext.otherDisplayName || 'User'}
                              size="sm"
                            />
                          </PersonLink>
                        )}
                        <div className={`flex flex-col max-w-[75%] sm:max-w-[60%] ${fromMe ? 'items-end' : 'items-start'}`}>
                          {cluster.messages.map((m, idx) => {
                            const isLast = idx === cluster.messages.length - 1;
                            const reactions = m.reactions || {};
                            const reactionEntries = Object.entries(reactions).filter(([, ids]) => ids.length > 0);
                            const hasReactions = reactionEntries.length > 0;
                            const pickerOpen = reactionPickerFor === m.id;
                            return (
                              <div
                                key={m.id}
                                data-message-id={m.id}
                                className={`group/bubble relative flex ${fromMe ? 'flex-row-reverse' : 'flex-row'} items-center gap-1 ${idx > 0 ? 'mt-0.5' : ''} ${hasReactions ? 'mb-3' : ''}`}
                              >
                                <div
                                  data-testid={fromMe ? 'bubble-own' : 'bubble-theirs'}
                                  className={`text-sm break-words whitespace-pre-wrap rounded-2xl ${bubbleLook(fromMe)} ${
                                    isLast ? (fromMe ? 'rounded-br-sm' : 'rounded-bl-sm') : ''
                                  } ${m.attachmentUrl ? 'overflow-hidden' : 'px-3.5 py-2'}`}
                                >
                                  {/* The message it answers (30 Oct 2026, L7). */}
                                  {m.replyTo && (
                                    <div className={m.attachmentUrl ? 'px-2 pt-2' : ''}>
                                      <ReplyQuote quote={m.replyTo} loaded={loadedIds.has(m.replyTo.id)} mine={fromMe} />
                                    </div>
                                  )}
                                  {/* Feature 19 (13 May spec) — render the
                                      image inside the bubble. The bubble's
                                      padding is dropped when an image is
                                      present so the image goes edge-to-edge;
                                      a caption (if any) re-applies padding. */}
                                  {m.attachmentUrl && m.attachmentType === 'image' && (
                                    <a href={m.attachmentUrl} target="_blank" rel="noopener noreferrer" className="block">
                                      <img
                                        src={m.attachmentUrl}
                                        alt={m.content || 'Image attachment'}
                                        width={m.attachmentMeta?.width || undefined}
                                        height={m.attachmentMeta?.height || undefined}
                                        loading="lazy"
                                        className="max-w-[280px] sm:max-w-[320px] max-h-[400px] w-auto h-auto object-contain block"
                                      />
                                    </a>
                                  )}
                                  {/* A voice note (Feature 20; 11 Nov 2026, RSN 06): its length, the time played and a
                                      progress bar, held at its real length; your own says Sent. */}
                                  {m.attachmentUrl && m.attachmentType === 'audio' && (
                                    <div className="min-w-[220px] max-w-[280px] px-3 py-2">
                                      <VoiceNotePlayer
                                        src={m.attachmentUrl}
                                        tone={fromMe ? 'own' : 'theirs'}
                                        testId={`dm-audio-message-${m.id}`}
                                        status={fromMe ? VOICE_COPY.sent : undefined}
                                        durationMs={knownDurationMs(m.attachmentMeta)}
                                      />
                                    </div>
                                  )}
                                  {m.content && (
                                    // 4 Sep 2026: a pasted www. or https:// address is a real link
                                    // here too, the same Linkify the wall and live chat use. 30 Oct 2026
                                    // (L9): a link in either bubble is the bubble's own colour, underlined
                                    // (BUBBLE_LINK), never the brand red.
                                    <div className={m.attachmentUrl ? 'px-3.5 py-2' : ''}>
                                      <Linkify text={localizeMeetingText(m.content)} className={BUBBLE_LINK} />
                                    </div>
                                  )}
                                  {/* Scheduled meeting → Join the room; an instant call that's
                                      over → Call again/back (Ali, 8 Sep 2026). */}
                                  {(() => {
                                    const act = meetingActionForMessage(m.content);
                                    if (!act || !activeId) return null;
                                    const Icon = act.kind === 'audio' ? Phone : Video;
                                    // A scheduled meeting still in play → Join; once its window has
                                    // ended → Call now; an instant-call line → Call again/back.
                                    // A CALL action needs what ringing needs: a video call canCall, an
                                    // audio one calls unlocked (first meeting happened). Nothing at all
                                    // with a former member (final fix wave C1, thread-call-rules.ts).
                                    const scheduledLive = act.scheduled && !confirmedMeetingOver;
                                    const action = messageCallAction({
                                      scheduled: act.scheduled, scheduledLive, kind: act.kind, canCall, callsUnlocked, former: readOnly,
                                    });
                                    if (!action) return null;
                                    const label = scheduledLive
                                      ? 'Join meeting'
                                      : act.scheduled
                                        ? 'Call now'
                                        : (fromMe ? 'Call again' : 'Call back');
                                    const onClick = scheduledLive
                                      ? () => navigate(`/meet/${activeId}?kind=${act.kind}&scheduled=1`)
                                      : () => startCall(act.kind);
                                    return (
                                      <div className={m.attachmentUrl ? 'px-3.5 pb-2' : 'mt-1.5'}>
                                        <button
                                          type="button"
                                          onClick={onClick}
                                          disabled={!act.scheduled && calling}
                                          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                                        >
                                          <Icon className="h-3.5 w-3.5" /> {label}
                                        </button>
                                      </div>
                                    );
                                  })()}
                                </div>
                                {/* Phase E — reaction trigger.
                                    Mobile: always at low opacity. Desktop: hover-revealed. */}
                                <button
                                  type="button"
                                  onClick={() => setReactionPickerFor(prev => prev === m.id ? null : m.id)}
                                  className="relative opacity-50 sm:opacity-0 sm:group-hover/bubble:opacity-100 hover:!opacity-100 active:!opacity-100 transition-opacity p-1 rounded-full bg-white border border-gray-200 shadow-sm text-gray-500 hover:text-gray-700 after:absolute after:-inset-2.5 after:content-['']"
                                  aria-label="Add reaction"
                                  title="Add reaction"
                                >
                                  <SmilePlus className="h-3.5 w-3.5" />
                                </button>
                                {/* Reply (30 Oct 2026, L7), beside the reaction trigger and shown the same way. */}
                                <ReplyButton onReply={() => replyTo(m, fromMe)} />
                                {/* Report message (11 Nov 2026, item 16): on the other person's messages, without leaving. */}
                                {!fromMe && (
                                  <MessageMoreButton
                                    onReport={() => setReporting({ subject: { kind: 'dm_message', id: m.id, excerpt: replyContentOf(m) } })}
                                  />
                                )}
                                {/* Reaction pills — under the bubble, slightly indented onto it */}
                                {hasReactions && (
                                  <div className={`absolute -bottom-3 ${fromMe ? 'right-2' : 'left-2'} flex gap-1`}>
                                    {reactionEntries.map(([type, userIds]) => {
                                      const mine = !!myUserId && userIds.includes(myUserId);
                                      return (
                                        <button
                                          key={type}
                                          type="button"
                                          onClick={() => toggleReaction(m.id, type, mine)}
                                          className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[11px] border transition-colors ${
                                            mine
                                              ? 'bg-rsn-red/10 border-rsn-red/40 text-rsn-red'
                                              : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
                                          }`}
                                          title={mine ? 'Remove your reaction' : 'Add your reaction'}
                                        >
                                          <span>{emojiForType(type)}</span>
                                          <span className="font-semibold">{userIds.length}</span>
                                        </button>
                                      );
                                    })}
                                  </div>
                                )}
                                {/* Reaction picker (6 emojis) — anchored above the bubble */}
                                {pickerOpen && (
                                  <div
                                    className={`absolute bottom-full mb-1 ${fromMe ? 'right-0' : 'left-0'} flex items-center gap-1 bg-white border border-gray-200 rounded-full shadow-lg px-1.5 py-1 z-10`}
                                    role="dialog"
                                    aria-label="Reaction picker"
                                  >
                                    {DM_REACTIONS.map(({ type, emoji, label }) => {
                                      const mine = !!myUserId && (reactions[type] || []).includes(myUserId);
                                      return (
                                        <button
                                          key={type}
                                          type="button"
                                          onClick={() => toggleReaction(m.id, type, mine)}
                                          title={label}
                                          className={`text-base hover:scale-125 active:scale-110 transition-transform p-1 rounded-full ${mine ? 'bg-rsn-red/10' : ''}`}
                                        >
                                          {emoji}
                                        </button>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                          <p className="text-[11px] text-gray-400 mt-1 px-1">
                            {timeOnly(lastDate)}
                            {fromMe && lastMsg.readAt ? ' · seen' : ''}
                          </p>
                        </div>
                      </div>,
                    );

                    prevClusterDate = lastDate;
                  });

                  return elements;
                })()
              )}
              <div ref={threadEndRef} />
            </div>

            {/* The message box (DmComposer, 11 Nov 2026, Shirley Palmer's RSN 01): one per conversation, keyed by it,
                so nothing unsent in one conversation (typed text, a voice note, a picture) is ever shown in, or sent
                to, another. A former member's thread takes no new messages. */}
            {otherIsFormer ? (
              <p
                data-testid="former-member-composer"
                className="border-t border-gray-200 px-4 py-3 text-sm text-gray-500"
                style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 0.75rem)' }}
              >
                This person is no longer a member of REASON, so they cannot get messages.
              </p>
            ) : blockedByMe ? (
              <BlockedThreadBanner
                name={headerContext.otherDisplayName}
                onUnblock={() => { void unblockUser(headerContext.otherUserId, headerContext.otherDisplayName); }}
                unblocking={unblocking}
              />
            ) : threadKey ? (
              <DmComposer
                key={threadKey}
                threadKey={threadKey}
                conversationId={activeId}
                toUserId={headerContext.otherUserId}
                recipientName={headerContext.otherDisplayName}
                replyTarget={replyTarget}
                onReplyDone={clearReply}
                boxRef={textareaRef}
                onBoxFocus={pinNewest}
                onFirstSend={firstSent}
              />
            ) : null}
          </>
        )}
      </div>
      {confirmDialog}
    </div>
  );
}
