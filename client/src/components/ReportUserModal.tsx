// Task E4 — the member-facing report front door. Feeds POST /api/reports (server/src/routes/reports.ts), which lands
// in the admin moderation queue.
//
// 11 Nov 2026 (Shirley Palmer's item 16): it reports a member, or one message (a chat, a group chat or an event's chat),
// wall post or wall comment (`subject`), and says so in
// its title; the message or post is quoted at the top. Before anything is sent it says what happens next
// (safety-words.ts): who reviews it, what they can read, and that nothing changes for the other person, who is not told.
// No reason is chosen for the person: Submit waits for one. Once sent, the sheet says "Report sent" and stays until it
// is closed, with the person still in the conversation they reported from. "Also block" blocks after the report lands;
// the caller is told (onBlocked) and shows the thread read-only instead of leaving it. A report already sent in the last
// day is answered "You already reported this." in the same calm way.
//
// Body field names are exact matches of the server's zod schema (submitBodySchema in routes/reports.ts).
import { useState, useEffect, useId } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { ReportReason, ReportSubjectKind } from '@rsn/shared';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import api from '@/lib/api';
import { dropDraftsTo } from '@/features/messages/voice/composer-drafts';
import {
  ALREADY_REPORTED, CHOOSE_REASON, REASON_NEEDED, REPORT_SENT, blockConsequence, reportConsequence, reportSentLine,
  reportTitle, type ReportTarget,
} from './safety/safety-words';

export type { ReportReason } from '@rsn/shared';

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

/** One message or post being reported, with its words to quote at the top. */
export interface ReportSubject {
  kind: ReportSubjectKind;
  id: string;
  excerpt?: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** The member reported: the person, or the author of the message or post. The entry points are never drawn for the
   *  viewer's own profile, messages or posts; the server refuses those too. */
  reportedId: string;
  reportedDisplayName?: string | null;
  /** When reporting from a chat, the conversation — admins can then review the messages behind the report. */
  conversationId?: string;
  /** A message or post rather than the member alone. */
  subject?: ReportSubject | null;
  /** The viewer already blocked them: no "Also block". */
  alreadyBlocked?: boolean;
  /** Fired after the reporter also chose to block, so the screen can show it (it never leaves the conversation). */
  onBlocked?: () => void;
}

interface FailedRequest { response?: { status?: number; data?: { error?: { message?: unknown } } } }

const TARGETS: Record<ReportSubjectKind, ReportTarget> = {
  dm_message: 'message', group_message: 'message', event_chat_message: 'message',
  pod_post: 'post', circle_post: 'post', pod_comment: 'comment', circle_comment: 'comment',
};
const targetOf = (subject: ReportSubject | null | undefined): ReportTarget => (subject ? TARGETS[subject.kind] : 'member');

