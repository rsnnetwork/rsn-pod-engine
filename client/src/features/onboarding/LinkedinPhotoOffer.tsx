// ─── "Is this you?" — the LinkedIn photo, offered ────────────────────────────
//
// 23 Sep 2026. Shradha's deck: nothing reaches a profile unless the member
// confirms it. It came from Stefan's own test, where the LinkedIn match was the
// wrong person. So the photo we found on their LinkedIn is shown here and used
// only when they say it is them.
//
// The browser never tells the server which picture to use — it only says
// "yes". The server fetches the member's OWN scraped photo, so this cannot be
// used to put an arbitrary image, or somebody else's face, on a profile.

import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { E } from '@/realtime/entities';
import api from '@/lib/api';

/** The photo we found on the member's LinkedIn, or null when there is none. */
export function useLinkedinPhoto() {
  const userId = useAuthStore(s => s.user?.id);
  return useQuery({
    queryKey: ['linkedin-photo', userId],
    queryFn: () => api.get('/onboarding/linkedin-photo')
      .then(r => (r.data?.data?.photoUrl as string | null) ?? null),
    enabled: !!userId,
    meta: { entities: userId ? [E.user(userId)] : [] },
  });
}

interface Props {
  /** They said yes and it is now their photo. */
  onUsed?: () => void;
  /** They said it is not them, or there was nothing to offer after all. */
  onDismiss?: () => void;
}

export default function LinkedinPhotoOffer({ onUsed, onDismiss }: Props) {
  const { data: photoUrl } = useLinkedinPhoto();
  const checkSession = useAuthStore(s => s.checkSession);
  const { addToast } = useToastStore();
  // The card appears only once the photo has actually loaded. Asking "is this
  // you?" over an empty square is the one thing this card must never do —
  // the first production run showed exactly that for the second it took the
  // picture to arrive. A link that has expired or fails never shows the card.
  const [ready, setReady] = useState<'pending' | 'ok' | 'bad'>('pending');
  useEffect(() => {
    if (!photoUrl) return;
    setReady('pending');
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.onload = () => setReady(img.naturalWidth > 0 ? 'ok' : 'bad');
    img.onerror = () => setReady('bad');
    img.src = photoUrl;
    return () => { img.onload = null; img.onerror = null; };
  }, [photoUrl]);

  const use = useMutation({
    mutationFn: () => api.post('/onboarding/linkedin-photo'),
    onSuccess: async () => {
      await checkSession();
      addToast('Photo added from your LinkedIn.', 'success');
      onUsed?.();
    },
    onError: (err: { response?: { data?: { error?: { message?: string } } } }) => {
      addToast(err?.response?.data?.error?.message || 'Could not add that photo. Please try again.', 'error');
    },
  });

  if (!photoUrl || ready !== 'ok') return null;

  return (
    <div
      className="mb-4 flex flex-col items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 text-center sm:flex-row sm:text-left"
      data-testid="linkedin-photo-offer"
    >
      <img
        src={photoUrl}
        alt="The photo on your LinkedIn"
        width={64}
        height={64}
        className="h-16 w-16 shrink-0 rounded-full object-cover"
        referrerPolicy="no-referrer"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-[#1a1a2e]">Is this you?</p>
        <p className="mt-0.5 text-xs text-gray-500">
          We found this photo on your LinkedIn. It only goes on your profile if you say so.
        </p>
      </div>
      <div className="flex w-full shrink-0 gap-2 sm:w-auto">
        <Button
          onClick={() => use.mutate()}
          disabled={use.isPending}
          className="min-h-[44px] flex-1 sm:flex-none"
        >
          <Check className="mr-1.5 h-4 w-4" /> {use.isPending ? 'Adding…' : 'Yes, use it'}
        </Button>
        <Button
          variant="secondary"
          onClick={() => onDismiss?.()}
          disabled={use.isPending}
          className="min-h-[44px] flex-1 sm:flex-none"
        >
          Not me
        </Button>
      </div>
    </div>
  );
}
