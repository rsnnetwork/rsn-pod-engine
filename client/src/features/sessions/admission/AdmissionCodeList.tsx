// ─── The admission codes made so far: last four symbols, what became of each, Revoke (Part 2 Task 11) ───────────────
import { Ban } from 'lucide-react';
import { useConfirm } from '@/hooks/useConfirm';
import { cn } from '@/lib/utils';
import { useToastStore } from '@/stores/toastStore';
import { organiserSentence } from '../organiser-errors';
import { EmptyRow, ErrorRow, LoadingRows } from '../organiser-ui';
import { ADMISSION_COPY, CODE_STATUS_LABELS } from './admission-text';
import { useAdmissionCodes, useRevokeAdmissionCode } from './useAdmission';

const STATUS_LOOK = {
  unused: 'bg-blue-50 text-blue-700',
  used: 'bg-emerald-50 text-emerald-700',
  revoked: 'bg-red-50 text-red-600',
  expired: 'bg-gray-100 text-gray-500',
} as const;

export default function AdmissionCodeList({ sessionId }: { sessionId: string }) {
  const addToast = useToastStore((s) => s.addToast);
  const { ask, confirmDialog } = useConfirm();
  const codes = useAdmissionCodes(sessionId);
  const revoke = useRevokeAdmissionCode(sessionId);
  const rows = codes.data ?? [];

  const revokeCode = async (codeId: string) => {
    if (!(await ask({ title: ADMISSION_COPY.revokeTitle, body: ADMISSION_COPY.revokeBody, confirmLabel: ADMISSION_COPY.revoke, tone: 'danger' }))) return;
    revoke.mutate(codeId, {
      onSuccess: () => addToast(ADMISSION_COPY.revoked, 'success'),
      onError: (err) => addToast(organiserSentence(err, ADMISSION_COPY.fallback), 'error'),
    });
  };

  return (
    <div className="min-w-0">
      {codes.isLoading && <LoadingRows label="Loading the admission codes" />}
      {codes.isError && <ErrorRow message={ADMISSION_COPY.codesError} onRetry={() => codes.refetch()} />}
      {!codes.isLoading && !codes.isError && rows.length === 0 && <EmptyRow testId="admission-codes-empty">{ADMISSION_COPY.codesEmpty}</EmptyRow>}
      {rows.length > 0 && (
        <ul data-testid="admission-code-list" className="max-h-96 divide-y divide-gray-100 overflow-y-auto rounded-xl border border-gray-200">
          {rows.map((row) => (
            <li key={row.id} data-testid="admission-code-row" className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <div className="min-w-0 flex-1 basis-40">
                <p className="font-mono text-sm text-[#1a1a2e]">•••• •••• {row.last4}</p>
                {(row.label || row.redeemedBy) && (
                  <p className="text-xs text-gray-500 [overflow-wrap:anywhere]">
                    {[row.label, row.redeemedBy ? `Used by ${row.redeemedBy.displayName}` : null].filter(Boolean).join(' · ')}
                  </p>
                )}
              </div>
              <span className={cn('rounded-full px-2.5 py-0.5 text-xs font-medium', STATUS_LOOK[row.status])}>{CODE_STATUS_LABELS[row.status]}</span>
              {(row.status === 'unused' || row.status === 'used') && (
                <button
                  type="button"
                  onClick={() => void revokeCode(row.id)}
                  disabled={revoke.isPending}
                  aria-label={`${ADMISSION_COPY.revoke} the code ending ${row.last4}`}
                  className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded-xl px-2 text-sm text-gray-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-60"
                >
                  <Ban className="h-4 w-4" aria-hidden="true" />
                  <span className="hidden sm:inline">{ADMISSION_COPY.revoke}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {confirmDialog}
    </div>
  );
}
