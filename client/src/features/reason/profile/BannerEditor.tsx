// client/src/features/reason/profile/BannerEditor.tsx
// Your banner, with "Change banner" and "Remove" on it (21 Oct 2026, the 19 Oct feedback: "Users should be able to
// change their banner from their profile"). A chosen picture is cropped to 1500x500 in the browser and sent; the
// server keeps it and tells your other screens. Remove asks first.
import { useRef, useState, type ChangeEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useToastStore } from '@/stores/toastStore';
import ProfileBanner from '../human/ProfileBanner';
import Sheet from '../ui/Sheet';
import { errorMessage, reasonKeys, removeBannerRequest, uploadBanner } from '../api';
import { bannerFileProblem } from './banner-image';
import { UNREADABLE_PICTURE, cropToBanner } from './crop-banner';

const ON_BANNER = 'flex min-h-[44px] items-center rounded-full bg-white/95 px-3.5 text-[13px] font-extrabold text-reason-ink shadow-[0_6px_18px_rgba(0,0,0,.18)] backdrop-blur disabled:cursor-default disabled:opacity-70';
const FAILED_UPLOAD = 'Could not change your banner right now. Try again in a moment.';

export default function BannerEditor({ bannerUrl }: { bannerUrl: string | null }) {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const picker = useRef<HTMLInputElement>(null);
  const [confirming, setConfirming] = useState(false);

  // networkMode 'always': offline, a press fails at once and says so, instead of waiting for the connection.
  // Each one returns the refresh, so its button stays busy until your card and your profile have the change.
  const upload = useMutation({
    networkMode: 'always',
    mutationFn: async (file: File) => uploadBanner(await cropToBanner(file)),
    onSuccess: () => {
      addToast('Your banner is updated.', 'success');
      return qc.invalidateQueries({ queryKey: reasonKeys.mine });
    },
    // A picture the browser could not open says so; anything the server or the connection says goes through errorMessage.
    onError: (err) => addToast(err instanceof Error && err.message === UNREADABLE_PICTURE ? UNREADABLE_PICTURE : errorMessage(err, FAILED_UPLOAD), 'error'),
  });
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
  const busy = upload.isPending || remove.isPending;

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    // Cleared at once, so the same picture can be chosen again after a failure.
    input.value = '';
    if (!file || busy) return;
    const problem = bannerFileProblem(file);
    if (problem) {
      addToast(problem, 'error');
      return;
    }
    upload.mutate(file);
  };

  return (
    <>
      <ProfileBanner src={bannerUrl}>
        <div className="absolute bottom-2 right-2 flex gap-2 md:bottom-3 md:right-3">
          <button type="button" onClick={() => picker.current?.click()} disabled={busy} className={ON_BANNER}>
            {upload.isPending ? 'Uploading...' : 'Change banner'}
          </button>
          {bannerUrl && (
            <button type="button" onClick={() => setConfirming(true)} disabled={busy} className={ON_BANNER}>Remove</button>
          )}
        </div>
        <input ref={picker} type="file" accept="image/jpeg,image/png,image/webp" onChange={onPick} className="hidden" aria-label="Choose a banner picture" />
      </ProfileBanner>
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
