// client/src/features/reason/entities/useEntityPicture.ts
// An entity's logo or banner in T3a's picture editor (30 Oct review, 7.1), for its admins and platform admins. As
// useMemberPicture does for a member's own: the pencil opens the editor on the picture the admin chose last time and
// where they placed it (fetched only while the editor is open), Save sends a new picture with its crop or only the
// crop, and the editor stays busy until the page has the new picture. The server tells everyone with the page open
// (entity:<id>); Remove asks first.
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PictureCrop } from '@rsn/shared';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { E } from '@/realtime/entities';
import type { PictureEditorProps } from '@/components/picture/PictureEditor';
import { pictureToSend } from '@/components/picture/prepare-picture';
import { sendPicture } from '@/components/picture/send-picture';
import {
  entityKeys, fetchEntityPictureSource, removeEntityPicture, saveEntityPicture, type EntityPictureKind,
} from './entity-api';
import { entityError, pictureWords } from './entity-text';

export function useEntityPicture(entity: { id: string; name: string }, kind: EntityPictureKind, has: boolean) {
  const me = useAuthStore((s) => s.user?.id as string | undefined);
  const addToast = useToastStore((s) => s.addToast);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const words = pictureWords(kind, has);
  // A ref, not isPending: a double tap on Remove lands before React draws the dialog as busy.
  const busy = useRef(false);

  const source = useQuery({
    queryKey: ['entity-picture-source', entity.id, kind],
    queryFn: () => fetchEntityPictureSource(entity.id, kind),
    enabled: open && !!me,
    meta: { entities: [E.entity(entity.id)] },
    // The kept picture can be megabytes: read fresh each time the editor opens, and let go of when it closes.
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  const save = useMutation({
    networkMode: 'always',
    mutationFn: ({ picture, crop }: { picture: Blob | null; crop: PictureCrop }) =>
      sendPicture(picture, crop, (body) => saveEntityPicture(entity.id, kind, body), pictureToSend),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: entityKeys.all });
      setOpen(false);
      addToast(`${entity.name}'s ${kind} is updated.`, 'success');
    },
  });

  // It returns the refresh, so the confirm stays busy until the page has lost the picture.
  const remove = useMutation({
    networkMode: 'always',
    mutationFn: () => removeEntityPicture(entity.id, kind),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: entityKeys.all });
      addToast(`${entity.name}'s ${kind} is removed.`, 'success');
    },
    onError: (err) => addToast(entityError(err, `Could not remove the ${kind} just now. Try again in a moment.`), 'error'),
  });

  const editor: PictureEditorProps = {
    open,
    title: words.edit,
    name: kind,
    // A company's picture, not the admin's own: "Could not save the logo", "Choose a picture for the logo".
    subject: `the ${kind}`,
    aspect: kind === 'logo' ? 1 : 3,
    src: source.data?.image ?? null,
    loading: source.isLoading,
    loadError: source.isError ? `We could not load the ${kind} just now. You can still choose a picture.` : null,
    initialCrop: source.data?.crop ?? null,
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
    words,
    editor,
  };
}
