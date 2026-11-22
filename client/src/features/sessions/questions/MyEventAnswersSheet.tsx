// ─── "Before you join": a member's group and answers on the event page (Part 3 Task 10; spec 02, 05) ────────────────
// Opened when Register (or the page's automatic registration) is refused because the event needs something first:
// 409 EVENT_GROUP_REQUIRED (choose your group) or EVENT_ANSWERS_REQUIRED (a required matching question). Before this, a
// member on a group event read "Choose your group for this event first." with nothing to choose from. The sheet shows
// the group tiles (when the event has groups and the person has none) and the event's questions, then hands
// `{ groupKeys, answers }` back for the page to register again with them.
//
// In 'edit' mode it is "Your answers": the questions only, the person's own answers filled in, saved with
// PUT /questions/mine (until the event goes live). A Sheet, portalled to <body>.
import { useId } from 'react';
import { Loader2 } from 'lucide-react';
import Sheet from '@/features/reason/ui/Sheet';
import { useToastStore } from '@/stores/toastStore';
import { organiserSentence } from '../organiser-errors';
import { ErrorRow, LoadingRows, PRIMARY_BUTTON, QUIET_BUTTON } from '../organiser-ui';
import { useEventGroups } from '../groups/useEventGroups';
import EventAnswersForm, { type GivenAnswers, type GroupAsk } from './EventAnswersForm';
import { QUESTIONS_COPY } from './question-form';
import { useEventQuestions, useSaveMyAnswers } from './useEventQuestions';

interface Props {
  sessionId: string;
  open: boolean;
  onClose: () => void;
  mode: 'join' | 'edit';
  /** 'join': the button's words (Register, Join Late, Join the waiting list) and the registration, with the answers. */
  submitLabel?: string;
  busy?: boolean;
  onJoin?: (given: GivenAnswers) => Promise<unknown>;
}

export default function MyEventAnswersSheet({ sessionId, open, onClose, mode, submitLabel, busy = false, onJoin }: Props) {
  const formId = useId();
  const addToast = useToastStore((s) => s.addToast);
  const join = mode === 'join';
  const questions = useEventQuestions(sessionId, open);
  const groups = useEventGroups(sessionId, open && join);
  const save = useSaveMyAnswers(sessionId);
  const pending = busy || save.isPending;

  const groupView = groups.data;
  const group: GroupAsk | null = join && groupView && groupView.groups.length > 0 && groupView.mine.length === 0
    ? { question: groupView.question, multiple: groupView.allowMultiple, options: groupView.groups }
    : null;
  const loading = questions.isLoading || (join && groups.isLoading);
  // A group read refused (403/404) asks no group; a questions read refused leaves nothing to answer here.
  const failed = questions.isError && !notFound(questions.error);

  const onSubmit = async (given: GivenAnswers) => {
    if (join) {
      await onJoin?.(given)?.catch(() => undefined);
      return;
    }
    try {
      await save.mutateAsync(given.answers);
      addToast(QUESTIONS_COPY.answersSaved, 'success');
      onClose();
    } catch (err) {
      addToast(organiserSentence(err, QUESTIONS_COPY.fallback), 'error');
    }
  };

  return (
    <Sheet
      open={open}
      onClose={() => { if (!pending) onClose(); }}
      title={join ? QUESTIONS_COPY.sheetTitle : QUESTIONS_COPY.yourAnswers}
      footer={(
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <button type="button" onClick={onClose} disabled={pending} className={QUIET_BUTTON}>Cancel</button>
          <button type="submit" form={formId} disabled={pending || loading || failed} data-testid="answers-submit" className={PRIMARY_BUTTON}>
            {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {join ? (submitLabel ?? 'Register') : QUESTIONS_COPY.saveAnswers}
          </button>
        </div>
      )}
    >
      <div data-testid={join ? 'before-you-join-sheet' : 'your-answers-sheet'} className="space-y-4 pb-2 pt-1">
        <p className="text-sm text-gray-600">{join ? QUESTIONS_COPY.sheetIntro : QUESTIONS_COPY.yourAnswersHint}</p>
        {loading && <LoadingRows label="Loading the questions" rows={3} />}
        {failed && <ErrorRow message={QUESTIONS_COPY.error} onRetry={() => void questions.refetch()} />}
        {!loading && !failed && (
          <EventAnswersForm
            formId={formId}
            group={group}
            questions={questions.data?.questions ?? []}
            mine={questions.data?.mine ?? {}}
            clearEmpty={!join}
            onSubmit={onSubmit}
          />
        )}
      </div>
    </Sheet>
  );
}

function notFound(err: unknown): boolean {
  const status = (err as { response?: { status?: number } } | null)?.response?.status;
  return status === 403 || status === 404;
}
