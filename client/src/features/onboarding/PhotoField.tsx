// ─── Screen 7: "Profile photo: [Keep this photo] [Upload a new one]" ────────
//
// A member who has a photo already (Google, Gravatar, one they uploaded) keeps
// it unless they upload a new one. A member with none is offered the photo on
// their own LinkedIn page, but it only goes on their profile once they press
// "Keep this photo": confirm then asks for exactly the photo shown here. It is
// offered only after it has actually loaded, so nobody is asked to keep an
// empty square or a link that has expired.
//
// 30 Oct review (T3a): "Upload a new one" opens the same picture editor as the profile's pencil once a picture is
// chosen, so it can be placed and zoomed before it is kept; the server keeps it with where it was placed.

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Check } from 'lucide-react';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { useToastStore } from '@/stores/toastStore';
import { PROFILE } from './flow';
import PictureEditor from '@/components/picture/PictureEditor';
import { PICTURE_TYPES, pictureFileProblem } from '@/components/picture/picture-file';
import { useMemberPicture } from '@/components/picture/useMemberPicture';
import { useRefreshOnboarding } from './useOnboardingV2';

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
  const refresh = useRefreshOnboarding();
  // A photo of their own replaces a LinkedIn one they were offered, and the onboarding reads the new photo.
  const photo = useMemberPicture('avatar', () => { onKeepLinkedinPhoto(null); return refresh(); });
  const fileInput = useRef<HTMLInputElement>(null);
  const offered = avatarUrl ? null : linkedinPhotoUrl;
  const linkedinReady = useLoaded(offered);

  const shown: 'own' | 'linkedin' | 'none' = avatarUrl ? 'own' : offered && linkedinReady ? 'linkedin' : 'none';
  const kept = shown === 'own' || (shown === 'linkedin' && keptLinkedinPhoto === offered);
  const busy = photo.busy;

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // The same file can be chosen again after a failure.
    e.target.value = '';
    if (!file) return;
    if (!(PICTURE_TYPES as readonly string[]).includes(file.type)) {
      addToast('Choose a JPG, PNG or WebP photo.', 'error');
      return;
    }
    const problem = pictureFileProblem(file, 'photo');
    if (problem) {
      addToast(problem, 'error');
      return;
    }
    photo.editFile(file);
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
          {busy ? 'Saving…' : shown === 'none' ? 'Upload a photo' : PROFILE.newPhoto}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept={PICTURE_TYPES.join(',')}
          className="hidden"
          onChange={onFile}
          aria-hidden
          tabIndex={-1}
        />
      </div>
      <PictureEditor {...photo.editor} />
    </div>
  );
}
