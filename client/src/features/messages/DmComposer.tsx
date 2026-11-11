// The one-to-one message box (moved out of MessagesPage on 11 Nov 2026 for Shirley Palmer's RSN 01, P0).
//
// MessagesPage stays mounted while the member moves between conversations (every /messages route renders the same
// page), and the box's state used to be the page's: a voice note stopped to one person was still in the box, one tap
// from being sent, when another person was opened. The page now mounts this box with key={threadKey}, so each
// conversation gets a fresh one, and what is unsent (typed text, a stopped voice note) is kept in composer-drafts
// against that exact conversation and recipient. It comes back in that conversation, never in another.
//
// Voice notes (RSN 05/06): Record → Stop → preview card (Not sent, its length, play) → "Send voice note" or "Discard".
// The take stops by itself at 1 minute, counting down from 50 s. Sending fixes the recipient when Send is pressed, so a
// conversation opened during the upload changes nothing; a double press sends once (claimVoiceSend). Leaving while
// recording keeps the take, stopped and unsent, in the conversation it was recorded in, and says so.

import { useCallback, useEffect, useRef, useState, type ChangeEventHandler, type MutableRefObject, type RefObject } from 'react';
import { Send, Smile, Image as ImageIcon, X, Mic } from 'lucide-react';
import EmojiPicker, { pickInto } from '@/components/chat/EmojiPicker';
import { isComposingEnter } from '@/components/chat/emoji';
import { Button } from '@/components/ui/Button';
import { useToastStore } from '@/stores/toastStore';
import { useConfirm } from '@/hooks/useConfirm';
import { isCloudinaryConfigured, validateImageFile, uploadImageToCloudinary, uploadAudioToCloudinary } from '@/lib/cloudinary';
import ReplyStrip from './ReplyStrip';
import type { ReplyTarget } from './reply-text';
import { useSendMessage } from './thread/useSendMessage';
import {
  claimVoiceSend, clearTextDraftIf, discardVoiceDraft, keepVoiceDraft, releaseVoiceSend, setTextDraft, textDraftOf,
  useComposerDrafts, voiceDraftOf,
} from './voice/composer-drafts';
import { VOICE_COPY, needsDiscardConfirm } from './voice/voice-note';
import { useVoiceRecorder } from './voice/useVoiceRecorder';
import { useLeaveGuard } from './voice/useLeaveGuard';
import RecordingBar from './voice/RecordingBar';
import VoiceDraftCard from './voice/VoiceDraftCard';

interface SendVars {
  /** The box the message was sent from: what is cleared when it lands. */
  threadKey: string;
  toUserId: string;
  content: string;
  image: { file: File } | null;
  audio: { blob: Blob; durationMs: number } | null;
  replyToId: string | null;
}

interface Props {
  threadKey: string;
  conversationId: string | undefined;
  toUserId: string;
  recipientName: string | null;
  replyTarget: ReplyTarget | null;
  onReplyDone: () => void;
  boxRef: MutableRefObject<HTMLTextAreaElement | null>;
  /** The box took the focus (a phone keyboard is opening): the page keeps the newest message in view. */
  onBoxFocus: () => void;
  /** The first message to someone made the conversation: the page moves to its address. */
  onFirstSend?: (conversationId: string) => void;
}

