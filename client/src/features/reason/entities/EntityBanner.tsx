// client/src/features/reason/entities/EntityBanner.tsx
// The entity's banner, a 3:1 strip above its hero (30 Oct review, 7.1: "upload a company logo and banner"). Drawn in
// the member banner's own box (ProfileBanner), so it crops the same way on every screen. Its admins see the pencil at
// its bottom right ("Add banner" / "Change banner", T3a's editor at 3:1) and, once there is one, "Remove banner",
// which asks first. Everyone else sees the strip only when there is a banner.
import { useState } from 'react';
import type { EntityPage } from '@rsn/shared';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import PencilButton from '@/components/picture/PencilButton';
import PictureEditor from '@/components/picture/PictureEditor';
import ProfileBanner from '../human/ProfileBanner';
import { useEntityPicture } from './useEntityPicture';

const ON_BANNER = 'flex min-h-[44px] items-center rounded-full bg-white/95 px-3.5 text-[13px] font-extrabold text-reason-ink shadow-[0_6px_18px_rgba(0,0,0,.18)] backdrop-blur disabled:cursor-default disabled:opacity-70';

export default function EntityBanner({ page }: { page: EntityPage }) {
  const { entity, canEdit } = page;
  const banner = useEntityPicture(entity, 'banner', !!entity.bannerUrl);
  const [confirming, setConfirming] = useState(false);
  if (!entity.bannerUrl && !canEdit) return null;

  const remove = async () => {
    try {
      await banner.remove();
      setConfirming(false);
    } catch {
      // Said in a toast by the hook; the dialog stays open to try again or cancel.
    }
  };

  return (
    <div className="mb-[11px] md:mb-[18px]" data-testid="entity-banner">
      <ProfileBanner src={entity.bannerUrl ?? null}>
        {canEdit && (
          <div className="absolute bottom-2 right-2 flex items-center gap-2 md:bottom-3 md:right-3">
            {entity.bannerUrl && (
              <button type="button" onClick={() => setConfirming(true)} disabled={banner.busy} className={ON_BANNER}>{banner.words.remove}</button>
            )}
            <PencilButton label={banner.words.edit} onClick={banner.edit} disabled={banner.busy} />
          </div>
        )}
      </ProfileBanner>
      {canEdit && (
        <>
          <PictureEditor {...banner.editor} />
          <ConfirmDialog
            open={confirming}
            title="Remove the banner?"
            body={`${entity.name}'s page shows no banner until you add one again.`}
            confirmLabel="Remove"
            tone="danger"
            busy={banner.removing}
            busyLabel="Removing…"
            onConfirm={() => void remove()}
            onCancel={() => setConfirming(false)}
          />
        </>
      )}
    </div>
  );
}
