// ─── "Extra matching questions" on the event page, for its organisers (Part 3 Task 10; spec 02; plan K5) ────────────
// Up to five questions the organiser writes, each with how many people chose each answer. Add question (until five),
// Edit (the editor sheet) and Remove (asked first: its answers are deleted). Before the event only: once it is live
// the card says the questions can't change and offers nothing. The line under the title is the K5 ruling for
// organisers: answers choose among allowed meetings and never override blocks or group rules. Organisers only: anyone
// else gets no `answers` in the read, and the card draws nothing.
import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import type { EventMatchingQuestion } from '@rsn/shared';
import { useConfirm } from '@/hooks/useConfirm';
import { useToastStore } from '@/stores/toastStore';
import { notForThisViewer, organiserSentence } from '../organiser-errors';
import { DANGER_BUTTON, EmptyRow, ErrorRow, LoadingRows, OrganiserCard, PRIMARY_BUTTON, QUIET_BUTTON } from '../organiser-ui';
import QuestionsEditorSheet from './QuestionsEditorSheet';
import { QUESTIONS_COPY, canAddQuestion, describeQuestion, optionCount, questionsWith, questionsWithout } from './question-form';
import { useEventQuestions, useSaveEventQuestions } from './useEventQuestions';

interface Props {
  sessionId: string;
  /** The event is live: the questions are locked (the server refuses a change too). */
  locked: boolean;
}

export default function EventQuestionsCard({ sessionId, locked }: Props) {
  const addToast = useToastStore((s) => s.addToast);
  const { ask, confirmDialog } = useConfirm();
  const view = useEventQuestions(sessionId);
  const save = useSaveEventQuestions(sessionId);
  // The question being edited: its index, or 'new'; null while the editor is closed.
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  if (view.isError && notForThisViewer(view.error)) return null;
  if (view.data && view.data.answers === undefined) return null;

  const saved = view.data?.questions ?? [];
  const index = typeof editing === 'number' ? editing : null;

  const saveList = (next: EventMatchingQuestion[], success: string) => {
    setServerError(null);
    return save.mutateAsync(next).then(() => {
      addToast(success, 'success');
      setEditing(null);
    }, (err: unknown) => {
      setServerError(organiserSentence(err, QUESTIONS_COPY.fallback));
      throw err;
    });
  };
  const saveOne = (q: EventMatchingQuestion) => saveList(questionsWith(saved, index, q), QUESTIONS_COPY.saved);
  const remove = async (i: number) => {
    if (!(await ask({ title: QUESTIONS_COPY.removeTitle, body: QUESTIONS_COPY.removeBody, confirmLabel: QUESTIONS_COPY.remove, tone: 'danger' }))) return;
    saveList(questionsWithout(saved, i), QUESTIONS_COPY.removed).catch((err: unknown) => addToast(organiserSentence(err, QUESTIONS_COPY.fallback), 'error'));
  };
  const open = (which: number | 'new') => { setServerError(null); setEditing(which); };

  return (
    <OrganiserCard
      testId="event-questions-card"
      title={QUESTIONS_COPY.title}
      hint={QUESTIONS_COPY.hint}
      action={view.data && !locked && canAddQuestion(saved) && (
        <button type="button" data-testid="questions-add" onClick={() => open('new')} className={saved.length > 0 ? QUIET_BUTTON : PRIMARY_BUTTON}>
          <Plus className="h-4 w-4" aria-hidden="true" /> {QUESTIONS_COPY.add}
        </button>
      )}
    >
      {view.isLoading && <LoadingRows label="Loading the questions" />}
      {view.isError && <ErrorRow message={QUESTIONS_COPY.error} onRetry={() => void view.refetch()} />}
      {locked && view.data && <p data-testid="questions-locked" className="mb-3 text-sm text-amber-700">{QUESTIONS_COPY.locked}</p>}
      {view.data && saved.length === 0 && <EmptyRow testId="questions-empty">{QUESTIONS_COPY.none}</EmptyRow>}
      {saved.length > 0 && (
        <ul className="space-y-3">
          {saved.map((q, i) => (
            <li key={q.key} data-testid="question-summary" className="min-w-0 rounded-xl border border-gray-200 p-3">
              <p className="font-medium text-[#1a1a2e] [overflow-wrap:anywhere]">{q.prompt}</p>
              <p className="mt-0.5 text-xs text-gray-500">{describeQuestion(q)}</p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {q.options.map((o) => (
                  <li key={o.key} className="inline-flex min-w-0 items-center gap-2 rounded-full bg-gray-100 px-3 py-1.5 text-sm text-[#1a1a2e]">
                    <span className="min-w-0 [overflow-wrap:anywhere]">{o.label}</span>
                    <span className="text-gray-500">{QUESTIONS_COPY.people(optionCount(view.data, q.key, o.key))}</span>
                  </li>
                ))}
              </ul>
              {!locked && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" data-testid="question-edit" onClick={() => open(i)} disabled={save.isPending} className={QUIET_BUTTON}>
                    <Pencil className="h-4 w-4" aria-hidden="true" /> {QUESTIONS_COPY.edit}
                  </button>
                  <button type="button" data-testid="question-remove" onClick={() => void remove(i)} disabled={save.isPending} className={DANGER_BUTTON}>
                    <Trash2 className="h-4 w-4" aria-hidden="true" /> {QUESTIONS_COPY.remove}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <QuestionsEditorSheet
        open={editing !== null && !locked}
        onClose={() => setEditing(null)}
        saved={saved}
        index={index}
        busy={save.isPending}
        onSave={saveOne}
        serverError={serverError}
      />
      {confirmDialog}
    </OrganiserCard>
  );
}
