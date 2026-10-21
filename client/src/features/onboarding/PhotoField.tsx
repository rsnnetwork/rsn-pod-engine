// ─── Screen 7: "Profile photo: [Keep this photo] [Upload a new one]" ────────
//
// A member who has a photo already (Google, Gravatar, one they uploaded) keeps
// it unless they upload a new one. A member with none is offered the photo on
// their own LinkedIn page, but it only goes on their profile once they press
// "Keep this photo": confirm then asks for exactly the photo shown here. It is
// offered only after it has actually loaded, so nobody is asked to keep an
// empty square or a link that has expired.

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Check } from 'lucide-react';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { useToastStore } from '@/stores/toastStore';
import { PROFILE, onboardingError } from './flow';
import { PHOTO_TYPES, shrinkPhoto } from './photo';
import { useUploadPhoto } from './useOnboardingV2';

interface Props {
  name: string;
  /** Their photo now. */
  avatarUrl: string | null;
  /** The photo on their LinkedIn page, from the lookup. */
  linkedinPhotoUrl: string | null;
  /** The LinkedIn photo they pressed "Keep this photo" for, or null. */
  keptLinkedinPhoto: string | null;
  onKeepLinkedinPhoto: (url: string | null) => void;
}

/** True once `src` has loaded with real pixels. */
function useLoaded(src: string | null): boolean {
  const [loaded, setLoaded] = useState<string | null>(null);
  useEffect(() => {
    if (!src) return;
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.onload = () => { if (img.naturalWidth > 0) setLoaded(src); };
    img.src = src;
    return () => { img.onload = null; };
  }, [src]);
  return !!src && loaded === src;
}

export default function PhotoField({ name, avatarUrl, linkedinPhotoUrl, keptLinkedinPhoto, onKeepLinkedinPhoto }: Props) {
  const { addToast } = useToastStore();
  const upload = useUploadPhoto();
  const fileInput = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const offered = avatarUrl ? null : linkedinPhotoUrl;
  const linkedinReady = useLoaded(offered);

  const shown: 'own' | 'linkedin' | 'none' = avatarUrl ? 'own' : offered && linkedinReady ? 'linkedin' : 'none';
  const kept = shown === 'own' || (shown === 'linkedin' && keptLinkedinPhoto === offered);
  const busy = reading || upload.isPending;

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // The same file can be chosen again after a failure.
    e.target.value = '';
    if (!file) return;
    if (!(PHOTO_TYPES as readonly string[]).includes(file.type)) {
      addToast('Choose a JPG, PNG or WebP photo.', 'error');
      return;
    }
    setReading(true);
    try {
      const data = await shrinkPhoto(file);
      if (!data) {
        addToast("We couldn't read that photo. Please choose another one.", 'error');
        return;
      }
      await upload.mutateAsync(data);
      onKeepLinkedinPhoto(null);
      addToast('Photo updated.', 'success');
    } catch (err) {
      addToast(onboardingError(err, "We couldn't add that photo. Please try again."), 'error');
    } finally {
      setReading(false);
    }
  };

  const caption = shown === 'linkedin'
    ? (kept ? 'This photo will go on your profile.' : 'We found this photo on your LinkedIn. Keep it to use it on your profile.')
    : shown === 'none' ? 'Add a photo so people recognise you.' : null;

  return (
    <div className="flex items-center gap-4">
      {shown === 'linkedin' && offered ? (
        <img
          src={offered}
          alt="The photo on your LinkedIn"
          referrerPolicy="no-referrer"
          className="h-20 w-20 shrink-0 rounded-full object-cover"
        />
      ) : (
        <Avatar src={avatarUrl} name={name || 'You'} size="2xl" className="h-20 w-20 shrink-0" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {caption && <p className="text-sm text-gray-600">{caption}</p>}
        {shown !== 'none' && (
          <Button
            variant={kept ? 'primary' : 'outline'}
            aria-pressed={kept}
            onClick={() => { if (shown === 'linkedin') onKeepLinkedinPhoto(kept ? null : offered); }}
            disabled={busy}
            className={`min-h-[44px] w-full justify-center ${kept ? '' : 'bg-white'}`}
          >
            {kept && <Check className="mr-1.5 h-4 w-4" aria-hidden />}
            {PROFILE.keepPhoto}
          </Button>
        )}
        <Button
          variant="outline"
          onClick={() => fileInput.current?.click()}
          isLoading={busy}
          className="min-h-[44px] w-full justify-center bg-white"
        >
          {busy ? 'Uploading…' : shown === 'none' ? 'Upload a photo' : PROFILE.newPhoto}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept={PHOTO_TYPES.join(',')}
          className="hidden"
          onChange={onFile}
          aria-hidden
          tabIndex={-1}
        />
      </div>
    </div>
  );
}
