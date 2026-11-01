// client/src/components/picture/PictureFrame.tsx
// The frame of the picture editor (30 Oct review, T3a): exactly the part that will be kept, with the picture under it.
// Drag it with a finger or the mouse, pinch it with two fingers, or move it with the arrow keys (+ and - zoom). The
// frame alone takes the touch (touch-none), so dragging never scrolls the page or the sheet. Controlled: the crop
// lives with the editor, and every change goes through the same arithmetic the server cuts with.
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { PictureCrop } from '@rsn/shared';
import { cn } from '@/lib/utils';
import { keyedCrop, panPicture, pictureView, pinchZoom, zoomPicture, type Natural } from './picture-geometry';

interface Props {
  src: string;
  aspect: number;
  crop: PictureCrop;
  /** The picture's own size, once it has loaded. */
  natural: Natural | null;
  onCrop: (crop: PictureCrop) => void;
  onLoad: (natural: Natural) => void;
  onError: () => void;
  /** What a screen reader hears, e.g. "Your photo. Drag to place it, or use the arrow keys; plus and minus zoom." */
  label: string;
  disabled?: boolean;
}

type Gesture = { kind: 'drag'; x: number; y: number } | { kind: 'pinch'; distance: number; zoom: number } | null;
type Point = { x: number; y: number };

const spread = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

export default function PictureFrame({ src, aspect, crop, natural, onCrop, onLoad, onError, label, disabled }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  // The newest crop, read by a move that comes before React has drawn the last one.
  const latest = useRef(crop);
  latest.current = crop;
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture>(null);
  const ready = !!natural && width > 0 && !disabled;

  const change = (next: PictureCrop) => {
    latest.current = next;
    onCrop(next);
  };

  // A gesture starts again from where the fingers are whenever one is put down or lifted.
  const begin = () => {
    const [a, b] = [...pointers.current.values()];
    if (a && b) gesture.current = { kind: 'pinch', distance: spread(a, b), zoom: latest.current.zoom };
    else if (a) gesture.current = { kind: 'drag', x: a.x, y: a.y };
    else gesture.current = null;
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!ready) return;
    // Keeps the drag when the finger leaves the frame. A pointer that is already gone cannot be captured, and the drag
    // then simply ends at the frame's edge, so a refusal here changes nothing else.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* see above */ }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    begin();
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!ready || !natural || !pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (g?.kind === 'pinch') {
      const [a, b] = [...pointers.current.values()];
      if (a && b) change(zoomPicture(latest.current, pinchZoom(g.zoom, g.distance, spread(a, b)), natural, aspect));
    } else if (g?.kind === 'drag') {
      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      g.x = e.clientX;
      g.y = e.clientY;
      if (dx || dy) change(panPicture(latest.current, dx, dy, natural, width, aspect));
    }
  };

  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    begin();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!ready || !natural) return;
    const next = keyedCrop(latest.current, e.key, e.shiftKey, natural, aspect);
    if (!next) return;
    e.preventDefault();
    change(next);
  };

  const view = natural && width > 0 ? pictureView(crop, natural, width, aspect) : null;
  return (
    <div
      ref={box}
      role="group"
      tabIndex={0}
      aria-label={label}
      data-testid="picture-frame"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onKeyDown={onKeyDown}
      style={{ aspectRatio: String(aspect) }}
      className={cn(
        'relative w-full touch-none select-none overflow-hidden rounded-[16px] bg-[#eceae6] outline-none focus-visible:ring-2 focus-visible:ring-reason-red focus-visible:ring-offset-2',
        ready ? 'cursor-grab active:cursor-grabbing' : 'cursor-default',
      )}
    >
      <img
        src={src}
        alt=""
        draggable={false}
        onLoad={(e) => onLoad({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
        onError={onError}
        className="pointer-events-none absolute max-w-none"
        style={view ? { left: view.left, top: view.top, width: view.width, height: view.height } : { opacity: 0 }}
      />
      {/* A photo shows round in most places (lists, chats, the header): the ring is where those will cut it. */}
      {aspect === 1 && view && <div aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-inset ring-white/80" />}
    </div>
  );
}