export default function ReportUserModal({ open, onClose, reportedId, reportedDisplayName, conversationId, subject, alreadyBlocked, onBlocked }: Props) {
  const [reason, setReason] = useState<ReportReason | ''>('');
  const [description, setDescription] = useState('');
  const [alsoBlock, setAlsoBlock] = useState(false);
  const [outcome, setOutcome] = useState<null | { already: boolean; blocked: boolean }>(null);
  const [tried, setTried] = useState(false);
  const hintId = useId();
  const target = targetOf(subject);
  const name = reportedDisplayName;

  const mutation = useMutation({
    mutationFn: async () => {
      if (!reason) throw new Error(REASON_NEEDED);
      let already = false;
      try {
        await api.post('/reports', {
          reportedId,
          reason,
          description: description.trim() || undefined,
          conversationId,
          ...(subject ? { subject: { kind: subject.kind, id: subject.id } } : {}),
        });
      } catch (err) {
        // The same report in the last day: said calmly, and an "Also block" still goes.
        if ((err as FailedRequest)?.response?.status !== 409) throw err;
        already = true;
      }
      // Reporting and blocking are separate actions server-side; when the reporter asks to block too, do it right
      // after the report.
      if (alsoBlock) {
        await api.post(`/users/${reportedId}/block`, { reason: `Reported: ${reason}` });
        // Nothing can be sent to them now: an unsent message to them is dropped (11 Nov 2026).
        dropDraftsTo(reportedId);
      }
      return { already, blocked: alsoBlock };
    },
    onSuccess: (result) => {
      setOutcome(result);
      if (result.blocked) onBlocked?.();
    },
  });

  // Fresh form state every time the modal is (re)opened: no reason chosen for the person.
  useEffect(() => {
    if (open) {
      setReason('');
      setDescription('');
      setAlsoBlock(false);
      setOutcome(null);
      setTried(false);
      mutation.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when it opens, not on every mutation change
  }, [open]);

  const submit = () => {
    setTried(true);
    if (!reason || mutation.isPending) return;
    mutation.mutate();
  };

  const failure = mutation.isError
    ? (mutation.error as FailedRequest)?.response?.data?.error?.message
    : null;

  return (
    <Modal open={open} onClose={onClose} title={outcome ? (outcome.already ? ALREADY_REPORTED : REPORT_SENT) : reportTitle(target, name)}>
      {outcome ? (
        <div className="py-2" data-testid="report-done">
          <p className="text-sm text-gray-700" role="status">
            {outcome.already ? `Our team already has it.${outcome.blocked ? ` You also blocked ${name?.trim() || 'this member'}.` : ''}` : reportSentLine(name, outcome.blocked)}
          </p>
          <div className="mt-4 flex justify-end">
            <Button className="min-h-[44px]" onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={(e) => { e.preventDefault(); submit(); }}
          className="space-y-4"
          data-testid="report-form"
        >
          {subject?.excerpt && (
            <blockquote className="max-h-32 overflow-y-auto rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 whitespace-pre-wrap [overflow-wrap:anywhere]" data-testid="report-quote">
              {subject.excerpt}
            </blockquote>
          )}
          <p className="text-xs text-gray-600" data-testid="report-consequence">
            {reportConsequence(target, name, !!conversationId)}
          </p>

          <div>
            <label htmlFor="report-reason" className="block text-sm font-medium text-gray-600 mb-1.5">
              Reason
            </label>
            <select
              id="report-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value as ReportReason)}
              aria-describedby={!reason ? hintId : undefined}
              aria-invalid={tried && !reason ? true : undefined}
              className={fieldClass}
            >
              <option value="" disabled>{CHOOSE_REASON}</option>
              {REPORT_REASONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
            {!reason && (
              <p id={hintId} className={`mt-1.5 text-xs ${tried ? 'text-red-600' : 'text-gray-500'}`}>{REASON_NEEDED}</p>
            )}
          </div>

          <div>
            <label htmlFor="report-details" className="block text-sm font-medium text-gray-600 mb-1.5">
              Details (optional)
            </label>
            <textarea
              id="report-details"
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, 2000))}
              rows={3}
              placeholder="Anything that helps our team understand what happened"
              className={`${fieldClass} resize-none`}
            />
          </div>

          {!alreadyBlocked && (
            <label className="flex items-start gap-2.5 cursor-pointer rounded-xl border border-gray-200 bg-gray-50 p-3 min-h-[44px]">
              <input
                type="checkbox"
                checked={alsoBlock}
                onChange={(e) => setAlsoBlock(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-gray-300 text-rsn-red focus:ring-rsn-red"
              />
              <span className="text-sm text-gray-700">
                Also block {name?.trim() || 'this member'}
                <span className="block text-xs text-gray-500">{blockConsequence(name, conversationId ? 'thread' : 'profile')}</span>
              </span>
            </label>
          )}

          {mutation.isError && (
            <p className="text-sm text-red-600" role="alert">
              {typeof failure === 'string' && failure ? failure : 'We could not send your report. Please try again.'}
            </p>
          )}

          <div className="flex gap-3 justify-end pt-2">
            <Button type="button" variant="ghost" onClick={onClose} className="min-h-[44px]">
              Cancel
            </Button>
            <Button type="submit" isLoading={mutation.isPending} disabled={!reason} className="min-h-[44px]">
              Send report
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
