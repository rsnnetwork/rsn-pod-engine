// Messages page — Phase E of chat-fix-and-dm-system plan (1 May 2026).
//
// Two-pane layout: conversation list (left) + active thread (right).
// On mobile: single-pane, list collapses when a conversation is open.
//
// Real-time updates: subscribes to dm:message, dm:read_receipt,
// dm:conversation_updated. Updates React Query cache so the inbox sort
// + thread view update without polling.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Send, Smile, SmilePlus, Trash2, MessageSquare, Image as ImageIcon, X, Mic, Square as StopSquare, CalendarClock } from 'lucide-react';
import MeetingScheduler from './MeetingScheduler';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { PageLoader, Spinner } from '@/components/ui/Spinner';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { getSocket } from '@/lib/socket';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import {
  isCloudinaryConfigured,
  validateImageFile,
  uploadImageToCloudinary,
  uploadAudioToCloudinary,
  MAX_AUDIO_DURATION_MS,
  type CloudinaryImageResult,
  type CloudinaryAudioResult,
} from '@/lib/cloudinary';

interface ConversationSummary {
  conversationId: string;
  otherUserId: string;
  otherDisplayName: string | null;
  otherAvatarUrl: string | null;
  lastMessage: string | null;
  lastMessageAt: string | null;
  lastMessageFromMe: boolean;
  unreadCount: number;
}

