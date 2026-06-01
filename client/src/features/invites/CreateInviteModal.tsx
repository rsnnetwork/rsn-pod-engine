import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import Modal from '@/components/ui/Modal';
import Input from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useToastStore } from '@/stores/toastStore';
import { Copy, Send, Link } from 'lucide-react';
import api from '@/lib/api';

interface Props { open: boolean; onClose: () => void; }

interface FormData { type: string; podId: string; sessionId: string; inviteeEmail: string; maxUses: number; }

/** Map API error codes to user-friendly messages */
function getInviteErrorMessage(err: any): string {
  const code = err?.response?.data?.error?.code;
  const message = err?.response?.data?.error?.message;

  switch (code) {
    case 'DUPLICATE_INVITE':
      return 'This person already has a pending invite to this event';
    case 'SELF_INVITE':
      return 'You cannot send an invite to yourself';
    case 'ALREADY_REGISTERED':
      return 'This person already has an account on the platform';
    case 'POD_MEMBER_EXISTS':
      return 'This person is already a member of this pod';
    case 'SESSION_ALREADY_REGISTERED':
      return 'This person is already a participant of this event';
    case 'POD_ARCHIVED':
      return 'Cannot send invites to an archived pod';
    case 'AUTH_FORBIDDEN':
      return message || 'You do not have permission to send this invite';
    case 'VALIDATION_ERROR':
      return message || 'Please check the form and try again';
    case 'RATE_LIMIT_EXCEEDED':
      return 'Too many invites sent. Please wait a moment and try again';
    default:
      return message || 'Failed to send invite. Please try again';
  }
}