export default function DmComposer({
  threadKey, conversationId, toUserId, recipientName, replyTarget, onReplyDone, boxRef, onBoxFocus, onFirstSend,
}: Props) {
  const addToast = useToastStore((s) => s.addToast);
  const { ask, confirmDialog } = useConfirm();
  const text = useComposerDrafts((s) => textDraftOf(s, threadKey, toUserId));
  const voice = useComposerDrafts((s) => voiceDraftOf(s, threadKey, toUserId));
  const [showEmoji, setShowEmoji] = useState(false);
  const closeEmoji = useCallback(() => setShowEmoji(false), []);
  const emojiToggleRef = useRef<HTMLButtonElement>(null);
  const [pendingImage, setPendingImage] = useState<{ file: File; previewUrl: string } | null>(null);
  const [uploadFraction, setUploadFraction] = useState<number | null>(null);
  const cloudinaryReady = isCloudinaryConfigured();
  // A send can land after this box is gone (another conversation opened meanwhile). Then it clears its own draft and
  // says so, but touches nothing on the page: not the reply being written there, not the address.
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // A text sent with Enter twice, or Send double-clicked, before the first press has re-rendered the box: one message.
  const textInFlight = useRef(false);
  useEffect(() => () => { if (pendingImage) URL.revokeObjectURL(pendingImage.previewUrl); }, [pendingImage]);
  const recorder = useVoiceRecorder({
    onRecorded: (b, durationMs, how) => {
      keepVoiceDraft(threadKey, toUserId, b, durationMs);
      if (how === 'left') addToast(VOICE_COPY.keptFor(recipientName), 'info');
      if (how === 'cap') addToast(VOICE_COPY.capReached, 'info');
    },
    onError: (sentence) => addToast(sentence, 'error'),
  });
  useLeaveGuard(recorder.state !== 'idle');

  const send = useSendMessage<SendVars>(conversationId, toUserId, {
    prepareAttachment: async (vars) => {
      if (vars.image) {
        setUploadFraction(0);
        const result = await uploadImageToCloudinary(vars.image.file, setUploadFraction);
        setUploadFraction(null);
        return { url: result.url, type: 'image', meta: result };
      }
      if (vars.audio) {
        setUploadFraction(0);
        const result = await uploadAudioToCloudinary(vars.audio.blob, vars.audio.durationMs, setUploadFraction);
        setUploadFraction(null);
        return { url: result.url, type: 'audio', meta: result };
      }
      return null;
    },
    // Both run for the box the message was sent from, even when another conversation is open by then.
    onSent: (data, vars) => {
      if (vars.audio) {
        discardVoiceDraft(vars.threadKey);
        addToast(VOICE_COPY.sentTo(recipientName), 'success');
      } else {
        textInFlight.current = false;
        clearTextDraftIf(vars.threadKey, vars.toUserId, vars.content);
      }
      if (!mounted.current) return;
      if (vars.image) setPendingImage(null);
      onReplyDone();
      if (!conversationId) onFirstSend?.(data.conversationId);
    },
    onFailed: (_err, vars) => {
      setUploadFraction(null);
      if (vars.audio) releaseVoiceSend(vars.threadKey);
      else textInFlight.current = false;
    },
  });

  const sendText = () => {
    const content = text.trim();
    if (!content && !pendingImage) return;
    if (send.isPending || textInFlight.current) return;
    textInFlight.current = true;
    setShowEmoji(false);
    send.mutate({
      threadKey, toUserId, content, image: pendingImage, audio: null, replyToId: replyTarget?.id ?? null,
    });
  };

  const sendVoice = () => {
    // Taken and marked sending in one step: a second press, here or in this conversation's box mounted again, gets null.
    const claimed = claimVoiceSend(threadKey, toUserId);
    if (!claimed) return;
    send.mutate({
      threadKey,
      toUserId: claimed.toUserId,
      content: '',
      image: null,
      audio: { blob: claimed.blob, durationMs: claimed.durationMs },
      replyToId: replyTarget?.id ?? null,
    });
  };

  const discardVoice = async () => {
    if (!voice || voice.sending) return;
    if (needsDiscardConfirm(voice.durationMs)) {
      const yes = await ask({ title: VOICE_COPY.discardTitle, body: VOICE_COPY.discardBody, confirmLabel: VOICE_COPY.discard, tone: 'danger' });
      if (!yes) return;
    }
    discardVoiceDraft(threadKey);
  };

  const pickImage: ChangeEventHandler<HTMLInputElement> = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const failure = validateImageFile(file);
    if (failure) { addToast(failure.message, 'error'); return; }
    setPendingImage({ file, previewUrl: URL.createObjectURL(file) });
  };

  const clearImage = () => setPendingImage(null);

  const recording = recorder.state !== 'idle';
  return (
    <div
      className="relative px-3 py-2 border-t border-gray-200"
      style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 0.5rem)' }}
    >
      {/* One picker for every message box (30 Oct 2026, L9): it stays open for several emojis, each put where the caret
          is, until Escape, a tap outside, the smile button, Done or Send. */}
      <EmojiPicker
        open={showEmoji}
        onClose={closeEmoji}
        toggleRef={emojiToggleRef}
        onPick={(e) => pickInto(boxRef.current, text, e, (next) => setTextDraft(threadKey, toUserId, next))}
        className="absolute bottom-full left-3 right-3 mb-2"
      />
      {replyTarget && <ReplyStrip target={replyTarget} onCancel={onReplyDone} />}
      {pendingImage && <ImagePreview src={pendingImage.previewUrl} uploadFraction={uploadFraction} onRemove={clearImage} />}
      {voice ? (
        <VoiceDraftCard
          voice={voice}
          recipientName={recipientName}
          uploadFraction={voice.sending ? uploadFraction : null}
          onSend={sendVoice}
          onDiscard={() => { void discardVoice(); }}
        />
      ) : recording ? (
        <RecordingBar
          elapsedMs={recorder.elapsedMs}
          starting={recorder.state === 'starting'}
          canvasRef={recorder.canvasRef}
          onCancel={recorder.cancel}
          onStop={recorder.stop}
        />
      ) : (
        <TextRow
          text={text}
          onText={(next) => setTextDraft(threadKey, toUserId, next)}
          boxRef={boxRef}
          onFocus={() => { onBoxFocus(); setShowEmoji(false); }}
          onSend={sendText}
          busy={send.isPending}
          hasImage={!!pendingImage}
          canAttach={cloudinaryReady}
          onPickImage={pickImage}
          onRecord={recorder.start}
          emojiOpen={showEmoji}
          onToggleEmoji={() => setShowEmoji((s) => !s)}
          emojiToggleRef={emojiToggleRef}
        />
      )}
      {confirmDialog}
    </div>
  );
}