interface DmMessage {
  id: string;
  conversationId: string;
  fromUserId: string;
  content: string;
  readAt: string | null;
  createdAt: string;
  // Phase E — server returns aggregated reactions per emoji type
  reactions?: Record<string, string[]>;
  // Feature 19 + 20 (13 May spec) — Cloudinary image / audio attachment.
  attachmentUrl?: string | null;
  attachmentType?: 'image' | 'audio' | string | null;
  attachmentMeta?: {
    width?: number; height?: number; bytes?: number; format?: string;
    durationSec?: number;
  } | null;
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

function formatRelative(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return d.toLocaleDateString();
}

// Phase A polish — date separators ("Today" / "Yesterday" / "Mon May 1") between day boundaries.
function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function dayHeaderLabel(d: Date): string {
  const now = new Date();
  if (sameLocalDay(d, now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameLocalDay(d, yesterday)) return 'Yesterday';
  const daysAgo = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (daysAgo < 7) return d.toLocaleDateString([], { weekday: 'long' });
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

function timeOnly(d: Date): string {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Phase A polish — group consecutive messages from the same sender within 60s
// so we only show name/avatar/timestamp once per cluster (iMessage / WhatsApp pattern).
const CLUSTER_GAP_MS = 60_000;

// Phase B polish — curated emoji set for the composer picker.
// Same 20 the in-event ChatPanel uses, kept duplicated rather than abstracted
// because each chat surface might tune its own list later (no premature DRY).
const EMOJI_PICKER_LIST = [
  '😀','😂','😍','🥳','🤔','👍','👏','❤️','🔥','🎉',
  '💯','🙌','😮','🤩','😎','👋','✅','💪','🙏','⭐',
];

interface MessageCluster {
  senderId: string;
  messages: DmMessage[];
}

function clusterMessages(messages: DmMessage[]): MessageCluster[] {
  const clusters: MessageCluster[] = [];
  for (const msg of messages) {
    const last = clusters[clusters.length - 1];
    const lastMsg = last?.messages[last.messages.length - 1];
    const gap = lastMsg ? new Date(msg.createdAt).getTime() - new Date(lastMsg.createdAt).getTime() : Infinity;
    if (last && last.senderId === msg.fromUserId && gap < CLUSTER_GAP_MS) {
      last.messages.push(msg);
    } else {
      clusters.push({ senderId: msg.fromUserId, messages: [msg] });
    }
  }
  return clusters;
}

export default function MessagesPage() {
  // Feature 18 (13 May spec) — single page renders three modes:
  //   • /messages                     → inbox only (right pane is empty state)
  //   • /messages/:conversationId     → existing thread
  //   • /messages/new/:userId         → compose to a user who isn't in the inbox yet
  // In compose mode the right pane shows the target user's header and an empty
  // thread with the same composer; on first send the server creates the
  // conversation and we replace the URL with the real conversationId.
  const { conversationId: activeId, userId: composeToUserId } = useParams<{
    conversationId?: string;
    userId?: string;
  }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuthStore();
  const { addToast } = useToastStore();
  const myUserId = user?.id;
  const [draft, setDraft] = useState('');
  const [showEmoji, setShowEmoji] = useState(false);
  // REASON Phase 2 — "Find a time" panel (availability windows) per thread.
  const [schedulerOpen, setSchedulerOpen] = useState(false);
  // Feature 19 (13 May spec) — pending image attachment for the next send.
  // pendingImage holds the file picked from the file dialog; previewUrl is
  // an object URL so the user sees a thumbnail before the upload kicks off.
  // uploadFraction drives the progress bar overlay on the thumbnail.
  const [pendingImage, setPendingImage] = useState<{ file: File; previewUrl: string } | null>(null);
  const [uploadFraction, setUploadFraction] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cloudinaryReady = isCloudinaryConfigured();

  // Feature 20 (13 May spec) — voice-message recording state machine.
  //   idle      → no recording in progress; mic button shows
  //   recording → MediaRecorder is capturing; stop + cancel buttons + timer
  //   preview   → user reviewed; can play it back, replace, or send
  // pendingAudio carries the captured blob + duration + a preview URL so the
  // user can scrub through their own voice message before sending.
  const [recordingState, setRecordingState] = useState<'idle' | 'recording' | 'preview'>('idle');
  const [pendingAudio, setPendingAudio] = useState<{
    blob: Blob; durationMs: number; previewUrl: string;
  } | null>(null);
  const [recordingMs, setRecordingMs] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingStartRef = useRef<number>(0);
  const recordingTimerRef = useRef<number | null>(null);
  // Pass A (15 May follow-up) — Web Audio plumbing for the live waveform
  // visualizer. AnalyserNode samples the mic stream in real time; the
  // canvas draws a bar-meter that responds to volume. All of this is
  // teardown-safe — startRecording resets the refs and stopRecording
  // disconnects + closes the audio context.
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const waveformRafRef = useRef<number | null>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cancelRecordingRef = useRef<boolean>(false);
  // Phase E — which message the reaction picker is currently anchored to.
  const [reactionPickerFor, setReactionPickerFor] = useState<string | null>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  // Thread: messages in the active conversation.
  const { data: messagesData } = useQuery({
    queryKey: ['dm-messages', activeId],
    queryFn: () => api.get(`/dm/conversations/${activeId}/messages`).then(r => r.data.data as DmMessage[]),
    enabled: !!activeId,
    meta: { entities: activeId ? [E.dmConversation(activeId)] : [] },
  });

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
      navigate(`/messages/${existing.conversationId}`, { replace: true });
    }
  }, [composeToUserId, inboxData, navigate]);

  // Mark-as-read: fire on opening a conversation.
  useEffect(() => {
    if (!activeId) return;
    const socket = getSocket();
    if (socket?.connected) {
      socket.emit('dm:read', { conversationId: activeId });
    } else {
      api.post(`/dm/conversations/${activeId}/read`).catch(err => console.warn('mark-read failed', err));
    }
  }, [activeId]);

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

  // Feature 18 — derive an "effective active context" so the thread view and
  // composer can render uniformly whether we're in an existing thread or
  // composing a new one. composeTarget supplies the header info when we
  // don't have a conversation row yet.
  const isComposeMode = !!composeToUserId && !activeId;
  const composeTarget = composeToUserId && composeTargetUser
    ? {
        otherUserId: composeToUserId,
        otherDisplayName: composeTargetUser.displayName ?? null,
        otherAvatarUrl: composeTargetUser.avatarUrl ?? null,
      }
    : null;
  const headerContext: { otherUserId: string; otherDisplayName: string | null; otherAvatarUrl: string | null } | null
    = activeConv ?? composeTarget;

  const sendMutation = useMutation({
    mutationFn: async (args: {
      content: string;
      image: { file: File } | null;
      audio: { blob: Blob; durationMs: number } | null;
    }) => {
      const toUserId = activeConv?.otherUserId ?? composeToUserId;
      if (!toUserId) throw new Error('No recipient');

      // Feature 19/20 (13 May spec) — at most one attachment per message.
      // Image takes precedence if both are queued, but the UI disallows
      // simultaneous capture so this is just a belt-and-braces guard.
      let attachment:
        | { url: string; type: 'image'; meta: CloudinaryImageResult }
        | { url: string; type: 'audio'; meta: CloudinaryAudioResult }
        | null = null;
      if (args.image) {
        setUploadFraction(0);
        const result = await uploadImageToCloudinary(args.image.file, setUploadFraction);
        attachment = { url: result.url, type: 'image', meta: result };
        setUploadFraction(null);
      } else if (args.audio) {
        setUploadFraction(0);
        const result = await uploadAudioToCloudinary(args.audio.blob, args.audio.durationMs, setUploadFraction);
        attachment = { url: result.url, type: 'audio', meta: result };
        setUploadFraction(null);
      }

      const res = await api.post('/dm/messages', {
        toUserId,
        content: args.content,
        attachment,
      });
      return res.data.data as { conversationId: string };
    },
    onSuccess: (data) => {
      setDraft('');
      if (pendingImage) {
        URL.revokeObjectURL(pendingImage.previewUrl);
        setPendingImage(null);
      }
      if (pendingAudio) {
        URL.revokeObjectURL(pendingAudio.previewUrl);
        setPendingAudio(null);
        setRecordingState('idle');
      }
      qc.invalidateQueries({ queryKey: ['dm-messages', activeId ?? data.conversationId] });
      qc.invalidateQueries({ queryKey: ['dm-conversations'] });
      // Feature 18 — first send in compose-new mode flips the URL from
      // /messages/new/:userId to /messages/:conversationId so subsequent
      // sends use the existing-thread path and the back button works.
      if (isComposeMode) {
        navigate(`/messages/${data.conversationId}`, { replace: true });
      }
    },
    onError: (err: any) => {
      setUploadFraction(null);
      addToast(err?.response?.data?.error?.message || err?.message || 'Failed to send message', 'error');
    },
  });

  // Feature 19 — file picker handler. Validates client-side before showing
  // the preview; server + Cloudinary preset are the authoritative gates.
  const handleFilePicked: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const failure = validateImageFile(file);
    if (failure) {
      addToast(failure.message, 'error');
      e.target.value = '';
      return;
    }
    if (pendingImage) URL.revokeObjectURL(pendingImage.previewUrl);
    setPendingImage({ file, previewUrl: URL.createObjectURL(file) });
    e.target.value = '';
  };

