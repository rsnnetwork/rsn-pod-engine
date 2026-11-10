// ─── Admission codes: make them, keep them once, see what became of them (Part 2 Task 11; spec 04, 11) ──────────────
// A code's text is in the answer that made it and nowhere else, ever (the server keeps a keyed hash). So the freshly
// made codes stay on screen, with the once-only sentence, Download CSV and Copy all, until the organiser says they have
// saved them. The list below shows each code's last four symbols only, with Revoke (asked first).
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Check, Copy, Download, Loader2, AlertTriangle } from 'lucide-react';
import type { GeneratedAdmissionCode } from '@rsn/shared';
import { formResolver } from '@/lib/form-resolver';
import { cn } from '@/lib/utils';
import { useToastStore } from '@/stores/toastStore';
import { organiserSentence } from '../organiser-errors';
import { FIELD, FieldError, LABEL, PRIMARY_BUTTON, QUIET_BUTTON, fieldBorder } from '../organiser-ui';
import { ADMISSION_COPY, codesCsv, codesFileName, codesText } from './admission-text';
import { useGenerateAdmissionCodes } from './useAdmission';
import AdmissionCodeList from './AdmissionCodeList';

const codesSchema = z.object({
  count: z.coerce.number({ invalid_type_error: ADMISSION_COPY.countRange }).int(ADMISSION_COPY.countRange)
    .min(1, ADMISSION_COPY.countRange).max(500, ADMISSION_COPY.countRange),
  label: z.string().trim().max(80, 'Keep the label to 80 characters.'),
});
type CodesValues = z.infer<typeof codesSchema>;

function download(text: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function AdmissionCodesPanel({ sessionId, title }: { sessionId: string; title: string }) {
  const addToast = useToastStore((s) => s.addToast);
  const generate = useGenerateAdmissionCodes(sessionId);
  const countId = useId();
  const labelId = useId();
  const [made, setMade] = useState<{ codes: GeneratedAdmissionCode[]; label: string | null } | null>(null);
  const [copied, setCopied] = useState(false);
  const form = useForm<CodesValues>({ defaultValues: { count: 10, label: '' }, resolver: formResolver(codesSchema) });

  const submit = form.handleSubmit(({ count, label }) => {
    generate.mutate({ count, ...(label ? { label } : {}) }, {
      onSuccess: (codes) => { setMade({ codes, label: label || null }); setCopied(false); },
      onError: (err) => form.setError('count', { type: 'server', message: organiserSentence(err, ADMISSION_COPY.fallback) }),
    });
  });

  const copyAll = async () => {
    if (!made) return;
    try {
      await navigator.clipboard.writeText(codesText(made.codes));
      setCopied(true);
    } catch {
      addToast(ADMISSION_COPY.copyFailed, 'error');
    }
  };

  const countError = form.formState.errors.count?.message;
  const labelError = form.formState.errors.label?.message;
  return (
    <section data-testid="admission-codes" className="min-w-0 space-y-3 border-t border-gray-100 pt-4">
      <div>
        <h3 className="text-base font-semibold text-[#1a1a2e]">{ADMISSION_COPY.codesTitle}</h3>
        <p className="text-sm text-gray-500">{ADMISSION_COPY.codesHint}</p>
      </div>
      <form onSubmit={submit} noValidate className="grid gap-3 sm:grid-cols-[minmax(0,8rem)_minmax(0,1fr)_auto] sm:items-end">
        <div className="min-w-0">
          <label htmlFor={countId} className={LABEL}>{ADMISSION_COPY.howMany}</label>
          <input
            id={countId}
            data-testid="admission-code-count"
            type="number"
            inputMode="numeric"
            min={1}
            max={500}
            aria-invalid={!!countError || undefined}
            className={cn(FIELD, fieldBorder(countError))}
            {...form.register('count')}
          />
        </div>
        <div className="min-w-0">
          <label htmlFor={labelId} className={LABEL}>{ADMISSION_COPY.label}</label>
          <input id={labelId} placeholder={ADMISSION_COPY.labelPlaceholder} maxLength={80} className={cn(FIELD, fieldBorder(labelError))} {...form.register('label')} />
        </div>
        <button type="submit" data-testid="admission-code-generate" disabled={generate.isPending} className={PRIMARY_BUTTON}>
          {generate.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {ADMISSION_COPY.generate}
        </button>
        <div className="sm:col-span-3">
          <FieldError message={countError ?? labelError} />
        </div>
      </form>

      {made && (
        <div data-testid="admission-codes-made" className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-3">
          <p className="flex items-start gap-2 text-sm font-medium text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span data-testid="admission-codes-once">{ADMISSION_COPY.onceOnly}</span>
          </p>
          <ul className="grid max-h-60 grid-cols-1 gap-1 overflow-y-auto rounded-lg bg-white p-2 font-mono text-sm min-[420px]:grid-cols-2">
            {made.codes.map((c) => <li key={c.id} data-testid="admission-code-plain" className="select-all px-1 py-0.5 tracking-wide">{c.code}</li>)}
          </ul>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => download(codesCsv(made.codes, made.label), codesFileName(title))} className={QUIET_BUTTON}>
              <Download className="h-4 w-4" aria-hidden="true" /> {ADMISSION_COPY.downloadCsv}
            </button>
            <button type="button" onClick={() => void copyAll()} className={QUIET_BUTTON}>
              {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
              <span aria-live="polite">{copied ? ADMISSION_COPY.copied : ADMISSION_COPY.copyAll}</span>
            </button>
            <button type="button" onClick={() => setMade(null)} className={PRIMARY_BUTTON}>{ADMISSION_COPY.done}</button>
          </div>
        </div>
      )}

      <AdmissionCodeList sessionId={sessionId} />
    </section>
  );
}
