// Task E4 — the member-facing report front door. Feeds the existing, richer
// POST /api/reports backend (server/src/routes/reports.ts), which previously
// had no client caller: reports were reachable only by direct DB insert, so
// they never reached the admin moderation queue (E3's inspector reads the
// user_reports ∪ violations union). This modal is the missing "send" button.
//
// Body field names are exact matches of the server's zod schema
// (submitBodySchema in routes/reports.ts): { reportedId, reason, description }.
// Note the field is `description`, NOT `details` — verified against the
// schema before wiring this up.
import { useState, useEffect } from 'react';
import { useMutation } from '@tanstack/react-query';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import api from '@/lib/api';

export type ReportReason =
  | 'spam' | 'harassment' | 'inappropriate_content'
  | 'fake_profile' | 'safety' | 'other';

// Matches server's VALID_REASONS (report.service.ts) exactly.
const REPORT_REASONS: ReadonlyArray<{ value: ReportReason; label: string }> = [
  { value: 'spam', label: 'Spam' },
  { value: 'harassment', label: 'Harassment' },
  { value: 'inappropriate_content', label: 'Inappropriate content' },
  { value: 'fake_profile', label: 'Fake profile' },
  { value: 'safety', label: 'Safety concern' },
  { value: 'other', label: 'Other' },
];

const fieldClass = 'w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-[#1a1a2e] transition-all duration-200 min-h-[44px]';

interface Props {
  open: boolean;
  onClose: () => void;
  /** The user being reported. Callers are responsible for never rendering
   *  the entry point that opens this modal on the current user's own
   *  profile/conversation — self-reports are also rejected server-side
   *  (report.service.ts throws if reporterId === reportedId), but the UI
   *  should never let a member reach that error in the first place. */
  reportedId: string;
  reportedDisplayName?: string | null;
}

export default function ReportUserModal({ open, onClose, reportedId, reportedDisplayName }: Props) {
  const [reason, setReason] = useState<ReportReason>('spam');
  const [description, setDescription] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const mutation = useMutation({
    mutationFn: () => api.post('/reports', {
      reportedId,
      reason,
      description: description.trim() || undefined,
    }),
    onSuccess: () => setSubmitted(true),
  });

  // Fresh form state every time the modal is (re)opened.
  useEffect(() => {
    if (open) {
      setReason('spam');
      setDescription('');
      setSubmitted(false);
      mutation.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} title={submitted ? 'Report submitted' : `Report ${reportedDisplayName || 'this member'}`}>
      {submitted ? (
        <div className="text-center py-4">
          <p className="text-sm text-gray-700">Thanks. Our team will review this.</p>
          <Button className="mt-4 min-h-[44px]" onClick={onClose}>Done</Button>
        </div>
      ) : (
        <form
          onSubmit={(e) => { e.preventDefault(); mutation.mutate(); }}
          className="space-y-4"
        >
          <p className="text-xs text-gray-500">
            Your report goes to our moderation team. The person you're reporting won't be notified.
          </p>

          <div>
            <label htmlFor="report-reason" className="block text-sm font-medium text-gray-600 mb-1.5">
              Reason
            </label>
            <select
              id="report-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value as ReportReason)}
              className={fieldClass}
            >
              {REPORT_REASONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="report-details" className="block text-sm font-medium text-gray-600 mb-1.5">
              Details (optional)
            </label>
            <textarea
              id="report-details"
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, 2000))}
              rows={4}
              placeholder="Anything that helps our team understand what happened"
              className={`${fieldClass} resize-none`}
            />
          </div>

          {mutation.isError && (
            <p className="text-sm text-red-500">
              {(mutation.error as any)?.response?.data?.error?.message || 'Failed to submit report. Please try again.'}
            </p>
          )}

          <div className="flex gap-3 justify-end pt-2">
            <Button type="button" variant="ghost" onClick={onClose} className="min-h-[44px]">
              Cancel
            </Button>
            <Button type="submit" isLoading={mutation.isPending} className="min-h-[44px]">
              Submit report
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