  const clearPendingImage = () => {
    if (pendingImage) URL.revokeObjectURL(pendingImage.previewUrl);
    setPendingImage(null);
  };

  // Wraps both code-paths so the composer's submit + Enter handler stays
  // simple. Text, image, audio, or text+image/audio is accepted.
  const submitMessage = () => {
    const text = draft.trim();
    if (!text && !pendingImage && !pendingAudio) return;
    if (sendMutation.isPending) return;
    sendMutation.mutate({
      content: text,
      image: pendingImage,
      audio: pendingAudio ? { blob: pendingAudio.blob, durationMs: pendingAudio.durationMs } : null,
    });
  };

  // Feature 20 + Pass A fix (15 May follow-up) — recording lifecycle.
  //
  // The previous implementation used `recorder.start(100)` to slice the
  // recording into 100ms chunks, but that hit a known browser quirk where
  // the final ~half-second of audio could land mid-slice and never make it
  // into the chunks array before `onstop` fired. Voice messages came back
  // truncated at the tail (Ali's "missing last seconds" report).
  //
  // The fix:
  //   1. Drop the timeslice entirely → recorder buffers the whole take and
  //      delivers it in a single `dataavailable` event on stop.
  //   2. Call `recorder.requestData()` ~100ms before `stop()` to force any
  //      pending buffer to flush as its own `dataavailable` event first.
  //   3. Use a `cancelRecordingRef` so cancel can flip a flag the `onstop`
  //      handler reads instead of clearing chunks underneath the recorder.
  const startRecording = async () => {
    if (recordingState !== 'idle') return;
    if (!cloudinaryReady) {
      addToast('Voice messages are not configured for this deployment', 'error');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      recordingChunksRef.current = [];
      cancelRecordingRef.current = false;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordingChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        // Always tear down the mic stream regardless of how we got here so
        // the browser's recording indicator clears.
        stream.getTracks().forEach(t => t.stop());
        if (recordingTimerRef.current !== null) {
          window.clearInterval(recordingTimerRef.current);
          recordingTimerRef.current = null;
        }
        // Tear down the live-waveform plumbing.
        if (waveformRafRef.current !== null) {
          cancelAnimationFrame(waveformRafRef.current);
          waveformRafRef.current = null;
        }
        if (analyserRef.current) {
          try { analyserRef.current.disconnect(); } catch {}
          analyserRef.current = null;
        }
        if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
          audioContextRef.current.close().catch(() => {});
          audioContextRef.current = null;
        }

        const durationMs = Date.now() - recordingStartRef.current;
        const blob = new Blob(recordingChunksRef.current, { type: recorder.mimeType || mime || 'audio/webm' });
        recordingChunksRef.current = [];

        if (cancelRecordingRef.current || blob.size === 0 || durationMs < 250) {
          cancelRecordingRef.current = false;
          setRecordingState('idle');
          setRecordingMs(0);
          return;
        }
        const previewUrl = URL.createObjectURL(blob);
        setPendingAudio({ blob, durationMs, previewUrl });
        setRecordingState('preview');
      };

