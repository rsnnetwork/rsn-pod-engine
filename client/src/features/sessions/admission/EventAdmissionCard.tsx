// ─── Admission: who gets a place on this event (Part 2 Task 11; spec 04, D3) ────────────────────────────────────────
// The organiser picks one of three modes (react-hook-form + Zod, saved with Save) and, for Approval and Invitation
// only, keeps the allowed-email list and the admission codes. With no mode the event follows its "Who can join"
// setting exactly as before; "Use the usual rules again" puts it back there. Organisers only: anyone else's read is
// refused, and the card draws nothing.
import { useEffect, useId } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ADMISSION_MODES, type AdmissionMode } from '@rsn/shared';
import { useConfirm } from '@/hooks/useConfirm';
import { formResolver } from '@/lib/form-resolver';
import { cn } from '@/lib/utils';
import { useToastStore } from '@/stores/toastStore';
import { notForThisViewer, organiserSentence } from '../organiser-errors';
import { ErrorRow, FieldError, LoadingRows, OrganiserCard, PRIMARY_BUTTON, QUIET_BUTTON } from '../organiser-ui';
import { ADMISSION_COPY, ADMISSION_MODE_LABELS, modeUsesLists } from './admission-text';
import { useAdmissionOverview, useSetAdmissionMode } from './useAdmission';
import AdmissionEmailsPanel from './AdmissionEmailsPanel';
import AdmissionCodesPanel from './AdmissionCodesPanel';

const modeSchema = z.object({
  mode: z.enum(ADMISSION_MODES as [AdmissionMode, ...AdmissionMode[]], { errorMap: () => ({ message: ADMISSION_COPY.chooseMode }) }),
});
type ModeValues = z.infer<typeof modeSchema>;

export default function EventAdmissionCard({ sessionId, title }: { sessionId: string; title: string }) {
  const addToast = useToastStore((s) => s.addToast);
  const { ask, confirmDialog } = useConfirm();
  const overview = useAdmissionOverview(sessionId);
  const setMode = useSetAdmissionMode(sessionId);
  const legendId = useId();
  const errorId = useId();
  const current = overview.data?.mode ?? null;
  const form = useForm<ModeValues>({ resolver: formResolver(modeSchema) });
  const { reset } = form;
  // The saved mode is the form's starting point, and follows another organiser's change when this one has none pending.
  useEffect(() => {
    if (!form.formState.isDirty) reset(current ? { mode: current } : {});
  }, [current, reset]); // eslint-disable-line react-hooks/exhaustive-deps

  if (overview.isError && notForThisViewer(overview.error)) return null;

  const save = form.handleSubmit(({ mode }) => {
    setMode.mutate(mode, {
      onSuccess: () => { addToast(ADMISSION_COPY.saved, 'success'); reset({ mode }); },
      onError: (err) => form.setError('mode', { type: 'server', message: organiserSentence(err, ADMISSION_COPY.fallback) }),
    });
  });
  const clear = async () => {
    if (!(await ask({ title: ADMISSION_COPY.clearTitle, body: ADMISSION_COPY.clearBody, confirmLabel: ADMISSION_COPY.clear }))) return;
    setMode.mutate(null, {
      onSuccess: () => { addToast(ADMISSION_COPY.cleared, 'success'); reset({}); },
      onError: (err) => addToast(organiserSentence(err, ADMISSION_COPY.fallback), 'error'),
    });
  };
  const chosen = form.watch('mode');
  const error = form.formState.errors.mode?.message;
  const counts = overview.data?.counts;

  return (
    <OrganiserCard testId="event-admission-card" title={ADMISSION_COPY.title} hint={ADMISSION_COPY.hint}>
      {overview.isLoading && <LoadingRows label="Loading admission" rows={3} />}
      {overview.isError && <ErrorRow message={ADMISSION_COPY.error} onRetry={() => overview.refetch()} />}
      {overview.data && (
        <div className="space-y-5">
          <form onSubmit={save} noValidate className="space-y-3">
            <fieldset aria-labelledby={legendId} aria-describedby={error ? errorId : undefined}>
              <legend id={legendId} className="mb-2 text-sm font-medium text-gray-700">{ADMISSION_COPY.modeLegend}</legend>
              {!current && <p className="mb-2 text-sm text-gray-500">{ADMISSION_COPY.noMode}</p>}
              <div className="grid gap-2">
                {ADMISSION_MODES.map((mode) => (
                  <label
                    key={mode}
                    data-testid={`admission-mode-${mode}`}
                    className={cn(
                      'flex min-h-[44px] cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-sm transition-colors',
                      chosen === mode ? 'border-rsn-red bg-rsn-red/5 text-[#1a1a2e]' : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50',
                    )}
                  >
                    <input type="radio" value={mode} className="h-4 w-4 shrink-0 accent-rsn-red" {...form.register('mode')} />
                    <span className="min-w-0 [overflow-wrap:anywhere]">{ADMISSION_MODE_LABELS[mode]}</span>
                  </label>
                ))}
              </div>
              <FieldError id={errorId} message={error} />
            </fieldset>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="submit"
                data-testid="admission-save"
                disabled={setMode.isPending || !form.formState.isDirty}
                className={PRIMARY_BUTTON}
              >
                {ADMISSION_COPY.save}
              </button>
              {current && (
                <button type="button" onClick={() => void clear()} disabled={setMode.isPending} className={QUIET_BUTTON}>
                  {ADMISSION_COPY.clear}
                </button>
              )}
            </div>
          </form>
          {counts && current && (
            <p data-testid="admission-counts" className="text-sm text-gray-500">
              {counts.listed} allowed {counts.listed === 1 ? 'email' : 'emails'} ({counts.registered} with a place) · {counts.codesUnused} unused {counts.codesUnused === 1 ? 'code' : 'codes'}, {counts.codesUsed} used
            </p>
          )}
          {modeUsesLists(current) && (
            <>
              <AdmissionEmailsPanel sessionId={sessionId} />
              <AdmissionCodesPanel sessionId={sessionId} title={title} />
            </>
          )}
        </div>
      )}
      {confirmDialog}
    </OrganiserCard>
  );
}
