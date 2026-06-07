// THE background picker — one component for the lobby, breakout and manual
// rooms (desktop + mobile), driven by the event-scoped engine so the active
// tile / applying state / degraded notice are identical everywhere.
// Mobile: full-width bottom sheet. Desktop: centered card. Esc/click-out close.
import { useEffect } from 'react';
import { Loader2, X } from 'lucide-react';
import { BG_PRESETS, presetToPreference, isActivePreset, isCustomActive } from '@/lib/backgroundEffects';
import type { BgPreference } from '@/lib/bgPreference';

interface Props {
  current: BgPreference;
  degraded: boolean;
  applying: boolean;
  onApply: (pref: BgPreference) => void;
  onUpload: (file: Blob) => void;
  onClose: () => void;
}

export function BackgroundPanel({ current, degraded, applying, onApply, onUpload, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleUpload = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      onUpload(file);
      onClose();
    };
    input.click();
  };

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-label="Choose background"
        className="fixed z-50 left-1/2 -translate-x-1/2 bottom-0 sm:bottom-auto sm:top-1/2 sm:-translate-y-1/2 w-full sm:w-[28rem] max-w-[95vw] bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl border-t sm:border border-gray-200 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            Background
            {applying && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-600">
                <Loader2 className="h-3 w-3 animate-spin" /> Applying…
              </span>
            )}
          </p>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 p-3 -m-2 rounded"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {degraded && (
          <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5 mb-3 leading-snug">
            Background turned off — your device couldn't keep up. You can try again, but video may be smoother without it.
          </p>
        )}
        <div className="grid grid-cols-3 gap-2">
          {BG_PRESETS.map((preset) => (
            <button
              key={preset.label}
              onClick={() => { onApply(presetToPreference(preset)); onClose(); }}
              className={`rounded-lg border-2 overflow-hidden transition-colors min-h-[44px] ${
                isActivePreset(preset, current)
                  ? 'border-rsn-red ring-2 ring-rsn-red/20'
                  : 'border-gray-200 hover:border-gray-400'
              }`}
            >
              {preset.image ? (
                <div className="relative">
                  <img src={preset.image} alt={preset.label} className="w-full h-20 object-cover" loading="lazy" />
                  <span className="absolute bottom-0 inset-x-0 bg-black/50 text-white text-[10px] font-medium py-0.5 text-center">{preset.label}</span>
                </div>
              ) : (
                <div className={`w-full h-20 flex items-center justify-center text-xs font-medium ${preset.mode === 'disabled' ? 'bg-gray-100 text-gray-600' : 'bg-indigo-50 text-indigo-600'}`}>{preset.label}</div>
              )}
            </button>
          ))}
          {/* Custom upload — persisted in IndexedDB so it survives refresh */}
          <button
            onClick={handleUpload}
            className={`rounded-lg border-2 border-dashed overflow-hidden transition-colors min-h-[44px] ${
              isCustomActive(current) ? 'border-rsn-red ring-2 ring-rsn-red/20' : 'border-gray-300 hover:border-gray-400'
            }`}
          >
            <div className="w-full h-20 flex items-center justify-center text-xs font-medium text-gray-400">+ Upload</div>
          </button>
        </div>
      </div>
    </>
  );
}
