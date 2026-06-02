import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import {
  useBroadcastEligibility,
  usePostEventMessageStatus,
  usePostEventMessagePreview,
  useSendPostEventMessages,
} from './usePostEventMessage';
import type { PostEventMessageBucket } from '@rsn/shared';

const BUCKET_LABELS: Record<PostEventMessageBucket, string> = {
  stayed: 'Stayed to the end',
  left_early: 'Left partway through',
  could_not_join: "Couldn't get into the conversations",
  no_show: "Didn't get to take part",
};

interface Props {
  sessionId: string;
}

export default function MessageParticipantsButton({ sessionId }: Props) {
  const [modalOpen, setModalOpen] = useState(false);

  const { data: elig, isLoading: eligLoading } = useBroadcastEligibility(sessionId);
  const { data: job } = usePostEventMessageStatus(sessionId);
  const { data: preview, isLoading: previewLoading } = usePostEventMessagePreview(sessionId, modalOpen);
  const sendMutation = useSendPostEventMessages(sessionId);

  // Don't render until eligibility resolves
  if (eligLoading || !elig) return null;

  // Not visible to this user at all
  if (!elig.visible) return null;

  // Coming-soon state: visible but not enabled
  if (!elig.enabled) {
    return (
      <Button
        variant="secondary"
        size="sm"
        disabled
        title="Pro — coming soon"
      >
        Message all participants
      </Button>
    );
  }

  // Active in-flight job
  if (job?.status === 'pending' || job?.status === 'processing') {
    return (
      <Button variant="secondary" size="sm" disabled>
        Sending… {job.sentCount}/{job.totalRecipients}
      </Button>
    );
  }

  // Completed job (with or without errors): show as soft button that still opens the modal
  if (job?.status === 'completed' || job?.status === 'completed_with_errors') {
    const sentDate = new Date(job.completedAt ?? job.createdAt).toLocaleDateString();
    return (
      <>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setModalOpen(true)}
          title="Messages were sent — click to re-send to anyone newly missed"
        >
          Sent on {sentDate}
        </Button>
        <ConfirmModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          preview={preview ?? null}
          previewLoading={previewLoading}
          isSending={sendMutation.isPending}
          onConfirm={() => {
            sendMutation.mutate(undefined, { onSuccess: () => setModalOpen(false) });
          }}
        />
      </>
    );
  }

  // No job yet — primary enabled state
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setModalOpen(true)}>
        Message all participants
      </Button>
      <ConfirmModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        preview={preview ?? null}
        previewLoading={previewLoading}
        isSending={sendMutation.isPending}
        onConfirm={() => {
          sendMutation.mutate(undefined, { onSuccess: () => setModalOpen(false) });
        }}
      />
    </>
  );
}

// ─── Confirm modal ─────────────────────────────────────────────────────────────

interface ConfirmModalProps {
  open: boolean;
  onClose: () => void;
  preview: import('@rsn/shared').PostEventMessagePreview | null;
  previewLoading: boolean;
  isSending: boolean;
  onConfirm: () => void;
}

function ConfirmModal({ open, onClose, preview, previewLoading, isSending, onConfirm }: ConfirmModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Message all participants">
      <div className="space-y-4">
        {previewLoading || !preview ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : (
          <>
            <p className="text-sm text-gray-700">
              This will send a private message to{' '}
              <span className="font-semibold text-[#1a1a2e]">{preview.totalRecipients}</span>{' '}
              {preview.totalRecipients === 1 ? 'participant' : 'participants'}:
            </p>
            <ul className="space-y-1">
              {preview.buckets.map(({ bucket, count }) => (
                <li key={bucket} className="flex justify-between text-sm text-gray-600">
                  <span>{BUCKET_LABELS[bucket]}</span>
                  <span className="font-medium text-[#1a1a2e]">{count}</span>
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={isSending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            isLoading={isSending}
            disabled={previewLoading || !preview || isSending}
            onClick={onConfirm}
          >
            Send messages
          </Button>
        </div>
      </div>
    </Modal>
  );
}