export default function CreateInviteModal({ open, onClose }: Props) {
  const qc = useQueryClient();
  const { addToast } = useToastStore();
  const [generatedLink, setGeneratedLink] = useState<string | null>(null);
  const { data: pods } = useQuery({ queryKey: ['my-pods'], queryFn: () => api.get('/pods').then(r => r.data.data ?? []) });
  const { data: sessions } = useQuery({ queryKey: ['my-sessions'], queryFn: () => api.get('/sessions').then(r => r.data.data ?? []) });
  const { register, handleSubmit, reset, control, getValues, formState: { errors } } = useForm<FormData>({
    defaultValues: { type: 'pod', maxUses: 10 }
  });
  const inviteType = useWatch({ control, name: 'type' });
  const emailValue = useWatch({ control, name: 'inviteeEmail' });

  const handleClose = () => {
    setGeneratedLink(null);
    reset();
    onClose();
  };

  // Send invite directly to an email (single-use, unique per email)
  const sendEmailMutation = useMutation({
    mutationFn: (data: FormData) => {
      const payload: any = { type: data.type, maxUses: 1, inviteeEmail: data.inviteeEmail };
      if (data.type === 'pod' && data.podId) payload.podId = data.podId;
      if (data.type === 'session' && data.sessionId) payload.sessionId = data.sessionId;
      return api.post('/invites', payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-invites'] });
      addToast('Invite sent to email!', 'success');
      handleClose();
    },
    onError: (err: any) => addToast(getInviteErrorMessage(err), 'error'),
  });

  // Create a shareable invite link (multi-use)
  const createLinkMutation = useMutation({
    mutationFn: (data: FormData) => {
      const payload: any = { type: data.type, maxUses: data.maxUses || 10 };
      if (data.type === 'pod' && data.podId) payload.podId = data.podId;
      if (data.type === 'session' && data.sessionId) payload.sessionId = data.sessionId;
      return api.post('/invites', payload);
    },
    onSuccess: async (res) => {
      qc.invalidateQueries({ queryKey: ['my-invites'] });
      const code = res.data.data?.code;
      const link = `${window.location.origin}/invite/${code}`;
      setGeneratedLink(link);
      try {
        await navigator.clipboard.writeText(link);
        addToast('Invite link created and copied!', 'success');
      } catch {
        addToast('Invite link created — copy it below', 'success');
      }
    },
    onError: (err: any) => addToast(getInviteErrorMessage(err), 'error'),
  });

  const onSendEmail = handleSubmit((data) => sendEmailMutation.mutate(data));
  const onCreateLink = () => {
    const data = getValues();
    createLinkMutation.mutate(data);
  };

  const copyLink = async () => {
    if (!generatedLink) return;
    try {
      await navigator.clipboard.writeText(generatedLink);
      addToast('Link copied!', 'success');
    } catch {
      addToast('Failed to copy', 'error');
    }
  };

  return (
    <Modal open={open} onClose={handleClose} title="Create Invite">
      <form onSubmit={onSendEmail} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-600 mb-1.5">Invite Type</label>
          <select
            {...register('type', { required: 'Select a type' })}
            className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-[#1a1a2e]"
          >
            <option value="pod">Pod Invite</option>
            <option value="session">Event Invite</option>
            <option value="platform">Platform Invite</option>
          </select>
        </div>
        {inviteType === 'pod' && (
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1.5">Pod</label>
            <select
              {...register('podId', { required: inviteType === 'pod' ? 'Select a pod' : false })}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-[#1a1a2e]"
            >
              <option value="">Select pod</option>
              {(pods || []).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {errors.podId && <p className="text-xs text-red-400 mt-1">{errors.podId.message}</p>}
          </div>
        )}
        {inviteType === 'session' && (
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1.5">Event</label>
            <select
              {...register('sessionId', { required: inviteType === 'session' ? 'Select an event' : false })}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-[#1a1a2e]"
            >
              <option value="">Select event</option>
              {(sessions || []).map((s: any) => <option key={s.id} value={s.id}>{s.title}</option>)}
            </select>
            {errors.sessionId && <p className="text-xs text-red-400 mt-1">{errors.sessionId.message}</p>}
          </div>
        )}

        {/* Divider: two invite options */}
        <div className="border-t border-gray-100 pt-4 space-y-4">
          {/* Option 1: Send to email */}
          <div className="rounded-xl border border-gray-200 p-4 space-y-3">
            <p className="text-sm font-medium text-gray-700 flex items-center gap-2"><Send className="h-4 w-4 text-rsn-red" /> Send invite to email</p>
            <p className="text-xs text-gray-400">A unique, single-use invite link will be emailed directly.</p>
            <Input type="email" {...register('inviteeEmail')} placeholder="someone@example.com" />
            <Button
              type="submit"
              size="sm"
              isLoading={sendEmailMutation.isPending}
              disabled={!emailValue}
              className="w-full"
            >
              <Send className="h-4 w-4 mr-1" /> Send Invite Email
            </Button>
          </div>

          {/* Option 2: Create shareable link */}
          <div className="rounded-xl border border-gray-200 p-4 space-y-3">
            <p className="text-sm font-medium text-gray-700 flex items-center gap-2"><Link className="h-4 w-4 text-emerald-500" /> Create shareable link</p>
            <p className="text-xs text-gray-400">A multi-use invite link you can share manually.</p>
            <Input
              label="Max Uses"
              type="number"
              min={1}
              {...register('maxUses', {
                valueAsNumber: true,
                min: { value: 1, message: 'Must be 1 or greater' },
              })}
              placeholder="10"
              error={errors.maxUses?.message}
            />
            <Button
              type="button"
              size="sm"
              variant="secondary"
              isLoading={createLinkMutation.isPending}
              onClick={onCreateLink}
              className="w-full"
            >
              <Copy className="h-4 w-4 mr-1" /> Create & Copy Link
            </Button>
            {generatedLink && (
              <div className="flex items-center gap-2 mt-2">
                <input
                  readOnly
                  value={generatedLink}
                  className="flex-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600 truncate"
                />
                <button type="button" onClick={copyLink} className="text-rsn-red hover:text-rsn-red-hover p-1">
                  <Copy className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end pt-2">
          <Button variant="ghost" type="button" onClick={handleClose}>Close</Button>
        </div>
      </form>
    </Modal>
  );
}