/** A picture picked for the next message: its thumbnail, the upload's progress, and a 44px way to remove it. */
function ImagePreview({ src, uploadFraction, onRemove }: { src: string; uploadFraction: number | null; onRemove: () => void }) {
  return (
    <div className="relative mb-2 inline-block">
      <img src={src} alt="Pending" className="max-h-32 max-w-full rounded-lg border border-gray-200" />
      {uploadFraction !== null ? (
        <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/40 text-xs font-semibold text-white">
          {Math.round(uploadFraction * 100)}%
        </div>
      ) : (
        <button
          type="button"
          onClick={onRemove}
          className="absolute -right-3 -top-3 flex h-11 w-11 items-center justify-center"
          aria-label="Remove image"
          title="Remove image"
        >
          <span className="rounded-full border border-gray-300 bg-white p-0.5 shadow hover:bg-gray-50">
            <X className="h-3.5 w-3.5 text-gray-600" />
          </span>
        </button>
      )}
    </div>
  );
}

interface TextRowProps {
  text: string;
  onText: (next: string) => void;
  boxRef: MutableRefObject<HTMLTextAreaElement | null>;
  onFocus: () => void;
  onSend: () => void;
  busy: boolean;
  hasImage: boolean;
  canAttach: boolean;
  onPickImage: ChangeEventHandler<HTMLInputElement>;
  onRecord: () => void;
  emojiOpen: boolean;
  onToggleEmoji: () => void;
  emojiToggleRef: RefObject<HTMLButtonElement>;
}

/** The text box with its buttons: emoji (not on a phone), picture, record, and Send. */
function TextRow({
  text, onText, boxRef, onFocus, onSend, busy, hasImage, canAttach, onPickImage, onRecord, emojiOpen, onToggleEmoji, emojiToggleRef,
}: TextRowProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 360px phones: image + mic + send leave ~150px for the box, where "Type a message..." wraps under its own first word.
  const narrowPhone = typeof window !== 'undefined' && window.matchMedia('(max-width: 379px)').matches;
  return (
    <div className="flex items-end gap-2">
      {/* Every button beside the box is 44px on every width, the box's own height (P23, 26 Oct 2026). The smile
          stays hidden on a phone, whose keyboard has its own emoji panel. */}
      <button
        ref={emojiToggleRef}
        type="button"
        onClick={onToggleEmoji}
        aria-expanded={emojiOpen}
        className="hidden sm:flex w-11 h-11 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors flex-shrink-0"
        aria-label="Add emoji"
        title="Add emoji"
      >
        <Smile className="h-5 w-5" />
      </button>
      {canAttach && (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            className="hidden"
            onChange={onPickImage}
            data-testid="dm-image-input"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
            className="w-11 h-11 flex items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label="Attach image"
            title="Attach image"
            data-testid="dm-image-button"
          >
            <ImageIcon className="h-5 w-5" />
          </button>
          {/* Record. Not while a picture waits to be sent: one or the other per message. */}
          <button
            type="button"
            onClick={onRecord}
            disabled={busy || hasImage}
            className="w-11 h-11 flex items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label={VOICE_COPY.record}
            title={hasImage ? 'Remove the image first' : VOICE_COPY.record}
            data-testid="dm-mic-button"
          >
            <Mic className="h-5 w-5" />
          </button>
        </>
      )}
      <textarea
        ref={boxRef}
        value={text}
        onChange={(e) => onText(e.target.value)}
        onFocus={onFocus}
        onKeyDown={(e) => {
          // Not while a word is still being composed (Japanese, Chinese, Korean input): there Enter picks the word.
          // Safari sends the Enter that confirms the word after composition has ended, as keyCode 229 (P22).
          if (e.key === 'Enter' && !e.shiftKey && !isComposingEnter(e.nativeEvent)) {
            e.preventDefault();
            onSend();
          }
        }}
        rows={1}
        placeholder={hasImage ? 'Add a caption (optional)...' : narrowPhone ? 'Message…' : 'Type a message...'}
        // 16px on a phone (no iOS zoom); at least 44px tall on every width (26 Oct 2026).
        className="flex-1 min-w-0 min-h-[44px] resize-none px-3 py-2 text-base sm:text-sm bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-1 focus:ring-rsn-red max-h-32"
        maxLength={4000}
      />
      <Button
        size="sm"
        onClick={onSend}
        disabled={(!text.trim() && !hasImage) || busy}
        isLoading={busy}
        className="!w-11 !h-11 !p-0 flex-shrink-0"
        aria-label="Send message"
      >
        <Send className="h-4 w-4" />
      </Button>
    </div>
  );
}
