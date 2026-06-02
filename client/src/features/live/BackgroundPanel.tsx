// Background-effects picker used by the breakout VideoRoom (inline dropdown
// variant). The lobby keeps its own modal/bottom-sheet markup but shares the
// same hook + preset helpers, so the apply/persist/degrade logic is identical.
import { useCallback } from 'react';
import { BG_PRESETS, presetToPreference, isActivePreset, isCustomActive } from '@/lib/backgroundEffects';
import type { BgPreference } from '@/lib/bgPreference';

interface Props {
  current: BgPreference;
  degraded: boolean;
  onApply: (pref: BgPreference) => void;
  onClose: () => void;
}

export function BackgroundPanel({ current, degraded, onApply, onClose }: Props) {
  const handleUpload = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      onApply({ mode: 'image', imageUrl: URL.createObjectURL(file) });
      onClose();
    };
    input.click();
  }, [onApply, onClose]);

  return (
    <div className="absolute top-full left-0 mt-2 bg-white rounded-xl shadow-xl border border-gray-200 p-3 w-56 sm:w-72 max-w-[calc(100vw-2rem)] z-50">
      <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Background Effects</p>

      {degraded && (
        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5 mb-2 leading-snug">
          Background turned off — your device couldn't keep up. You can try again, but video may be smoother without it.
        </p>
      )}

      <div className="grid grid-cols-3 gap-2">
        {BG_PRESETS.map((preset) => (
          <button
            key={preset.label}
            onClick={() => { onApply(presetToPreference(preset)); onClose(); }}
            className={`rounded-lg border-2 overflow-hidden transition-all ${
              isActivePreset(preset, current)
                ? 'border-rsn-red ring-2 ring-rsn-red/30'
                : 'border-gray-200 hover:border-gray-400'
            }`}
          >
            {preset.image ? (
              <img src={preset.image} alt={preset.label} className="w-full h-14 object-cover" loading="lazy" />
            ) : (
              <div
                className={`w-full h-14 flex items-center justify-center text-xs font-medium ${
                  preset.mode === 'disabled' ? 'bg-gray-100 text-gray-500' : 'bg-indigo-50 text-indigo-600'
                }`}
              >
                {preset.label}
              </div>
            )}
            <p className="text-[10px] text-gray-500 py-0.5 text-center">{preset.label}</p>
          </button>
        ))}

        {/* Custom upload */}
        <button
          onClick={handleUpload}
          className={`rounded-lg border-2 border-dashed overflow-hidden transition-all ${
            isCustomActive(current) ? 'border-rsn-red ring-2 ring-rsn-red/30' : 'border-gray-300 hover:border-gray-400'
          }`}
        >
          <div className="w-full h-14 flex items-center justify-center text-xs font-medium text-gray-400">
            + Upload
          </div>
          <p className="text-[10px] text-gray-400 py-0.5 text-center">Custom</p>
        </button>
      </div>
    </div>
  );
}
