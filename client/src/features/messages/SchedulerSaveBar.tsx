// The bar at the bottom of the scheduler. While there are unsaved picks it is pinned to the bottom of the panel's
// frame, so Save is in reach however far the timeline scrolls; -bottom-3 offsets the panel's own py-3, so the bar sits
// flush on the frame with no strip of content showing under it. Closing with times not sent turns it into "Send your
// times?" (Send / Discard), which a blur of the typed time never takes away.

import type { RefObject } from 'react';
import { Button } from '@/components/ui/Button';
import { ASK_SEND } from './scheduler-flow';

interface Props {
  barRef: RefObject<HTMLDivElement>;
  unsaved: boolean;
  asking: boolean;
  saving: boolean;
  /** The line on the left when nothing is being asked. */
  hint: string;
  /** The panel can be closed from here (Close / Done). */
  closable: boolean;
  onRequestClose: () => void;
  onSave: () => void;
  onDiscard: () => void;
}

// A press on Send or Discard must not move the focus first: the typed time's
// blur would change the panel under the pointer before the click lands.
const keepFocus = (e: { preventDefault: () => void }) => e.preventDefault();

export default function SchedulerSaveBar({
  barRef, unsaved, asking, saving, hint, closable, onRequestClose, onSave, onDiscard,
}: Props) {
  return (
    <div
      ref={barRef}
      data-pinned={unsaved}
      data-testid="save-bar"
      className={`flex items-center justify-between gap-2 flex-wrap ${
        unsaved
          ? `sticky -bottom-3 z-10 -mx-3 !-mb-3 border-t px-3 py-2 ${asking ? 'border-amber-300 bg-amber-50' : 'border-gray-200 bg-gray-50'}`
          : ''
      }`}
    >
      {asking && unsaved ? (
        <>
          <p className="text-sm font-semibold text-[#1a1a2e]" role="status">{ASK_SEND}</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onMouseDown={keepFocus}
              onClick={onDiscard}
              disabled={saving}
              className="min-h-[44px] rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Discard
            </button>
            <Button size="sm" onMouseDown={keepFocus} onClick={onSave} disabled={saving} className="min-h-[44px]">
              {saving ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-[11px] text-gray-500">{hint}</p>
          <div className="flex items-center gap-2">
            {/* An explicit way out. Before this the only exits were a tap outside
                or Escape, so the panel read as a trap (19 Sep). */}
            {closable && (
              <button
                type="button"
                onClick={onRequestClose}
                className="min-h-[44px] rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                {unsaved ? 'Close' : 'Done'}
              </button>
            )}
            {unsaved && (
              <Button size="sm" onClick={onSave} disabled={saving} className="min-h-[44px]">
                {saving ? 'Sending…' : 'Save and send availability'}
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
