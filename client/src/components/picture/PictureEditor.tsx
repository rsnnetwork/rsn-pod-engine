// client/src/components/picture/PictureEditor.tsx
// The picture editor (30 Oct review, T3a: "Edit button that allows to fix the size or position"), opened by the
// pencil on a photo or a banner, and by the entity logo and banner later (T15). A sheet (portalled to <body>) with the
// frame (drag, pinch, arrows), a zoom slider, a way to choose another picture, and Cancel and Save.
// `src` is what it opens on: a picture the member already has (an address or a data URL; Save then sends only the
// new crop, as null) or a file they just chose (a Blob; Save sends it). With none it asks for a picture.
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { PICTURE_CENTRED, clampPictureCrop, type PictureCrop } from '@rsn/shared';
import { Skeleton } from '@/components/ui/Spinner';
import Sheet from '@/features/reason/ui/Sheet';
import { errorMessage } from '@/features/reason/errors';
import PictureFrame from './PictureFrame';
import ZoomControl from './ZoomControl';
import { PICTURE_TYPES, pictureFileProblem } from './picture-file';
import { zoomPicture, type Natural } from './picture-geometry';
import { PICTURE_TOO_LARGE, UNREADABLE_PICTURE } from './prepare-picture';

export interface PictureEditorProps {
  open: boolean;
  /** "Edit your photo", "Edit your banner". */
  title: string;
  /** What the picture is, in the editor's sentences: "photo", "banner", "logo". */
  name: string;
  /** 1 for a photo or a logo, 3 for a banner. */
  aspect: 1 | 3;
  src: string | Blob | null;
  /** The kept picture is still being fetched. */
  loading?: boolean;
  /** Said when the kept picture could not be fetched. */
  loadError?: string | null;
  /** Where the picture was placed last time; null opens it centred. */
  initialCrop: PictureCrop | null;
  /** The chosen file (null when the picture is the one they had) and the crop. Rejects with what went wrong. */
  onSave: (picture: Blob | null, crop: PictureCrop) => Promise<unknown>;
  onCancel: () => void;
}

interface Shown { src: string; file: Blob | null }

const QUIET = 'flex min-h-[44px] items-center justify-center rounded-[11px] border border-reason-line bg-white px-4 text-[14px] font-bold disabled:opacity-60';
const PRIMARY = 'flex min-h-[44px] items-center justify-center rounded-[11px] bg-reason-red px-5 text-[14px] font-bold text-white disabled:opacity-60';

export default function PictureEditor({ open, title, name, aspect, src, loading, loadError, initialCrop, onSave, onCancel }: PictureEditorProps) {
  const [shown, setShown] = useState<Shown | null>(null);
  const [natural, setNatural] = useState<Natural | null>(null);
  const [crop, setCrop] = useState<PictureCrop>(PICTURE_CENTRED);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const objectUrl = useRef<string | null>(null);

  const letGo = () => {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
  };
  const show = (picture: string | Blob | null, placed: PictureCrop | null) => {
    letGo();
    if (picture instanceof Blob) objectUrl.current = URL.createObjectURL(picture);
    setShown(picture === null ? null : { src: objectUrl.current ?? (picture as string), file: picture instanceof Blob ? picture : null });
    setNatural(null);
    setCrop(placed ?? PICTURE_CENTRED);
  };

  // Each time it opens, or the picture it opens on arrives, it starts from that picture and its crop.
  useEffect(() => {
    if (!open) return;
    show(src, src instanceof Blob ? null : initialCrop);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initialCrop arrives with src; a new object for the same crop must not reset a placement in progress
  }, [open, src]);
  useEffect(() => letGo, []);

  const onLoaded = (size: Natural) => {
    setNatural(size);
    setCrop((c) => clampPictureCrop(c, size.width, size.height, aspect));
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Cleared at once, so the same picture can be chosen again after a failure.
    e.target.value = '';
    if (!file) return;
    const problem = pictureFileProblem(file, name);
    setError(problem);
    if (!problem) show(file, null);
  };

  const save = async () => {
    if (!shown || !natural || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(shown.file, clampPictureCrop(crop, natural.width, natural.height, aspect));
    } catch (err) {
      const own = err instanceof Error && [UNREADABLE_PICTURE, PICTURE_TOO_LARGE].includes(err.message);
      setError(own ? (err as Error).message : errorMessage(err, `Could not save your ${name} right now. Try again in a moment.`));
    } finally {
      setBusy(false);
    }
  };

  const close = () => { if (!busy) onCancel(); };
  const frameBox = aspect === 1 ? 'mx-auto w-full max-w-[min(100%,44dvh)]' : 'w-full';
  return (
    <Sheet
      open={open}
      onClose={close}
      title={title}
      footer={(
        <>
          <button type="button" onClick={close} disabled={busy} className={QUIET}>Cancel</button>
          <button type="button" onClick={() => void save()} disabled={busy || !shown || !natural} className={PRIMARY}>
            {busy ? 'Saving...' : 'Save'}
          </button>
        </>
      )}
    >
      <div className="grid gap-3 py-2" aria-busy={busy || loading || undefined}>
        <div className={frameBox}>
          {loading ? (
            <Skeleton className={aspect === 1 ? 'aspect-square w-full rounded-[16px]' : 'aspect-[3/1] w-full rounded-[16px]'} />
          ) : shown ? (
            <PictureFrame
              src={shown.src}
              aspect={aspect}
              crop={crop}
              natural={natural}
              onCrop={setCrop}
              onLoad={onLoaded}
              onError={() => { setError(UNREADABLE_PICTURE); setNatural(null); }}
              label={`Your ${name}. Drag to place it, or use the arrow keys; plus and minus zoom.`}
              disabled={busy}
            />
          ) : (
            <div className="grid w-full place-items-center rounded-[16px] border border-dashed border-reason-line bg-reason-soft p-4 text-center text-[14px] text-reason-muted" style={{ aspectRatio: String(aspect) }}>
              No {name} yet. Choose a picture to place it.
            </div>
          )}
        </div>
        {shown && natural && (
          <>
            <p className="text-[13px] text-reason-muted">Drag the picture to place it. Pinch, or use the slider, to zoom.</p>
            <ZoomControl zoom={crop.zoom} onZoom={(z) => setCrop((c) => zoomPicture(c, z, natural, aspect))} disabled={busy} />
          </>
        )}
        <button type="button" onClick={() => picker.current?.click()} disabled={busy || loading} className={QUIET}>
          {shown ? 'Choose another picture' : 'Choose a picture'}
        </button>
        <input ref={picker} type="file" accept={PICTURE_TYPES.join(',')} onChange={onPick} className="hidden" aria-label={`Choose a picture for your ${name}`} />
        {(error ?? loadError) && <p role="alert" className="text-[13px] font-semibold text-reason-red">{error ?? loadError}</p>}
      </div>
    </Sheet>
  );
}
