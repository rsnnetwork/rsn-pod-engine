// client/src/features/sessions/useEventImage.ts
// An event's image in the picture editor (10 Nov 2026 spec, Part 3 item 1: "event setup: imagery"), for the event's
// host and platform admins, the people the server lets change it (PUT/DELETE /sessions/:id/image). As useEntityPicture
// does for a company's banner: "Add image" / "Change image" opens the editor on the picture chosen last time and where
// it was placed (fetched only while the editor is open), Save sends a new picture with its crop or only the crop, and
// the editor stays busy until the page has the new image. The server tells everyone with the event open, and every
// list that shows it (session:<id> and the event's list tags); nothing here writes into a cached answer.
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PictureCrop, PictureSource } from '@rsn/shared';
import api from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { E } from '@/realtime/entities';
import type { PictureEditorProps } from '@/components/picture/PictureEditor';
import { pictureToSend } from '@/components/picture/prepare-picture';
import { sendPicture, type PictureSend } from '@/components/picture/send-picture';
import { errorMessage } from '@/features/reason/errors';

export const EVENT_IMAGE_WORDS = {
  add: 'Add image',
  change: 'Change image',
  remove: 'Remove image',
  saved: 'The event image is updated.',
  removed: 'The event image is removed.',
  removeFailed: 'Could not remove the event image just now. Try again in a moment.',
  confirmTitle: 'Remove the event image?',
  confirmBody: 'The event page, its invitations and its link show no image until you add one again.',
} as const;

/** The event's image as its organiser edits it. `hasImage`: the event has one now (the editor then opens on it). */
export function useEventImage(sessionId: string, hasImage: boolean) {
  const me = useAuthStore((s) => s.user?.id as string | undefined);
  const addToast = useToastStore((s) => s.addToast);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  // A ref, not isPending: a double tap on Remove lands before React draws the dialog as busy.
  const busy = useRef(false);

  const source = useQuery({
    queryKey: ['event-image-source', sessionId],
    queryFn: () => api.get(`/sessions/${sessionId}/image/source`).then((r) => r.data.data as PictureSource),
    // With no image there is nothing to open on: the editor asks for a picture.
    enabled: open && !!me && hasImage,
    meta: { entities: [E.session(sessionId)] },
    // The kept picture can be megabytes: read fresh each time the editor opens, and let go of when it closes.
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  // The event page reads the new address before the editor closes; every other screen hears session:<id>.
  const refreshEvent = () => qc.invalidateQueries({ queryKey: ['session', sessionId] });

  const save = useMutation({
    networkMode: 'always',
    mutationFn: ({ picture, crop }: { picture: Blob | null; crop: PictureCrop }) =>
      sendPicture(picture, crop, (body: PictureSend) => api.put(`/sessions/${sessionId}/image`, body), pictureToSend),
    onSuccess: async () => {
      await refreshEvent();
      setOpen(false);
      addToast(EVENT_IMAGE_WORDS.saved, 'success');
    },
  });

  const remove = useMutation({
    networkMode: 'always',
    mutationFn: () => api.delete(`/sessions/${sessionId}/image`),
    onSuccess: async () => {
      await refreshEvent();
      addToast(EVENT_IMAGE_WORDS.removed, 'success');
    },
    onError: (err) => addToast(errorMessage(err, EVENT_IMAGE_WORDS.removeFailed), 'error'),
  });

  const editor: PictureEditorProps = {
    open,
    title: hasImage ? EVENT_IMAGE_WORDS.change : EVENT_IMAGE_WORDS.add,
    name: 'image',
    // The event's picture, not the organiser's own: "Could not save the event image", "Choose a picture for the event image".
    subject: 'the event image',
    aspect: 3,
    src: hasImage ? source.data?.image ?? null : null,
    loading: hasImage && source.isLoading,
    loadError: source.isError ? 'We could not load the event image just now. You can still choose a picture.' : null,
    initialCrop: hasImage ? source.data?.crop ?? null : null,
    onSave: (picture, crop) => save.mutateAsync({ picture, crop }),
    onCancel: () => setOpen(false),
  };

  return {
    edit: () => setOpen(true),
    remove: async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        await remove.mutateAsync();
      } finally {
        busy.current = false;
      }
    },
    removing: remove.isPending,
    busy: save.isPending || remove.isPending,
    editor,
  };
}
