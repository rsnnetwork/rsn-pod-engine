// client/src/components/picture/useMemberPicture.ts
// The member's own photo or banner in the picture editor (30 Oct review, T3a). Opened by a pencil, it asks the server
// for the picture they chose last time and where they placed it (only while it is open: up to 3 MB), or opens on a
// file they just picked. Save sends the picture with its crop, or only the crop, and the editor stays busy until the
// profile card and (for the photo) the header have the new picture, so it shows everywhere without a reload. The
// server tells the member's other screens (user:<id>) and, for the photo, their pods.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PictureCrop, PictureKind } from '@rsn/shared';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { E } from '@/realtime/entities';
import { fetchPictureSource, reasonKeys, savePictureRequest } from '@/features/reason/api';
import type { PictureEditorProps } from './PictureEditor';
import { serverCouldNotOpen } from './picture-file';
import { pictureToSend } from './prepare-picture';

const WORDS: Record<PictureKind, { name: string; title: string; aspect: 1 | 3 }> = {
  avatar: { name: 'photo', title: 'Edit your photo', aspect: 1 },
  banner: { name: 'banner', title: 'Edit your banner', aspect: 3 },
};

export function useMemberPicture(kind: PictureKind, onSaved?: () => Promise<unknown> | void) {
  const me = useAuthStore((s) => s.user?.id as string | undefined);
  const checkSession = useAuthStore((s) => s.checkSession);
  const addToast = useToastStore((s) => s.addToast);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<File | null>(null);
  const words = WORDS[kind];

  const source = useQuery({
    queryKey: ['picture-source', kind, me],
    queryFn: () => fetchPictureSource(kind),
    enabled: open && !chosen && !!me,
    meta: { entities: me ? [E.user(me)] : [] },
    // The kept picture can be megabytes: read fresh each time the editor opens, and let go of when it closes.
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  const save = useMutation({
    networkMode: 'always',
    mutationFn: async ({ picture, crop }: { picture: Blob | null; crop: PictureCrop }) => {
      if (!picture) return savePictureRequest(kind, { crop });
      const first = await pictureToSend(picture);
      try {
        return await savePictureRequest(kind, { image: first.image, crop });
      } catch (err) {
        // The browser could draw it (it is in the frame), but the server could not open the original: send the drawing.
        if (first.copied || !serverCouldNotOpen(err)) throw err;
        const copy = await pictureToSend(picture, true);
        return savePictureRequest(kind, { image: copy.image, crop });
      }
    },
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: reasonKeys.mine }),
        kind === 'avatar' ? checkSession() : undefined,
        onSaved?.(),
      ]);
      setOpen(false);
      setChosen(null);
      addToast(`Your ${words.name} is updated.`, 'success');
    },
  });

  const close = () => { setOpen(false); setChosen(null); };
  const editor: PictureEditorProps = {
    open,
    title: words.title,
    name: words.name,
    aspect: words.aspect,
    src: chosen ?? source.data?.image ?? null,
    loading: !chosen && source.isLoading,
    loadError: !chosen && source.isError ? `We could not load your ${words.name} just now. You can still choose a picture.` : null,
    initialCrop: chosen ? null : source.data?.crop ?? null,
    onSave: (picture, crop) => save.mutateAsync({ picture, crop }),
    onCancel: close,
  };
  return {
    /** Open on the picture they have (or ask for one). */
    edit: () => { setChosen(null); setOpen(true); },
    /** Open on a file they just picked. */
    editFile: (file: File) => { setChosen(file); setOpen(true); },
    busy: save.isPending,
    editor,
  };
}
