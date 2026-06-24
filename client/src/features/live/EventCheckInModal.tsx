import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useToastStore } from '@/stores/toastStore';
import api from '@/lib/api';

// Phase 2 (matching) — a quick, skippable check-in: the member's intention for
// THIS event + how open they are to unexpected matches. Pops once per session
// (sessionStorage) when they enter the live event; posts to
// /sessions/:id/intention, which the matching engine reads as a per-event overlay.
const SUGGESTIONS = [
  'Meet investors', 'Meet founders', 'Find clients', 'Find partners',
  'Get advice', 'Give advice', 'Hire talent', 'Find a job', 'Just meet interesting people',
];
type Openness = 'very_open' | 'somewhat' | 'only_relevant';

export default function EventCheckInModal() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { addToast } = useToastStore();
  const [open, setOpen] = useState(false);
  const [intention, setIntention] = useState('');
  const [openness, setOpenness] = useState<Openness>('somewhat');
  const [saving, setSaving] = useState(false);
  const seenKey = sessionId ? `rsn_checkin_${sessionId}` : '';

  useEffect(() => {
    if (!sessionId || !seenKey) return;
    if (sessionStorage.getItem(seenKey)) return;
    setOpen(true);
  }, [sessionId, seenKey]);

  function dismiss() {
    if (seenKey) sessionStorage.setItem(seenKey, '1');
    setOpen(false);
  }

  async function save() {
    if (!sessionId) return;
    setSaving(true);
    try {
      await api.post(`/sessions/${sessionId}/intention`, {
        intention: intention.trim() || null,
        openness,
      });
      addToast('Thanks, we will use this for your matches.', 'success');
      dismiss();
    } catch {
      dismiss(); // never block entering the event on this
    } finally {
      setSaving(false);
    }
  }

  if (!sessionId) return null;

  return (
    <Modal open={open} onClose={dismiss} className="max-w-md">
      <div className="flex flex-col gap-5 pt-2">
        <div className="text-center">
          <h2 className="font-display text-xl font-semibold text-[#1a1a2e]">What brings you here today?</h2>
          <p className="mt-1 text-sm text-gray-500">A quick steer helps us match you better this event. Optional.</p>
        </div>

        <input
          value={intention}
          onChange={(e) => setIntention(e.target.value)}
          placeholder="e.g. meet investors"
          aria-label="Your intention for this event"
          className="w-full rounded-lg border-2 border-gray-300 bg-white px-3 py-2.5 text-base text-[#1a1a2e] placeholder:text-gray-400 focus:border-rsn-red focus:outline-none"
        />
        <div className="flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setIntention(s)}
              className={`rounded-full px-3 py-1 text-xs transition-colors ${
                intention === s ? 'bg-rsn-red text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        <div>
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-gray-400">
            How open to unexpected matches?
          </p>
          <div className="grid grid-cols-3 gap-2">
            {([['very_open', 'Very open'], ['somewhat', 'Somewhat'], ['only_relevant', 'Only relevant']] as const).map(
              ([v, l]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setOpenness(v)}
                  className={`min-h-[44px] rounded-lg border text-sm transition-colors ${
                    openness === v
                      ? 'border-rsn-red bg-rsn-red-light/40 text-[#1a1a2e]'
                      : 'border-gray-300 text-gray-600 hover:border-gray-400'
                  }`}
                >
                  {l}
                </button>
              )
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button onClick={save} isLoading={saving} className="min-h-[48px] flex-1 justify-center text-base">
            Set
          </Button>
          <button
            type="button"
            onClick={dismiss}
            className="min-h-[44px] px-4 text-sm font-medium text-gray-400 transition-colors hover:text-gray-600"
          >
            Skip
          </button>
        </div>
      </div>
    </Modal>
  );
}
