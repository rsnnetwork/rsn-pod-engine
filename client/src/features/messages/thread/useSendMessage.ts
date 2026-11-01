// Sending a message in a 1:1 conversation (moved out of MessagesPage on 1 Nov 2026, T7, so the chat panel in the
// call room sends the same way). POST /dm/messages; the server fans the message out to both people, and a refusal
// (a block, a closed account) comes back as the server's own sentence in an error toast.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import { useToastStore } from '@/stores/toastStore';
import type { CloudinaryAudioResult, CloudinaryImageResult } from '@/lib/cloudinary';

/** At most one attachment per message, uploaded before the send (Messages only; the call room sends text). */
export type DmAttachment =
  | { url: string; type: 'image'; meta: CloudinaryImageResult }
  | { url: string; type: 'audio'; meta: CloudinaryAudioResult };

export interface SendMessageOptions<V> {
  /** Uploads what the message carries and answers it, or null for text alone. */
  prepareAttachment?: (vars: V) => Promise<DmAttachment | null>;
  onSent?: (data: { conversationId: string }, vars: V) => void;
  onFailed?: (err: unknown, vars: V) => void;
  /** Say a failure in a toast (the default). The call room has no toasts: its panel says it in place. */
  toastOnError?: boolean;
}

export function useSendMessage<V extends { content: string; replyToId?: string | null }>(
  conversationId: string | undefined,
  toUserId: string | undefined,
  options: SendMessageOptions<V> = {},
) {
  const qc = useQueryClient();
  const { addToast } = useToastStore();
  return useMutation({
    mutationFn: async (vars: V) => {
      if (!toUserId) throw new Error('No recipient');
      const attachment = options.prepareAttachment ? await options.prepareAttachment(vars) : null;
      const res = await api.post('/dm/messages', {
        toUserId,
        content: vars.content,
        attachment,
        // A quoted reply (30 Oct 2026) names the message it answers; only then does the body carry it.
        ...(vars.replyToId ? { replyToId: vars.replyToId } : {}),
      });
      return res.data.data as { conversationId: string };
    },
    onSuccess: (data, vars) => {
      qc.invalidateQueries({ queryKey: ['dm-messages', conversationId ?? data.conversationId] });
      qc.invalidateQueries({ queryKey: ['dm-conversations'] });
      options.onSent?.(data, vars);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- axios errors and thrown Errors both land here; the message is read from either
    onError: (err: any, vars) => {
      options.onFailed?.(err, vars);
      if (options.toastOnError === false) return;
      addToast(err?.response?.data?.error?.message || err?.message || 'Failed to send message', 'error');
    },
  });
}
