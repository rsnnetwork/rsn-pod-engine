// client/src/features/sessions/EventImage.tsx
// An event's image (10 Nov 2026 spec, Part 3 item 1: "event setup: imagery"): a 3:1 strip, the cut the server makes
// (1200 by 400). The box has its shape before the picture arrives, so nothing on the page moves when it loads.
//
//   EventImage        the strip itself: on an event card (lazy, decorative, alt="") or at the head of the event page
//                     (eager, named by the event's title). With no image, or one that fails to load, a card shows none.
//   EventImageHeader  the event page's strip with its organiser's controls: only the event's host and platform admins
//                     (the people the server lets change it) see "Add image", "Change image" and "Remove image", each
//                     44px tall; Remove asks first. Everyone else sees the strip only when there is an image.
import { useState, type ReactNode } from 'react';
import { ImagePlus } from 'lucide-react';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import PictureEditor from '@/components/picture/PictureEditor';
import { cn } from '@/lib/utils';
import { EVENT_IMAGE_WORDS, useEventImage } from './useEventImage';

/** The strip's box by where it is drawn: always 3:1 to the width, a wide screen showing its middle band. */
const BOX = {
  card: 'aspect-[3/1] max-h-[132px] rounded-xl',
  header: 'aspect-[3/1] max-h-[260px] rounded-2xl',
} as const;

interface EventImageProps {
  src: string | null | undefined;
  /** '' for a decorative copy (a card, beside the title it repeats); the event's title at the head of its page. */
  alt?: string;
  variant?: keyof typeof BOX;
  /** 'lazy' in lists; the event page's own image is 'eager'. */
  loading?: 'lazy' | 'eager';
  className?: string;
  /** Controls drawn over the image (the organiser's). With them, a failed image keeps its box so they stay in reach. */
  children?: ReactNode;
}

export default function EventImage({ src, alt = '', variant = 'card', loading = 'lazy', className, children }: EventImageProps) {
  // Which address failed, so a new image (a new ?v= address) is tried again.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showing = !!src && src !== failedSrc;
  if (!showing && !children) return null;
  return (
    <div
      className={cn('relative w-full overflow-hidden bg-gradient-to-r from-[#1a1a2e] via-[#3a1f3d] to-rsn-red', BOX[variant], className)}
      data-testid="event-image"
    >
      {showing && (
        <img
          src={src}
          alt={alt}
          loading={loading}
          decoding="async"
          width={1200}
          height={400}
          onError={() => setFailedSrc(src)}
          className="absolute inset-0 h-full w-full bg-gray-100 object-cover"
        />
      )}
      {children}
    </div>
  );
}

const ON_IMAGE = 'inline-flex min-h-[44px] items-center rounded-full bg-white/95 px-3.5 text-[13px] font-bold text-[#1a1a2e] shadow-[0_6px_18px_rgba(0,0,0,.18)] backdrop-blur disabled:cursor-default disabled:opacity-70';

interface HeaderProps {
  sessionId: string;
  src: string | null | undefined;
  title: string;
  /** The event's host or a platform admin: the server's own rule for who may change the image. */
  canChange: boolean;
}

export function EventImageHeader({ sessionId, src, title, canChange }: HeaderProps) {
  const image = useEventImage(sessionId, !!src);
  const [confirming, setConfirming] = useState(false);
  if (!src && !canChange) return null;

  const remove = async () => {
    try {
      await image.remove();
      setConfirming(false);
    } catch {
      // Said in a toast by the hook; the dialog stays open to try again or cancel.
    }
  };

  return (
    <div className="mb-4" data-testid="event-image-header">
      {src ? (
        <EventImage src={src} alt={title} variant="header" loading="eager">
          {canChange && (
            <div className="absolute bottom-2 right-2 flex flex-wrap justify-end gap-2 md:bottom-3 md:right-3">
              <button type="button" onClick={() => setConfirming(true)} disabled={image.busy} className={ON_IMAGE}>
                {EVENT_IMAGE_WORDS.remove}
              </button>
              <button type="button" onClick={image.edit} disabled={image.busy} className={ON_IMAGE} data-testid="event-image-change">
                {EVENT_IMAGE_WORDS.change}
              </button>
            </div>
          )}
        </EventImage>
      ) : (
        <button
          type="button"
          onClick={image.edit}
          disabled={image.busy}
          data-testid="event-image-add"
          className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-dashed border-gray-300 bg-white px-4 text-sm font-semibold text-[#1a1a2e] transition-colors hover:bg-gray-50 disabled:opacity-60"
        >
          <ImagePlus className="h-4 w-4" aria-hidden="true" /> {EVENT_IMAGE_WORDS.add}
        </button>
      )}
      {canChange && (
        <>
          <PictureEditor {...image.editor} />
          <ConfirmDialog
            open={confirming}
            title={EVENT_IMAGE_WORDS.confirmTitle}
            body={EVENT_IMAGE_WORDS.confirmBody}
            confirmLabel="Remove"
            tone="danger"
            busy={image.removing}
            busyLabel="Removing…"
            onConfirm={() => void remove()}
            onCancel={() => setConfirming(false)}
          />
        </>
      )}
    </div>
  );
}
