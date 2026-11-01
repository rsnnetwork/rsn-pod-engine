// client/src/components/picture/ZoomControl.tsx
// The editor's zoom (30 Oct review, T3a): a slider from 1 to 4 between a minus and a plus, each 44px, so a thumb can
// work it on a phone and the keyboard can too (the slider takes arrows, the buttons take Enter).
import { Minus, Plus } from 'lucide-react';
import { PICTURE_MAX_ZOOM } from '@rsn/shared';
import { ZOOM_STEP } from './picture-geometry';

interface Props {
  zoom: number;
  onZoom: (zoom: number) => void;
  disabled?: boolean;
}

const STEP_BUTTON = 'grid h-11 w-11 shrink-0 place-items-center rounded-full border border-reason-line bg-white text-reason-ink disabled:opacity-50';

export default function ZoomControl({ zoom, onZoom, disabled }: Props) {
  return (
    <div className="flex items-center gap-2">
      <button type="button" aria-label="Zoom out" disabled={disabled || zoom <= 1} onClick={() => onZoom(zoom - ZOOM_STEP * 2)} className={STEP_BUTTON}>
        <Minus className="h-4 w-4" aria-hidden="true" />
      </button>
      <label className="flex h-11 min-w-0 flex-1 items-center">
        <span className="sr-only">Zoom</span>
        <input
          type="range"
          min={1}
          max={PICTURE_MAX_ZOOM}
          step={0.01}
          value={zoom}
          disabled={disabled}
          onChange={(e) => onZoom(Number(e.target.value))}
          className="h-11 w-full cursor-pointer accent-reason-red"
        />
      </label>
      <button type="button" aria-label="Zoom in" disabled={disabled || zoom >= PICTURE_MAX_ZOOM} onClick={() => onZoom(zoom + ZOOM_STEP * 2)} className={STEP_BUTTON}>
        <Plus className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
