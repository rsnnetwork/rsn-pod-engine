// An author's edit of their own post or comment, in place of its words (Shirley pilot S4).
//
// What was typed is kept until the server has taken it: a refusal (the post was removed a moment ago, it was edited in
// another tab, the edit limit, an archived space, a lost connection) is said under the box in words and the text stays,
// so it can be copied. The text itself is held by the caller (`draft`), so a card that is drawn again keeps it.
// Escape cancels; Ctrl or Cmd + Enter saves. Save and Cancel are 44px targets that wrap under the box on a phone.

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { wallErrorSentence } from './wall-logic';

export default function WallEditForm({
  draft, onDraft, original, maxLength, allowEmpty, gone, label, onSave, onCancel, testId,
}: {
  draft: string;
  onDraft: (text: string) => void;
  /** The words as they stand: Save waits for a change. */
  original: string;
  maxLength: number;
  /** A post that keeps a picture or a shared post may be left without words. */
  allowEmpty: boolean;
  /** The post or comment was removed while this was open: nothing can be saved, the text stays to be copied. */
  gone?: string;
  label: string;
  onSave: (text: string) => Promise<void>;
  onCancel: () => void;
  testId: string;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const trimmed = draft.trim();
  const unchanged = trimmed === original.trim();
  const blocked = !!gone || saving || unchanged || (!allowEmpty && trimmed.length === 0);

  const save = async () => {
    if (blocked) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmed);
    } catch (err) {
      setError(wallErrorSentence(err, 'Could not save your changes. Try again.'));
    } finally {
      setSaving(false);
    }
  };

  const problem = gone ?? error;
  return (
    <div className="mt-1 space-y-2" data-testid={testId}>
      <textarea
        ref={box}
        value={draft}
        onChange={(e) => { onDraft(e.target.value); setError(null); }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
        }}
        maxLength={maxLength}
        rows={4}
        aria-label={label}
        aria-invalid={!!problem}
        aria-describedby={problem ? `${testId}-error` : undefined}
        className="min-h-[88px] w-full resize-y rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-rsn-red/30"
      />
      {problem && (
        <p id={`${testId}-error`} role="alert" className="text-xs text-red-600" data-testid={`${testId}-error`}>
          {problem}{gone ? ' Copy your text if you want to keep it.' : ''}
        </p>
      )}
      {draft.length > maxLength - 200 && (
        <p className="text-right text-[11px] text-gray-400">{draft.length} / {maxLength}</p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} className="min-h-[44px] min-w-[44px]" data-testid={`${testId}-cancel`}>
          {gone ? 'Close' : 'Cancel'}
        </Button>
        {!gone && (
          <Button size="sm" onClick={() => void save()} disabled={blocked} className="min-h-[44px] min-w-[44px]" data-testid={`${testId}-save`}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        )}
      </div>
    </div>
  );
}
