// Sending a message in a 1:1 conversation (moved out of MessagesPage on 1 Nov 2026, T7, so the chat panel in the
// call room sends the same way). POST /dm/messages; the server fans the message out to both people, and a refusal
// (a block, a closed account) comes back as the server's own sentence in an error toast; a lost connection says so
// in words, never "Network Error" (final fix wave CM3, send-failure.ts).

import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import { useToastStore } from '@/stores/toastStore';
import type { CloudinaryAudioResult, CloudinaryImageResult } from '@/lib/cloudinary';
import { sendFailureSentence } from './send-failure';
import { useAuthStore } from '@/stores/authStore';
import { onMemberChange } from '@/lib/queryClient';
import { isSenderChanged, sendAsMember } from './send-as';

/** At most one attachment per message, uploaded before the send (Messages only; the call room sends text). */
export type DmAttachment =
  | { url: string; type: 'image'; meta: CloudinaryImageResult }
  | { url: string; type: 'audio'; meta: CloudinaryAudioResult & { durationMs: number } };

export interface SendMessageOptions<V> {
  /** Uploads what the message carries and answers it, or null for text alone. Stops when `signal` aborts. */
  prepareAttachment?: (vars: V, signal: AbortSignal) => Promise<DmAttachment | null>;
  onSent?: (data: { conversationId: string }, vars: V) => void;
  onFailed?: (err: unknown, vars: V) => void;
  /** Say a failure in a toast (the default). The call room has no toasts: its panel says it in place. */
  toastOnError?: boolean;
}

export function useSendMessage<V extends { content: string; replyToId?: string | null; toUserId?: string }>(
  conversationId: string | undefined,
  toUserId: string | undefined,
  options: SendMessageOptions<V> = {},
) {
  const qc = useQueryClient();
  const { addToast } = useToastStore();
  return useMutation({
    mutationFn: async (vars: V) => {
      // A recipient named in the send itself wins (11 Nov 2026, RSN 01): a voice note goes to the person it was recorded
      // for, fixed when Send was pressed, whatever conversation is open by the time its upload ends.
      const to = vars.toUserId ?? toUserId;
      if (!to) throw new Error('No recipient');
      // Sent as the member who pressed Send, or not at all (send-as.ts): signing out, or another member signing in,
      // while it is on its way stops the upload and the post.
      return sendAsMember(vars, {
        memberNow: () => useAuthStore.getState().user?.id ?? null,
        watchMember: onMemberChange,
        prepare: (v, signal) => (options.prepareAttachment ? options.prepareAttachment(v, signal) : Promise.resolve(null)),
        post: async (attachment, sentAs, signal) => {
          const res = await api.post('/dm/messages', {
            toUserId: to,
            content: vars.content,
            attachment,
            // A quoted reply (30 Oct 2026) names the message it answers; only then does the body carry it.
            ...(vars.replyToId ? { replyToId: vars.replyToId } : {}),
          }, { signal, sentAs });
          return res.data.data as { conversationId: string };
        },
      });
    },
    onSuccess: (data, vars) => {
      qc.invalidateQueries({ queryKey: ['dm-messages', conversationId ?? data.conversationId] });
      qc.invalidateQueries({ queryKey: ['dm-conversations'] });
      options.onSent?.(data, vars);
    },
    onError: (err: unknown, vars) => {
      options.onFailed?.(err, vars);
      // Stopped because the member changed: nothing was posted, and the member it belonged to is gone.
      if (isSenderChanged(err)) return;
      if (options.toastOnError === false) return;
      addToast(sendFailureSentence(err), 'error');
    },
  });
}
