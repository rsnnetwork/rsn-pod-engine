// client/src/features/reason/profile/BannerEditor.tsx
// Your banner, with the pencil and "Remove" on it (21 Oct 2026, the 19 Oct feedback: "Users should be able to change
// their banner from their profile"; the pencil since the 30 Oct review, T3a: "fix the size or position"). The pencil
// opens the picture editor on the picture you chose last time, where you placed it; the server cuts the 2400 by 800
// banner from it and tells your other screens. Remove asks first.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useToastStore } from '@/stores/toastStore';
import PencilButton from '@/components/picture/PencilButton';
import PictureEditor from '@/components/picture/PictureEditor';
import { useMemberPicture } from '@/components/picture/useMemberPicture';
import ProfileBanner from '../human/ProfileBanner';
import Sheet from '../ui/Sheet';
import { errorMessage, reasonKeys, removeBannerRequest } from '../api';

const ON_BANNER = 'flex min-h-[44px] items-center rounded-full bg-white/95 px-3.5 text-[13px] font-extrabold text-reason-ink shadow-[0_6px_18px_rgba(0,0,0,.18)] backdrop-blur disabled:cursor-default disabled:opacity-70';

export default function BannerEditor({ bannerUrl }: { bannerUrl: string | null }) {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const [confirming, setConfirming] = useState(false);
  const banner = useMemberPicture('banner');

  // networkMode 'always': offline, a press fails at once and says so, instead of waiting for the connection.
  // It returns the refresh, so its button stays busy until your card and your profile have the change.
  const remove = useMutation({
    networkMode: 'always',
    mutationFn: removeBannerRequest,
    onSuccess: () => {
      setConfirming(false);
      addToast('Your banner is removed.', 'success');
      return qc.invalidateQueries({ queryKey: reasonKeys.mine });
    },
    onError: (err) => addToast(errorMessage(err, 'Could not remove your banner right now. Try again in a moment.'), 'error'),
  });
  const busy = banner.busy || remove.isPending;

  return (
    <>
      <ProfileBanner src={bannerUrl}>
        <div className="absolute bottom-2 right-2 flex items-center gap-2 md:bottom-3 md:right-3">
          {bannerUrl && (
            <button type="button" onClick={() => setConfirming(true)} disabled={busy} className={ON_BANNER}>Remove</button>
          )}
          <PencilButton label="Edit banner" onClick={banner.edit} disabled={busy} />
        </div>
      </ProfileBanner>
      <PictureEditor {...banner.editor} />
      <Sheet
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Remove your banner?"
        footer={(
          <>
            <button type="button" onClick={() => setConfirming(false)} className="min-h-[44px] rounded-[11px] border border-reason-line px-4 text-[14px] font-bold">Cancel</button>
            <button
              type="button"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
              className="min-h-[44px] rounded-[11px] bg-reason-red px-4 text-[14px] font-bold text-white disabled:opacity-70"
            >
              {remove.isPending ? 'Removing...' : 'Remove'}
            </button>
          </>
        )}
      >
        <p className="py-2 text-[14px] text-reason-muted">Your profile goes back to the default banner.</p>
      </Sheet>
    </>
  );
}