      // Pass A — start with NO timeslice so the whole take streams into a
      // single final chunk on stop. The 100ms requestData() in stopRecording
      // belts-and-braces this against any browser that buffers the tail
      // anyway.
      recorder.start();
      mediaRecorderRef.current = recorder;
      recordingStartRef.current = Date.now();
      setRecordingMs(0);
      setRecordingState('recording');
      recordingTimerRef.current = window.setInterval(() => {
        const elapsed = Date.now() - recordingStartRef.current;
        setRecordingMs(elapsed);
        if (elapsed >= MAX_AUDIO_DURATION_MS) {
          // Hard cap: auto-stop at 5 min. Use the wrapped helper so the
          // requestData() flush still fires.
          stopRecording();
        }
      }, 100);

      // Pass A — live waveform visualizer. AnalyserNode taps the mic stream
      // in real time; we draw a 40-bar meter to the canvas at requestAnimationFrame
      // cadence. fftSize 256 → 128 freq bins; we down-sample to 40 bars so the
      // bars are visibly wide on mobile. The canvas ref is set inside the JSX.
      try {
        const AudioCtor = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioCtor) {
          const ctx = new AudioCtor();
          const source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          analyser.smoothingTimeConstant = 0.6;
          source.connect(analyser);
          audioContextRef.current = ctx;
          analyserRef.current = analyser;

          const draw = () => {
            const canvas = waveformCanvasRef.current;
            if (!canvas || !analyserRef.current) return;
            const a = analyserRef.current;
            const data = new Uint8Array(a.frequencyBinCount);
            a.getByteFrequencyData(data);
            const c = canvas.getContext('2d');
            if (!c) return;
            const w = canvas.width;
            const h = canvas.height;
            c.clearRect(0, 0, w, h);
            const bars = 40;
            const stride = Math.floor(data.length / bars);
            const barW = w / bars;
            for (let i = 0; i < bars; i++) {
              // Average a small slice for each bar so the visualization is
              // smoother than picking one bin per bar.
              let sum = 0;
              for (let j = 0; j < stride; j++) sum += data[i * stride + j] || 0;
              const v = sum / stride / 255; // 0..1
              const barH = Math.max(2, v * h * 0.9);
              c.fillStyle = '#e10600'; // rsn-red
              c.fillRect(i * barW + barW * 0.15, (h - barH) / 2, barW * 0.7, barH);
            }
            waveformRafRef.current = requestAnimationFrame(draw);
          };
          waveformRafRef.current = requestAnimationFrame(draw);
        }
      } catch {
        // Visualizer is purely cosmetic — silently skip if Web Audio API is
        // unavailable or the user's browser blocks it.
      }
    } catch (err: any) {
      addToast(
        err?.name === 'NotAllowedError'
          ? 'Microphone access denied. Check browser permissions.'
          : 'Could not start recording',
        'error',
      );
      setRecordingState('idle');
    }
  };

  const stopRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== 'recording') {
      mediaRecorderRef.current = null;
      return;
    }
    // Pass A fix — force the recorder to emit any pending buffer as its own
    // dataavailable event BEFORE we call stop. Without this, the last
    // ~500ms of audio (between the most recent dataavailable and stop) can
    // sit in the muxer buffer and never reach the chunks array. The 120ms
    // delay gives the dataavailable event time to fire before stop runs.
    try { recorder.requestData(); } catch {}
    window.setTimeout(() => {
      const r = mediaRecorderRef.current;
      if (r && r.state === 'recording') r.stop();
      mediaRecorderRef.current = null;
    }, 120);
  };

  const cancelRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state === 'recording') {
      // Flip the cancel flag so onstop discards the blob instead of
      // racing with chunk clearance. The previous implementation cleared
      // chunks underneath the recorder which could leave the blob with
      // a partial tail on some browsers.
      cancelRecordingRef.current = true;
      try { recorder.stop(); } catch {}
    }
    mediaRecorderRef.current = null;
    if (recordingTimerRef.current !== null) {
      window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    setRecordingState('idle');
    setRecordingMs(0);
  };

  const discardPendingAudio = () => {
    if (pendingAudio) URL.revokeObjectURL(pendingAudio.previewUrl);
    setPendingAudio(null);
    setRecordingState('idle');
    setRecordingMs(0);
  };

  // Clean up media stream + Web Audio plumbing on unmount in case the user
  // navigates away mid-record. Each ref is teardown-safe on its own; the
  // checks are belt-and-suspenders for unexpected state.
  useEffect(() => {
    return () => {
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state === 'recording') {
        try { recorder.stop(); } catch {}
      }
      if (recordingTimerRef.current !== null) window.clearInterval(recordingTimerRef.current);
      if (waveformRafRef.current !== null) cancelAnimationFrame(waveformRafRef.current);
      if (analyserRef.current) {
        try { analyserRef.current.disconnect(); } catch {}
      }
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close().catch(() => {});
      }
      if (pendingAudio) URL.revokeObjectURL(pendingAudio.previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function formatRecordTime(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/dm/conversations/${id}`),
    onSuccess: () => {
      addToast('Conversation deleted', 'info');
      qc.invalidateQueries({ queryKey: ['dm-conversations'] });
      navigate('/messages');
    },
    onError: (err: any) => {
      addToast(err?.response?.data?.error?.message || 'Failed to delete', 'error');
    },
  });

  if (!myUserId) return <PageLoader />;

  return (
    <div className="flex flex-col md:flex-row gap-4 h-[calc(100vh-100px)]">
      {/* Conversation list (left, hidden on mobile when a thread is open) */}
      <div className={`md:w-80 md:flex-shrink-0 bg-white rounded-xl border border-gray-200 overflow-hidden ${activeId ? 'hidden md:flex' : 'flex'} flex-col`}>
        <div className="px-4 py-3 border-b border-gray-200 flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-gray-500" />
          <h2 className="text-sm font-semibold text-[#1a1a2e]">Messages</h2>
        </div>
        <div className="flex-1 overflow-y-auto">
          {inboxData === undefined ? (
            <div className="flex items-center justify-center py-12"><Spinner /></div>
          ) : inboxData.length === 0 ? (
            <div className="text-center py-12 px-4 text-sm text-gray-500">
              No conversations yet. Once you meet someone in an event, you can DM them from their profile.
            </div>
          ) : (
            inboxData.map(c => (
              <Link
                key={c.conversationId}
                to={`/messages/${c.conversationId}`}
                className={`flex items-center gap-3 px-4 py-3 hover:bg-gray-50 border-b border-gray-100 transition-colors ${activeId === c.conversationId ? 'bg-rsn-red/5' : ''}`}
              >
                <Avatar src={c.otherAvatarUrl || undefined} name={c.otherDisplayName || 'User'} size="md" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between">
                    <p className="text-sm font-medium text-[#1a1a2e] truncate">{c.otherDisplayName || 'User'}</p>
                    {c.lastMessageAt && <span className="text-[10px] text-gray-400 flex-shrink-0 ml-2">{formatRelative(c.lastMessageAt)}</span>}
                  </div>
                  <p className={`text-xs truncate ${c.unreadCount > 0 && !c.lastMessageFromMe ? 'font-semibold text-[#1a1a2e]' : 'text-gray-500'}`}>
                    {c.lastMessageFromMe ? 'You: ' : ''}{c.lastMessage || <em className="text-gray-300">No messages yet</em>}
                  </p>
                </div>
                {c.unreadCount > 0 && !c.lastMessageFromMe && (
                  <span className="bg-rsn-red text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
                    {c.unreadCount > 99 ? '99+' : c.unreadCount}
                  </span>
                )}
              </Link>
            ))
          )}
        </div>
      </div>

      {/* Thread view (right) */}
      <div className={`flex-1 bg-white rounded-xl border border-gray-200 overflow-hidden ${(activeId || isComposeMode) ? 'flex' : 'hidden md:flex'} flex-col`}>
        {!headerContext ? (
          <div className="flex-1 flex items-center justify-center text-sm text-gray-500 px-6 text-center">
            {composeToUserId
              ? <Spinner />
              : 'Select a conversation to start chatting.'}
          </div>
        ) : (
          <>
            {/* Thread header */}
            <div className="px-4 py-3 border-b border-gray-200 flex items-center gap-3">
              <button
                onClick={() => navigate('/messages')}
                className="md:hidden p-1 rounded-lg hover:bg-gray-100"
                aria-label="Back to inbox"
              >
                <ArrowLeft className="h-4 w-4 text-gray-500" />
              </button>
              <Avatar src={headerContext.otherAvatarUrl || undefined} name={headerContext.otherDisplayName || 'User'} size="sm" />
              <Link to={`/profile/${headerContext.otherUserId}`} className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-[#1a1a2e] truncate hover:underline">{headerContext.otherDisplayName || 'User'}</p>
              </Link>
              {/* REASON Phase 2 — arrange a time to meet (availability windows). */}
              {activeConv && (
                <button
                  onClick={() => setSchedulerOpen(o => !o)}
                  className={`p-1.5 rounded-lg min-h-[36px] min-w-[36px] transition-colors ${
                    schedulerOpen ? 'bg-rsn-red-light text-rsn-red' : 'hover:bg-gray-100 text-gray-400 hover:text-gray-600'
                  }`}
                  title="Find a time to meet"
                  aria-label="Find a time to meet"
                >
                  <CalendarClock className="h-4 w-4" />
                </button>
              )}
              {/* Delete is only available for existing conversations (compose-new
                  mode has nothing to delete yet). */}
              {activeConv && (
                <button
                  onClick={() => {
                    if (confirm('Delete this conversation from your view? The other person\'s view is unaffected.')) {
                      deleteMutation.mutate(activeConv.conversationId);
                    }
                  }}
                  className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500"
                  title="Delete conversation"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>

            {/* Availability grid — collapsible so the thread stays primary. */}
            {activeConv && schedulerOpen && (
              <MeetingScheduler conversationId={activeConv.conversationId} />
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

                    const fromMe = cluster.senderId === myUserId;

                    elements.push(
                      <div
                        key={cluster.messages[0].id}
                        className={`flex items-end gap-2 ${fromMe ? 'justify-end' : 'justify-start'} ${ci > 0 ? 'mt-3' : ''}`}
                      >
                        {!fromMe && (
                          <div className="flex-shrink-0">
                            <Avatar
                              src={headerContext.otherAvatarUrl || undefined}
                              name={headerContext.otherDisplayName || 'User'}
                              size="sm"
                            />
                          </div>
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
                                  className={`text-sm break-words whitespace-pre-wrap ${
                                    fromMe
                                      ? `bg-rsn-red text-white rounded-2xl ${isLast ? 'rounded-br-sm' : ''}`
                                      : `bg-gray-100 text-[#1a1a2e] rounded-2xl ${isLast ? 'rounded-bl-sm' : ''}`
                                  } ${m.attachmentUrl ? 'overflow-hidden' : 'px-3.5 py-2'}`}
                                >
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
                                  {/* Feature 20 (13 May spec) — audio bubble. Native
                                      <audio controls> for v1 — the browser ships a
                                      decent playback UI on every supported platform.
                                      Padded inside the bubble so it doesn't run flush
                                      to the rounded corner. */}
                                  {m.attachmentUrl && m.attachmentType === 'audio' && (
                                    <div className="px-3 py-2 flex items-center gap-2 min-w-[220px]">
                                      <Mic className="h-4 w-4 shrink-0 opacity-70" />
                                      <audio
                                        src={m.attachmentUrl}
                                        controls
                                        preload="metadata"
                                        className="flex-1 h-9 max-w-full"
                                        data-testid={`dm-audio-message-${m.id}`}
                                      />
                                    </div>
                                  )}
                                  {m.content && (
                                    <div className={m.attachmentUrl ? 'px-3.5 py-2' : ''}>{m.content}</div>
                                  )}
                                </div>
                                {/* Phase E — reaction trigger.
                                    Mobile: always at low opacity. Desktop: hover-revealed. */}
                                <button
                                  type="button"
                                  onClick={() => setReactionPickerFor(prev => prev === m.id ? null : m.id)}
                                  className="opacity-50 sm:opacity-0 sm:group-hover/bubble:opacity-100 hover:!opacity-100 active:!opacity-100 transition-opacity p-1 rounded-full bg-white border border-gray-200 shadow-sm text-gray-500 hover:text-gray-700"
                                  aria-label="Add reaction"
                                  title="Add reaction"
                                >
                                  <SmilePlus className="h-3.5 w-3.5" />
                                </button>
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
                          <p className="text-[10px] text-gray-400 mt-1 px-1">
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

            {/* Composer — Phase A polish: 16px input on mobile (kills iOS auto-zoom),
                safe-area padding so iPhone home indicator doesn't cover it,
                44pt send button on mobile (Apple HIG touch target).
                Phase B polish: emoji picker behind the smile icon.
                Feature 19 (13 May): image button + pending-image preview row
                above the input. The pending image renders as a small thumb
                with a remove button + an upload progress overlay when the
                send is in flight. The picker is hidden if Cloudinary isn't
                configured for this deployment. */}
            <div
              className="relative px-3 py-2 border-t border-gray-200"
              style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 0.5rem)' }}
            >
              {showEmoji && (
                <div
                  className="absolute bottom-full left-3 right-3 mb-2 bg-white border border-gray-200 rounded-xl shadow-lg p-2 grid grid-cols-6 sm:grid-cols-10 gap-1 z-10"
                  role="dialog"
                  aria-label="Emoji picker"
                >
                  {EMOJI_PICKER_LIST.map(e => (
                    <button
                      key={e}
                      type="button"
                      onClick={() => {
                        setDraft(prev => prev + e);
                        setShowEmoji(false);
                        textareaRef.current?.focus();
                      }}
                      className="text-xl sm:text-lg hover:bg-gray-100 active:scale-95 rounded p-1.5 transition-transform"
                    >
                      {e}
                    </button>
                  ))}
                </div>
              )}
              {pendingImage && (
                <div className="mb-2 inline-block relative">
                  <img
                    src={pendingImage.previewUrl}
                    alt="Pending"
                    className="max-h-32 max-w-full rounded-lg border border-gray-200"
                  />
                  {uploadFraction !== null && (
                    <div className="absolute inset-0 bg-black/40 rounded-lg flex items-center justify-center text-white text-xs font-semibold">
                      {Math.round(uploadFraction * 100)}%
                    </div>
                  )}
                  {uploadFraction === null && (
                    <button
                      type="button"
                      onClick={clearPendingImage}
                      className="absolute -top-2 -right-2 bg-white border border-gray-300 rounded-full p-0.5 shadow hover:bg-gray-50"
                      aria-label="Remove image"
                      title="Remove image"
                    >
                      <X className="h-3.5 w-3.5 text-gray-600" />
                    </button>
                  )}
                </div>
              )}
              {/* Feature 20 (13 May spec) — recorded audio preview row. The
                  user can play it back, discard it, or hit Send to upload.
                  Upload progress overlays as a percentage. */}
              {pendingAudio && (
                <div className="mb-2 flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                  <Mic className="h-4 w-4 text-rsn-red shrink-0" />
                  <audio
                    src={pendingAudio.previewUrl}
                    controls
                    className="flex-1 h-8 max-w-full"
                    data-testid="dm-audio-preview"
                  />
                  {uploadFraction !== null ? (
                    <span className="text-xs font-semibold text-gray-700 shrink-0">
                      {Math.round(uploadFraction * 100)}%
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={discardPendingAudio}
                      className="p-1 rounded hover:bg-gray-200 text-gray-500 shrink-0"
                      aria-label="Discard voice message"
                      title="Discard voice message"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              )}
              {/* Recording-active bar takes over the composer: pulsing red
                  dot, elapsed time, a live waveform visualizer, and the
                  cancel/stop buttons. The normal textarea + buttons hide
                  while recording so the user can't accidentally send a
                  half-formed message. Mobile-first: gap shrinks, waveform
                  flexes to fill, buttons stay 44pt tap targets. */}
              {recordingState === 'recording' && (
                <div className="flex items-center gap-2 sm:gap-3 px-1 sm:px-2 py-1" data-testid="dm-recording-bar">
                  <span className="inline-block h-2.5 w-2.5 rounded-full bg-rsn-red animate-pulse shrink-0" />
                  <span className="text-sm font-mono text-gray-700 shrink-0 tabular-nums">
                    {formatRecordTime(recordingMs)}
                  </span>
                  {/* Live waveform. Canvas resolution chosen for clarity at
                      device pixel ratio 1; CSS scales it to fit the flex space. */}
                  <canvas
                    ref={waveformCanvasRef}
                    width={400}
                    height={36}
                    className="flex-1 min-w-0 h-9 rounded-md bg-gray-50"
                    aria-label="Recording waveform"
                    data-testid="dm-recording-waveform"
                  />
                  <button
                    type="button"
                    onClick={cancelRecording}
                    aria-label="Cancel recording"
                    title="Cancel"
                    className="w-11 h-11 sm:w-9 sm:h-9 flex items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors flex-shrink-0"
                  >
                    <X className="h-5 w-5 sm:h-4 sm:w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={stopRecording}
                    aria-label="Stop and preview"
                    title="Stop"
                    className="w-11 h-11 sm:w-9 sm:h-9 flex items-center justify-center rounded-full bg-rsn-red text-white hover:bg-rsn-red/90 transition-colors flex-shrink-0"
                    data-testid="dm-recording-stop"
                  >
                    <StopSquare className="h-5 w-5 sm:h-4 sm:w-4" />
                  </button>
                </div>
              )}
              {/* Normal composer hides while recording — the recording bar
                  above takes its place so the user can't accidentally fire
                  a send mid-record. */}
              {recordingState !== 'recording' && (
              <div className="flex items-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowEmoji(s => !s)}
                  className="w-11 h-11 sm:w-9 sm:h-9 flex items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors flex-shrink-0"
                  aria-label="Add emoji"
                  title="Add emoji"
                >
                  <Smile className="h-5 w-5" />
                </button>
                {cloudinaryReady && (
                  <>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/gif"
                      className="hidden"
                      onChange={handleFilePicked}
                      data-testid="dm-image-input"
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={sendMutation.isPending || !!pendingAudio}
                      className="w-11 h-11 sm:w-9 sm:h-9 flex items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                      aria-label="Attach image"
                      title={pendingAudio ? 'Discard the voice message first' : 'Attach image'}
                      data-testid="dm-image-button"
                    >
                      <ImageIcon className="h-5 w-5" />
                    </button>
                    {/* Feature 20 — mic button kicks off recording. Disabled
                        while an image is queued so the user picks one or the
                        other; cancellation flows clear the conflict. */}
                    <button
                      type="button"
                      onClick={startRecording}
                      disabled={sendMutation.isPending || !!pendingImage || !!pendingAudio}
                      className="w-11 h-11 sm:w-9 sm:h-9 flex items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                      aria-label="Record voice message"
                      title={pendingImage ? 'Discard the image first' : 'Record voice message'}
                      data-testid="dm-mic-button"
                    >
                      <Mic className="h-5 w-5" />
                    </button>
                  </>
                )}
                <textarea
                  ref={textareaRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onFocus={() => {
                    // Phase A polish — when keyboard opens on mobile the thread
                    // can scroll out from under it; pin to the latest message.
                    setTimeout(() => threadEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 250);
                    setShowEmoji(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      submitMessage();
                    }
                  }}
                  rows={1}
                  placeholder={pendingImage ? 'Add a caption (optional)...' : 'Type a message...'}
                  className="flex-1 resize-none px-3 py-2 text-base sm:text-sm bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-1 focus:ring-rsn-red max-h-32"
                  maxLength={4000}
                />
                <Button
                  size="sm"
                  onClick={submitMessage}
                  disabled={(!draft.trim() && !pendingImage && !pendingAudio) || sendMutation.isPending}
                  isLoading={sendMutation.isPending}
                  className="!w-11 !h-11 sm:!w-9 sm:!h-9 !p-0 flex-shrink-0"
                  aria-label="Send message"
                >
                  <Send className="h-4 w-4" />
                </Button>
              </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
